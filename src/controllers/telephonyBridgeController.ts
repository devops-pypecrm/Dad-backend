import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import twilio from 'twilio';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { synchronizeDurations } from '../utils/callUtils';
import { resolveBridgeConfigForOrg, findAgentByPhone, isBridgeNumber } from '../services/telephonyBridgeService';

const VoiceResponse = twilio.twiml.VoiceResponse;

const recordingsDir = path.join(__dirname, '../../uploads/recordings');

/** Rejects webhook calls that didn't come from Twilio. These two endpoints
 * are public and write recordings onto CRM records, so an unsigned request
 * must not be able to forge one. Enforced whenever the platform auth token
 * is configured (it has to be for the recording download anyway); without it
 * the check is skipped with a warning so a half-configured pilot still runs. */
export const verifyTwilioSignature = (req: Request, res: Response, next: () => void) => {
    const authToken = process.env.PLATFORM_TWILIO_AUTH_TOKEN;
    if (!authToken) {
        console.warn('[TelephonyBridge] PLATFORM_TWILIO_AUTH_TOKEN not set — webhook signature NOT verified');
        return next();
    }
    const signature = req.header('x-twilio-signature') ?? '';
    const proto = (req.header('x-forwarded-proto') ?? req.protocol).split(',')[0];
    const base = process.env.PUBLIC_API_URL?.replace(/\/$/, '') ?? `${proto}://${req.get('host')}`;
    const url = `${base}${req.originalUrl}`;
    if (!twilio.validateRequest(authToken, signature, url, req.body ?? {})) {
        console.warn(`[TelephonyBridge] Rejected webhook with invalid Twilio signature: ${req.originalUrl}`);
        res.sendStatus(403);
        return;
    }
    next();
};

/** Twilio recording URLs need the account's credentials to fetch, so the
 * CRM's player can't use them directly. Pull the mp3 down into the same
 * uploads/recordings folder every other call recording lives in and store
 * the local path, so playback/delete/export work exactly as they already do. */
async function downloadRecording(recordingUrl: string, recordingSid: string): Promise<string | null> {
    const sid = process.env.PLATFORM_TWILIO_ACCOUNT_SID;
    const token = process.env.PLATFORM_TWILIO_AUTH_TOKEN;
    if (!sid || !token || !/^[A-Za-z0-9]+$/.test(recordingSid)) return null;
    try {
        fs.mkdirSync(recordingsDir, { recursive: true });
        const filename = `bridge-${recordingSid}.mp3`;
        const response = await axios.get(`${recordingUrl}.mp3`, {
            auth: { username: sid, password: token },
            responseType: 'arraybuffer',
            timeout: 60000,
        });
        fs.writeFileSync(path.join(recordingsDir, filename), Buffer.from(response.data));
        return `/uploads/recordings/${filename}`;
    } catch (error) {
        console.error('[TelephonyBridge] Recording download failed:', (error as Error).message);
        return null;
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Server-number/conference-bridge call recording — see
 * `Dad-dialer/CALL_RECORDING_SERVER_METHOD_PLAN.md`. Centralized: PypeCRM
 * owns one Twilio account and a shared pool of bridge numbers
 * (`telephonyBridgeService.ts`), not the per-org bring-your-own-Twilio
 * pattern `telephonyController.ts` uses for the desktop click-to-call
 * flow. This is deliberately a different flow from that one — here,
 * Twilio only ever receives an INBOUND call (the phone's own SIM dials
 * the shared bridge number and, if the carrier supports 3-way merge,
 * conferences it with the real call) — so this webhook's only job is to
 * identify which agent/org that inbound call belongs to (by the calling
 * agent's own phone number — the pool number dialed carries no org
 * identity) and record it.
 */

// Inbound voice webhook — Twilio hits this the moment any pool number is
// dialed. Identifies the org via the CALLING agent's own phone, not `To`
// (which is just whichever shared pool number got dialed).
export const handleBridgeVoice = async (req: Request, res: Response) => {
    const { From } = req.body;
    const twiml = new VoiceResponse();

    try {
        const agent = typeof From === 'string' ? await findAgentByPhone(From) : null;
        if (!agent) {
            console.warn(`[TelephonyBridge] Inbound bridge call from unrecognized number: ${From}`);
            twiml.hangup();
            res.type('text/xml').send(twiml.toString());
            return;
        }

        const bridgeConfig = await resolveBridgeConfigForOrg(agent.organisationId);
        if (!bridgeConfig.enabled) {
            // Org hasn't opted in (or has since turned it off) — a stale
            // dialer build could still dial in during the settings-cache
            // TTL window, so this must not be treated as an error.
            console.warn(`[TelephonyBridge] Bridge call from agent ${agent.id} but org ${agent.organisationId} has cloud recording disabled`);
            twiml.hangup();
            res.type('text/xml').send(twiml.toString());
            return;
        }

        // Optional short consent announcement before recording starts —
        // the mechanism the plan doc flags as a real improvement over the
        // old per-org-guesswork consent story: a two-party-consent
        // disclosure can be a platform default instead of relying on each
        // org to handle it themselves. Off by default (silence) until
        // legal/product actually turns it on per-org — same "don't
        // default silently" stance as `autoRecordInbound`/`autoRecordOutbound`.
        if (bridgeConfig.consentAnnouncement) {
            twiml.say(bridgeConfig.consentAnnouncement);
        }

        const callbackUrl = `/api/telephony/bridge/recording-status?agentId=${agent.id}&orgId=${agent.organisationId}`;
        // A one-person conference rather than <Record>: <Record> stops on 5s
        // of silence or on ANY keypad digit (IVR menus, "press 1"), which
        // would cut recordings short mid-call. A conference records for as
        // long as the line stays up and ends when the merged call does.
        twiml.dial().conference(
            {
                record: 'record-from-start',
                beep: 'false',
                startConferenceOnEnter: true,
                endConferenceOnExit: true,
                recordingStatusCallback: callbackUrl,
                recordingStatusCallbackEvent: ['completed'],
                recordingStatusCallbackMethod: 'POST',
            },
            `bridge-${req.body.CallSid ?? Date.now()}`,
        );
        res.type('text/xml').send(twiml.toString());
    } catch (error) {
        console.error('[TelephonyBridge] Voice webhook error:', error);
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
    }
};

// Recording-finished callback. `agentId`/`orgId` come from the query
// params `handleBridgeVoice` set on the way in.
export const handleBridgeRecordingStatus = async (req: Request, res: Response) => {
    const { agentId, orgId } = req.query;
    const { RecordingUrl, RecordingDuration, RecordingSid } = req.body;

    if (!agentId || typeof agentId !== 'string' || !orgId || typeof orgId !== 'string') {
        return res.status(400).send('Missing agentId/orgId');
    }
    // Nothing recorded (hung up before the merge completed) — not an error.
    if (!RecordingUrl || !RecordingSid) return res.sendStatus(200);

    // Answer Twilio right away; the download and the wait for the call's
    // Interaction row can take a while and Twilio retries slow callbacks.
    res.sendStatus(200);
    attachRecording(agentId, orgId, RecordingUrl, RecordingSid, parseInt(RecordingDuration, 10) || null).catch((error) =>
        console.error('[TelephonyBridge] attachRecording error:', error),
    );
};

/** Recording finished at about the same moment the dialer syncs the call
 * itself, so the Interaction row may not exist yet — keep looking for ~4
 * minutes before giving up and logging the recording as orphaned. */
async function attachRecording(agentId: string, orgId: string, recordingUrl: string, recordingSid: string, durationSecs: number | null) {
    const localUrl = (await downloadRecording(recordingUrl, recordingSid)) ?? recordingUrl;

    // Twilio retries callbacks: don't attach the same recording twice.
    if (await prisma.interaction.findFirst({ where: { recordingUrl: localUrl }, select: { id: true } })) return;

    for (let attempt = 0; attempt < 9; attempt++) {
        const windowStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const candidates = await prisma.interaction.findMany({
            where: {
                organisationId: orgId,
                createdById: agentId,
                type: 'call',
                recordingUrl: null,
                date: { gte: windowStart },
            },
            orderBy: { date: 'desc' },
            take: 5,
        });
        // Never attach to the bridge leg's own call record.
        const match = candidates.find((c) => !isBridgeNumber(c.phoneNumber));
        if (match) {
            const data: any = { recordingUrl: localUrl };
            if (durationSecs) {
                data.recordingDuration = durationSecs;
                synchronizeDurations(data);
            }
            await prisma.interaction.update({ where: { id: match.id }, data });
            console.log(`[TelephonyBridge] Attached cloud recording to Interaction ${match.id} for agent ${agentId}`);
            return;
        }
        await sleep(30_000);
    }
    console.warn(`[TelephonyBridge] No un-recorded call Interaction for agent ${agentId} — recording orphaned: ${localUrl}`);
}

// The dialer reports how each production merge attempt ended (merged / bridge
// never answered / carrier refused the merge) with the SIM and phone model.
// This is how real carrier coverage is measured from live traffic.
export const reportBridgeOutcome = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'Organisation not found' });
        const { outcome, simLabel, device, androidSdk } = req.body;
        if (typeof outcome !== 'string' || outcome.length > 40) return res.status(400).json({ message: 'Invalid outcome' });

        await prisma.auditLog.create({
            data: {
                action: 'BRIDGE_OUTCOME',
                entity: 'CallRecordingBridge',
                actorId: user.id,
                organisationId: orgId,
                details: { outcome, simLabel: simLabel ?? null, device: device ?? null, androidSdk: androidSdk ?? null },
            },
        });
        res.sendStatus(204);
    } catch (error) {
        console.error('[TelephonyBridge] reportBridgeOutcome error:', error);
        res.sendStatus(500);
    }
};

// Success rate of the last 30 days of attempts, by SIM and by phone model.
export const getBridgeOutcomeSummary = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'Organisation not found' });
        const rows = await prisma.auditLog.findMany({
            where: { organisationId: orgId, action: 'BRIDGE_OUTCOME', createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
            select: { details: true },
            take: 10000,
        });
        const tally = (key: 'simLabel' | 'device') => {
            const out: Record<string, { attempts: number; merged: number; outcomes: Record<string, number> }> = {};
            for (const { details } of rows) {
                const d = (details ?? {}) as any;
                const k = String(d[key] ?? 'unknown');
                const entry = (out[k] ??= { attempts: 0, merged: 0, outcomes: {} });
                entry.attempts += 1;
                if (d.outcome === 'MERGED') entry.merged += 1;
                entry.outcomes[d.outcome] = (entry.outcomes[d.outcome] ?? 0) + 1;
            }
            return out;
        };
        const merged = rows.filter((r) => (r.details as any)?.outcome === 'MERGED').length;
        res.json({ attempts: rows.length, merged, successRate: rows.length ? merged / rows.length : null, bySim: tally('simLabel'), byDevice: tally('device') });
    } catch (error) {
        console.error('[TelephonyBridge] getBridgeOutcomeSummary error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// Protected config endpoints — org-admin only ever controls opt-in +
// consent copy now; the bridge NUMBER is centralized/pooled, not
// org-settable (see telephonyBridgeService.ts). No Dad-frontend UI yet
// (out of scope for this pass); settable directly via this API until one
// exists.
export const getBridgeConfig = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'Organisation not found' });

        const config = await resolveBridgeConfigForOrg(orgId);
        res.json(config);
    } catch (error) {
        console.error('[TelephonyBridge] getBridgeConfig error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateBridgeConfig = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'Organisation not found' });

        const { enabled, consentAnnouncement } = req.body;
        const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { integrations: true } });
        const integrations = (org?.integrations as any) ?? {};
        integrations.callRecordingBridge = {
            ...(integrations.callRecordingBridge ?? {}),
            ...(enabled !== undefined ? { enabled: enabled === true } : {}),
            ...(consentAnnouncement !== undefined ? { consentAnnouncement } : {}),
        };

        await prisma.organisation.update({ where: { id: orgId }, data: { integrations } });
        res.json(await resolveBridgeConfigForOrg(orgId));
    } catch (error) {
        console.error('[TelephonyBridge] updateBridgeConfig error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
