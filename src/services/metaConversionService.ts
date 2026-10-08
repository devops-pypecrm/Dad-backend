import axios from 'axios';
import prisma from '../config/prisma';
import { decrypt } from '../utils/encryption';

interface ConversionEvent {
    eventName: string;
    userData: {
        email?: string | null;
        phone?: string | null;
        firstName?: string | null;
        lastName?: string | null;
        externalId?: string | null;
        leadId?: string | number | null;
        clientUserAgent?: string | null;
        clientIp?: string | null;
    };
    customData?: Record<string, any>;
    eventSourceUrl?: string;
    actionSource?: 'website' | 'system_generated' | 'email' | 'other';
    eventTime?: number;
}

/**
 * Picks which connected Meta account's Pixel ID/token to send Conversions API
 * events through. Orgs can have several connected accounts (`integrations.metaAccounts`)
 * on top of the older single-account `integrations.meta` — prefer whichever account
 * matches the event's branch (so a multi-branch org's CAPI events attribute to the
 * right ad account/pixel), then fall back to the legacy single `meta` object, then
 * to the first connected account that actually has a Pixel ID configured.
 */
function resolveMetaCapiConfig(integrations: any, branchId?: string | null): { pixelId?: string; accessToken?: string; capiToken?: string } {
    const legacy = integrations?.meta;
    const accounts: any[] = Array.isArray(integrations?.metaAccounts) ? integrations.metaAccounts : [];

    if (branchId) {
        const branchMatch = accounts.find((a) => a.branchId === branchId && a.pixelId);
        if (branchMatch) return { pixelId: branchMatch.pixelId, accessToken: branchMatch.accessToken, capiToken: branchMatch.capiToken };
        if (legacy?.branchId === branchId && legacy?.pixelId) {
            return { pixelId: legacy.pixelId, accessToken: legacy.accessToken, capiToken: legacy.capiToken };
        }
    }

    if (legacy?.pixelId) return { pixelId: legacy.pixelId, accessToken: legacy.accessToken, capiToken: legacy.capiToken };

    const anyMatch = accounts.find((a) => a.pixelId);
    if (anyMatch) return { pixelId: anyMatch.pixelId, accessToken: anyMatch.accessToken, capiToken: anyMatch.capiToken };

    return {};
}

export const MetaConversionService = {
    /**
     * Send an event to Meta Conversions API
     */
    async sendEvent(organisationId: string, event: ConversionEvent | ConversionEvent[], branchId?: string | null) {
        try {
            // 1. Get Meta Config (Pixel ID & Access Token)
            const org = await prisma.organisation.findUnique({
                where: { id: organisationId },
                select: { integrations: true }
            });

            if (!org) return;

            const { pixelId, accessToken: encryptedOAuthToken, capiToken: encryptedCapiToken } = resolveMetaCapiConfig(org.integrations, branchId);

            // Prefer the custom CAPI token if provided; otherwise fallback to the OAuth token
            const encryptedToken = encryptedCapiToken || encryptedOAuthToken;

            if (!pixelId || !encryptedToken) {
                console.warn(`[MetaConversions] Org ${organisationId} missing Pixel ID or Access Token`);
                return;
            }

            // Stored tokens are encrypted at rest
            const accessToken = decrypt(encryptedToken);

            const events = Array.isArray(event) ? event : [event];

            // 2. Map and Hash Events
            const data = events.map(evt => {
                const userData: any = {
                    em: evt.userData.email ? [hash(evt.userData.email)] : undefined,
                    ph: evt.userData.phone ? [hash(evt.userData.phone)] : undefined,
                    fn: evt.userData.firstName ? [hash(evt.userData.firstName)] : undefined,
                    ln: evt.userData.lastName ? [hash(evt.userData.lastName)] : undefined,
                    external_id: evt.userData.externalId ? [hash(evt.userData.externalId)] : undefined,
                    lead_id: evt.userData.leadId || undefined,
                    client_user_agent: evt.userData.clientUserAgent,
                    client_ip_address: evt.userData.clientIp,
                };

                return {
                    event_name: evt.eventName || 'Lead',
                    event_time: evt.eventTime || Math.floor(Date.now() / 1000),
                    action_source: evt.actionSource || 'system_generated',
                    user_data: userData,
                    custom_data: {
                        event_source: 'crm',
                        lead_event_source: 'PypeCRM',
                        ...evt.customData
                    },
                    event_source_url: evt.eventSourceUrl
                };
            });

            // 3. Construct Payload
            const payload = { data };

            // 4. Send Request
            // Graph API: POST /<PIXEL_ID>/events
            await axios.post(`https://graph.facebook.com/v18.0/${pixelId}/events`, payload, {
                params: { access_token: accessToken } // Pass here to be safe
            });

            console.log(`[MetaConversions] ${events.length} event(s) sent successfully`);

        } catch (error: any) {
            console.error('[MetaConversions] Failed to send event:', error.response?.data || error.message);
            // Don't throw, just log. We don't want to break the main flow.
        }
    }
};

// Simple SHA256 Hash Helper (using crypto)
import crypto from 'crypto';

function hash(value: string): string {
    if (!value) return '';
    const trimmed = value.trim().toLowerCase();

    // If it's already a 64-char hex string (SHA256 format), return it as is
    if (/^[a-f0-9]{64}$/.test(trimmed)) {
        return trimmed;
    }

    return crypto.createHash('sha256').update(trimmed).digest('hex');
}
