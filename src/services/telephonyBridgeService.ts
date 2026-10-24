import prisma from '../config/prisma';

/**
 * Centralized call-recording bridge — see
 * `Dad-dialer/CALL_RECORDING_SERVER_METHOD_PLAN.md`. Deliberately NOT the
 * per-org bring-your-own-Twilio pattern `telephonyService.ts` uses for the
 * desktop click-to-call flow: PypeCRM owns one Twilio account and a small
 * pool of bridge numbers centrally (env-configured), and every org's
 * dialer app dials into that same shared pool. An org only ever controls
 * whether it's opted in (`enabled`) and its own consent announcement —
 * never which number, since the number carries no org identity at all
 * (correlation happens by matching the calling agent's own phone against
 * `User.phone`, not by which pool number was dialed).
 *
 * Scaffolding note: bridge numbers are read from `PLATFORM_TWILIO_*` env
 * vars once at module load. No live Twilio bridge number has been
 * exercised against this yet — see the plan doc's Phase 2 status.
 */

const BRIDGE_NUMBERS = (process.env.PLATFORM_TWILIO_BRIDGE_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

let roundRobinIndex = 0;

export function hasBridgeNumbers(): boolean {
    return BRIDGE_NUMBERS.length > 0;
}

/** Simple round-robin over the pool — any number works identically for a
 * given call, so there's no need for a sticky per-org/per-call mapping.
 * Callers should re-fetch per call rather than caching this long-term. */
export function pickBridgeNumber(): string | null {
    if (BRIDGE_NUMBERS.length === 0) return null;
    const number = BRIDGE_NUMBERS[roundRobinIndex % BRIDGE_NUMBERS.length];
    roundRobinIndex += 1;
    return number;
}

export interface BridgeConfig {
    enabled: boolean;
    bridgeNumber: string | null;
    consentAnnouncement: string | null;
}

/** What the dialer app and `GET /api/call-settings` both need: whether
 * this org opted in, and (only if so, and only if the platform pool is
 * actually configured) a bridge number to dial. */
export async function resolveBridgeConfigForOrg(orgId: string): Promise<BridgeConfig> {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { integrations: true } });
    const orgBridgeConfig = (org?.integrations as any)?.callRecordingBridge ?? {};
    const enabled = orgBridgeConfig.enabled === true;
    return {
        enabled,
        bridgeNumber: enabled ? pickBridgeNumber() : null,
        consentAnnouncement: orgBridgeConfig.consentAnnouncement ?? null,
    };
}

function normalizePhone(raw: string): string {
    const digits = raw.replace(/[^0-9]/g, '');
    return digits.slice(-10);
}

/** Identifies which agent (and therefore which org) an inbound bridge call
 * belongs to, purely from the caller's own phone number — the pool number
 * dialed carries no org identity. Global scan across all orgs' users by
 * design (that's the whole point of a centralized pool); a phone number
 * collision across two different orgs' agents is a real but rare edge
 * case this doesn't disambiguate further than "first match" — acceptable
 * for pilot scale, revisit if it actually happens in practice. */
export async function findAgentByPhone(rawPhone: string): Promise<{ id: string; organisationId: string } | null> {
    const last10 = normalizePhone(rawPhone);
    if (last10.length < 10) return null;
    const agent = await prisma.user.findFirst({
        where: {
            phone: { endsWith: last10 },
            isDeleted: false,
            organisationId: { not: null },
        },
        select: { id: true, organisationId: true },
    });
    if (!agent || !agent.organisationId) return null;
    return { id: agent.id, organisationId: agent.organisationId };
}
