import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import prisma from './prisma';

/**
 * Firebase Admin SDK — the SEND side of push notifications. The mobile app
 * (Dad-mobile) already fully implements the RECEIVE side (permission
 * request, FCM token registration via `POST /api/users/device-token`,
 * foreground/background handlers, tap-to-deep-link) but until this file,
 * nothing on the backend ever actually called Firebase to send anything —
 * `NotificationService.send()` only wrote a DB row, emitted a Socket.IO
 * event nothing here listens to, and emailed high-priority types. Every
 * `User.fcmToken` collected was write-only.
 *
 * Configuration: set `FIREBASE_SERVICE_ACCOUNT_JSON` to the full JSON
 * contents of a Firebase service account key (Firebase Console -> Project
 * Settings -> Service Accounts -> Generate new private key), as a single-
 * line string. Deliberately NOT required at boot — a fresh/local/staging
 * environment without this configured must keep working exactly as before
 * (in-app + email notifications), just without push. Every function here
 * degrades to a no-op (logged once, not per-call) rather than throwing when
 * unconfigured, so this is safe to ship before the real credential exists.
 */

let app: App | null = null;
let warnedUnconfigured = false;
let warnedInitError = false;

function getApp(): App | null {
    if (app) return app;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
        if (!warnedUnconfigured) {
            console.warn(
                '[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON is not set — push notifications are disabled. ' +
                'In-app notifications and email fallback are unaffected.'
            );
            warnedUnconfigured = true;
        }
        return null;
    }

    try {
        const serviceAccount = JSON.parse(raw);
        app = initializeApp({
            credential: cert(serviceAccount)
        });
        console.log('[firebaseAdmin] Initialized (project: ' + serviceAccount.project_id + ')');
        return app;
    } catch (error) {
        if (!warnedInitError) {
            console.error('[firebaseAdmin] Failed to initialize — push notifications disabled:', error);
            warnedInitError = true;
        }
        return null;
    }
}

export interface PushPayload {
    title: string;
    body: string;
    /** String-only, per FCM's `data` field requirement — matches what
     * `PushNotificationsController._decodePayload`/`onMessageOpenedApp` on
     * the mobile side already expects (`relatedResource`/`relatedId`). */
    data?: Record<string, string>;
}

export interface PushResult {
    ok: boolean;
    /** FCM error code, or `fcm_not_configured` when Firebase credentials are missing. */
    errorCode?: string;
    errorMessage?: string;
    /** FCM message id on success. */
    messageId?: string;
    latencyMs: number;
    /** True when FCM says the token itself is dead (uninstalled app / stale token). */
    invalidToken?: boolean;
}

/** Whether Firebase credentials are present and initialised (used by the audit panel). */
export function isPushConfigured(): boolean {
    return getApp() !== null;
}

const INVALID_TOKEN_CODES = new Set([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered'
]);

/**
 * Low-level send: one FCM message to one token, never throws, no side effects on the DB.
 * `dryRun` asks FCM to validate the message and token without delivering anything.
 */
export async function deliverPush(
    fcmToken: string,
    payload: PushPayload,
    opts: { dryRun?: boolean } = {}
): Promise<PushResult> {
    const started = Date.now();
    const firebaseApp = getApp();
    if (!firebaseApp) {
        return { ok: false, errorCode: 'fcm_not_configured', errorMessage: 'FIREBASE_SERVICE_ACCOUNT_JSON is not set or invalid', latencyMs: 0 };
    }

    try {
        const messageId = await getMessaging(firebaseApp).send(
            {
                token: fcmToken,
                notification: { title: payload.title, body: payload.body },
                data: payload.data,
                android: { priority: 'high' }
            },
            opts.dryRun === true
        );
        return { ok: true, messageId, latencyMs: Date.now() - started };
    } catch (error: any) {
        const code = (error?.code as string | undefined) || 'unknown';
        return {
            ok: false,
            errorCode: code,
            errorMessage: String(error?.message || error).slice(0, 500),
            latencyMs: Date.now() - started,
            invalidToken: INVALID_TOKEN_CODES.has(code)
        };
    }
}

/**
 * Sends one push notification and returns the detailed outcome. Never throws - callers must
 * never let a push failure roll back or interrupt the DB write / socket emit / email that
 * already succeeded.
 *
 * When FCM reports the token itself is invalid (unregistered/not-found - the normal outcome of
 * an uninstalled app or a stale token), the stale token is removed from `User.fcmToken` and
 * `UserDevice` so this doesn't keep failing silently on every future notification.
 */
export async function sendPushNotification(
    userId: string,
    fcmToken: string,
    payload: PushPayload
): Promise<PushResult> {
    const result = await deliverPush(fcmToken, payload);

    if (!result.ok) {
        if (result.invalidToken) {
            try {
                await prisma.user.updateMany({
                    where: { id: userId, fcmToken },
                    data: { fcmToken: null, fcmTokenUpdatedAt: null }
                });
                await prisma.userDevice.deleteMany({ where: { token: fcmToken } });
            } catch (cleanupError) {
                console.error('[firebaseAdmin] Failed to clear stale fcmToken:', cleanupError);
            }
        } else {
            console.error(`[firebaseAdmin] Push send failed for user ${userId}: ${result.errorCode} ${result.errorMessage}`);
        }
    }
    return result;
}
