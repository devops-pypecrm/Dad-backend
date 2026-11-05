import prisma from '../config/prisma';

export type PushLogStatus = 'sent' | 'failed' | 'skipped';

export interface PushLogEntry {
    userId: string;
    organisationId?: string | null;
    notificationId?: string | null;
    title: string;
    type?: string;
    source?: 'notification' | 'test' | 'validate';
    token?: string | null;
    platform?: string | null;
    status: PushLogStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    messageId?: string | null;
    latencyMs?: number | null;
}

/** Last 10 chars of a token - enough to correlate with a device row, useless for sending. */
export const tokenSuffix = (token?: string | null) => (token ? token.slice(-10) : null);

/**
 * Persists push-delivery outcomes for the Notification Audit panel. Best-effort by design:
 * auditing must never break or delay the notification flow it observes, so every failure is
 * swallowed (and logged once to the console).
 */
export async function recordPushLogs(entries: PushLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
        await prisma.pushDeliveryLog.createMany({
            data: entries.map((e) => ({
                userId: e.userId,
                organisationId: e.organisationId ?? null,
                notificationId: e.notificationId ?? null,
                title: e.title.slice(0, 200),
                type: e.type ?? 'info',
                source: e.source ?? 'notification',
                tokenSuffix: tokenSuffix(e.token),
                platform: e.platform ?? null,
                status: e.status,
                errorCode: e.errorCode ?? null,
                errorMessage: e.errorMessage ? e.errorMessage.slice(0, 500) : null,
                messageId: e.messageId ?? null,
                latencyMs: e.latencyMs ?? null,
            })),
        });
    } catch (error) {
        console.error('[pushAudit] Failed to record push log:', (error as Error).message);
    }
}
