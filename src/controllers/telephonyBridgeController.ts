import { Request, Response } from 'express';
import twilio from 'twilio';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { synchronizeDurations } from '../utils/callUtils';
import { resolveBridgeConfigForOrg, findAgentByPhone } from '../services/telephonyBridgeService';

const VoiceResponse = twilio.twiml.VoiceResponse;

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
        twiml.record({
            action: callbackUrl,
            recordingStatusCallback: callbackUrl,
            maxLength: 3600,
            playBeep: false,
        });
        res.type('text/xml').send(twiml.toString());
    } catch (error) {
        console.error('[TelephonyBridge] Voice webhook error:', error);
        twiml.hangup();
        res.type('text/xml').send(twiml.toString());
    }
};

// Recording-finished callback. `agentId`/`orgId` come from the query
// params `handleBridgeVoice` set on the way in — re-deriving them from
// `From` again here would work too, but passing them through explicitly
// avoids doing the same phone lookup twice and any window for it to
// resolve differently between the two webhook calls.
export const handleBridgeRecordingStatus = async (req: Request, res: Response) => {
    const { agentId, orgId } = req.query;
    const { RecordingUrl, RecordingDuration, CallDuration } = req.body;

    try {
        if (!agentId || typeof agentId !== 'string' || !orgId || typeof orgId !== 'string') {
            return res.status(400).send('Missing agentId/orgId');
        }
        if (!RecordingUrl) {
            // The record action fires even on a call that never actually
            // recorded anything (e.g. hung up before merge completed) —
            // nothing to correlate, not an error.
            return res.sendStatus(200);
        }

        // Closest-in-time Interaction created by this agent without a
        // recording yet — mirrors the dedup spirit of androidController.ts
        // (heal an existing row rather than create a duplicate), just
        // matched on (agent, recency) instead of (callSessionId/
        // hardwareId) since the bridge leg has neither.
        const windowStart = new Date(Date.now() - 5 * 60 * 1000);
        const candidate = await prisma.interaction.findFirst({
            where: {
                organisationId: orgId,
                createdById: agentId,
                type: 'call',
                recordingUrl: null,
                date: { gte: windowStart },
            },
            orderBy: { date: 'desc' },
        });

        if (!candidate) {
            console.warn(`[TelephonyBridge] No recent un-recorded call Interaction for agent ${agentId} — recording orphaned: ${RecordingUrl}`);
            return res.sendStatus(200);
        }

        const data: any = { recordingUrl: RecordingUrl };
        if (RecordingDuration) {
            data.recordingDuration = parseInt(RecordingDuration, 10);
            synchronizeDurations(data);
        }
        if (CallDuration) {
            data.hardwareDuration = parseInt(CallDuration, 10);
            synchronizeDurations(data);
        }

        await prisma.interaction.update({ where: { id: candidate.id }, data });
        console.log(`[TelephonyBridge] Attached cloud recording to Interaction ${candidate.id} for agent ${agentId}`);
        res.sendStatus(200);
    } catch (error) {
        console.error('[TelephonyBridge] Recording status webhook error:', error);
        res.sendStatus(500);
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
