import crypto from 'crypto';
import prisma from '../config/prisma';
import { metaService } from './metaService';
import { logger } from '../utils/logger';
import { DistributionService } from './distributionService';
import { decrypt } from '../utils/encryption';
import { getConnectedMetaAccounts } from '../utils/metaAccountResolver';

export const MetaIntegrationService = {
    /**
     * Handle incoming webhook from Meta
     */
    async handleWebhook(payload: any): Promise<void> {
        try {
            logger.webhook('Meta', 'receive_payload', undefined, { payload });

            // Basic parsing logic for Facebook Webhooks
            // Usually payload.entry array
            if (payload.entry) {
                for (const entry of payload.entry) {
                    if (entry.changes) {
                        for (const change of entry.changes) {
                            if (change.field === 'leadgen') {
                                await this.processLeadGen(change.value);
                            } else if (change.field === 'ads') {
                                await this.processAdUpdate(change.value);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.webhookError('Meta', 'process_webhook', error);
        }
    },

    async processLeadGen(value: any) {
        try {
            // value contains leadgen_id, form_id, page_id, created_time
            const { leadgen_id, page_id, ad_id, form_id } = value;
            logger.webhook('Meta', 'process_leadgen', undefined, { leadgen_id, page_id, ad_id, form_id });

            // Delegate to the specialized MetaLeadService for unified processing
            const { MetaLeadService } = await import('./metaLeadService');
            await MetaLeadService.processIncomingLead(leadgen_id, page_id, ad_id, form_id);

        } catch (error) {
            logger.webhookError('Meta', 'process_leadgen_failed', error);
        }
    },

    async processAdUpdate(value: any) {
        try {
            logger.webhook('Meta', 'ad_update', undefined, { value });

            // value contains data related to ad status changes
            // For now, we log it and we could potentially update a local campaign status
            // if we have a mapping between Meta Ad ID and CRM Campaign

            if (value.ad_id) {
                console.log(`[MetaIntegration] Ad update received for Ad ID: ${value.ad_id}, Status: ${value.status}`);

                // We could find campaigns linked to this ad and update them
                const campaigns = await prisma.campaign.findMany({
                    where: {
                        customFields: {
                            path: ['metaAdId'],
                            equals: value.ad_id
                        }
                    }
                });

                for (const campaign of campaigns) {
                    await prisma.campaign.update({
                        where: { id: campaign.id },
                        data: {
                            status: this.mapMetaStatusToCrmStatus(value.status || 'ACTIVE')
                        }
                    });
                }
            }
        } catch (error) {
            logger.webhookError('Meta', 'ad_update_failed', error);
        }
    },

    /**
     * Sync campaigns for a connected account
     */
    async syncCampaigns(organisationId: string): Promise<any[]> {
        try {
            logger.info(`Syncing campaigns for organization ${organisationId}`, 'MetaIntegration', undefined, organisationId);

            // Was reading only the legacy single integrations.meta slot - for an
            // org with more than one connected Page/ad account, that could be
            // any one of them (whichever reconnected most recently), not
            // necessarily the one actually being synced. getConnectedMetaAccounts
            // merges metaAccounts[] with the legacy slot, so this still works
            // unchanged for an org that never touched the multi-account feature.
            const accounts = await getConnectedMetaAccounts(organisationId);
            const metaConfig = accounts.find((a) => a.adAccountId) || accounts[0];

            if (!metaConfig?.accessToken || !metaConfig?.adAccountId) {
                throw new Error('Meta integration not configured');
            }

            // Fetch campaigns from Meta
            const campaigns = await metaService.getCampaigns({
                ...metaConfig,
                accessToken: decrypt(metaConfig.accessToken)
            });

            // Sync campaigns to database
            const syncedCampaigns = [];
            for (const campaign of campaigns) {
                try {
                    const existingCampaign = await prisma.campaign.findFirst({
                        where: {
                            organisationId,
                            customFields: {
                                path: ['metaCampaignId'],
                                equals: campaign.id
                            }
                        }
                    });

                    if (existingCampaign) {
                        // Update existing campaign
                        const updated = await prisma.campaign.update({
                            where: { id: existingCampaign.id },
                            data: {
                                name: campaign.name,
                                status: this.mapMetaStatusToCrmStatus(campaign.status),
                                customFields: {
                                    ...existingCampaign.customFields as any,
                                    metaCampaignId: campaign.id,
                                    metaObjective: campaign.objective,
                                    metaDailyBudget: campaign.daily_budget,
                                    metaLifetimeBudget: campaign.lifetime_budget,
                                    metaStartTime: campaign.start_time,
                                    metaStopTime: campaign.stop_time
                                }
                            }
                        });
                        syncedCampaigns.push(updated);
                    } else {
                        // Create new campaign
                        const created = await prisma.campaign.create({
                            data: {
                                name: campaign.name,
                                subject: `Meta Campaign: ${campaign.name}`,
                                content: `Imported from Meta Ads - Objective: ${campaign.objective}`,
                                status: this.mapMetaStatusToCrmStatus(campaign.status),
                                organisationId,
                                customFields: {
                                    metaCampaignId: campaign.id,
                                    metaObjective: campaign.objective,
                                    metaDailyBudget: campaign.daily_budget,
                                    metaLifetimeBudget: campaign.lifetime_budget,
                                    metaStartTime: campaign.start_time,
                                    metaStopTime: campaign.stop_time,
                                    source: 'meta_ads'
                                }
                            }
                        });
                        syncedCampaigns.push(created);
                    }
                } catch (campaignError) {
                    logger.error(`Error syncing campaign ${campaign.id}`, campaignError, 'MetaIntegration', undefined, organisationId);
                }
            }

            logger.info(`Synced ${syncedCampaigns.length} campaigns`, 'MetaIntegration', undefined, organisationId);
            return syncedCampaigns;

        } catch (error) {
            logger.error('Error syncing campaigns', error, 'MetaIntegration', undefined, organisationId);
            throw error;
        }
    },

    /**
     * Map Meta campaign status to CRM status
     */
    mapMetaStatusToCrmStatus(metaStatus: string): string {
        const statusMap: { [key: string]: string } = {
            'ACTIVE': 'active',
            'PAUSED': 'paused',
            'DELETED': 'deleted',
            'ARCHIVED': 'archived',
            'PENDING_REVIEW': 'draft',
            'DISAPPROVED': 'failed',
            'PREAPPROVED': 'scheduled',
            'PENDING_BILLING_INFO': 'draft',
            'CAMPAIGN_PAUSED': 'paused',
            'ADSET_PAUSED': 'paused',
            'IN_PROCESS': 'active',
            'WITH_ISSUES': 'failed'
        };

        return statusMap[metaStatus] || 'draft';
    },

    /**
     * Get campaign insights for synced campaigns
     */
    async getCampaignInsights(organisationId: string, campaignId?: string): Promise<any> {
        try {
            const org = await prisma.organisation.findUnique({
                where: { id: organisationId },
                select: { integrations: true }
            });

            if (!org) {
                throw new Error('Organization not found');
            }

            const integrations = org.integrations as any;
            const metaConfig = integrations?.meta;

            if (!metaConfig?.accessToken || !metaConfig?.adAccountId) {
                throw new Error('Meta integration not configured');
            }

            const accessToken = decrypt(metaConfig.accessToken);
            let insights;

            if (campaignId) {
                // Get insights for specific campaign
                const campaign = await prisma.campaign.findFirst({
                    where: { id: campaignId, organisationId },
                    select: { customFields: true }
                });

                if (!campaign) {
                    throw new Error('Campaign not found');
                }

                const customFields = campaign.customFields as any;
                const metaCampaignId = customFields?.metaCampaignId;

                if (!metaCampaignId) {
                    throw new Error('Campaign not linked to Meta');
                }

                insights = await metaService.makeRequest(`${metaCampaignId}/insights`, accessToken, {
                    fields: 'impressions,clicks,spend,cpc,cpm,cpp,ctr,unique_clicks,reach,actions',
                    date_preset: 'last_30d'
                });
            } else {
                // Get account-level insights
                insights = await metaService.getInsights({ ...metaConfig, accessToken }, 'account');
            }

            return insights;

        } catch (error) {
            logger.error('Error getting campaign insights', error, 'MetaIntegration', undefined, organisationId);
            throw error;
        }
    },

    /**
     * Verify Webhook (GET request)
     */
    async verifyWebhook(req: any, res: any): Promise<void> {
        // Helper to grab param regardless of parsing style (dot notation or nested object)
        const getParam = (name: string) => {
            return req.query[name] || (req.query.hub && req.query.hub[name.replace('hub.', '')]);
        };

        const mode = getParam('hub.mode');
        const token = getParam('hub.verify_token');
        const challenge = getParam('hub.challenge');

        const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

        if (!VERIFY_TOKEN) {
            logger.error('[MetaWebhook] META_VERIFY_TOKEN not configured', 'MetaWebhook');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        logger.info(`[MetaWebhook] Verification Request: Mode=${mode}, Token=${token}, Challenge=${challenge}`, 'MetaWebhook');
        logger.info(`[MetaWebhook] Expected Token: ${VERIFY_TOKEN}`, 'MetaWebhook');

        if (mode && token) {
            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                logger.info('[MetaWebhook] Verification SUCCESS', 'MetaWebhook');
                // Meta expects plain text of the challenge
                res.type('text/plain').status(200).send(challenge);
            } else {
                logger.warn(`[MetaWebhook] Verification FAILED. Received token: '${token}', Expected: '${VERIFY_TOKEN}'`, 'MetaWebhook');
                res.sendStatus(403);
            }
        } else {
            logger.warn('[MetaWebhook] Verification FAILED - Missing parameters', 'MetaWebhook');
            res.sendStatus(400);
        }
    },

    /**
     * Meta's deauthorize_callback_url - called when a Facebook user removes
     * this app from their own Facebook Settings. Payload is a `signed_request`
     * form field (base64url signature + base64url JSON payload, HMAC-SHA256
     * signed with the app secret) containing that user's Facebook `user_id`.
     *
     * We only ever stored a CRM userId + Page/ad-account tokens per connection
     * before this fix - never the connecting Facebook user's own id - so a
     * deauthorize event for a connection made before this change has nothing
     * to match against and is just logged. Every connection made after this
     * fix stores `fbUserId` on its metaAccounts[] entry, so those can be
     * found and flagged automatically going forward.
     */
    verifyAndParseSignedRequest(signedRequest: string): { user_id?: string } | null {
        const appSecret = process.env.META_APP_SECRET;
        if (!appSecret || !signedRequest || !signedRequest.includes('.')) return null;

        const [encodedSig, encodedPayload] = signedRequest.split('.');
        const base64UrlDecode = (str: string) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

        const expectedSig = crypto
            .createHmac('sha256', appSecret)
            .update(encodedPayload)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        if (expectedSig !== encodedSig) {
            logger.warn('[MetaDeauthorize] Invalid signed_request signature', 'MetaDeauthorize');
            return null;
        }

        try {
            return JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
        } catch {
            return null;
        }
    },

    async handleDeauthorize(fbUserId: string): Promise<void> {
        try {
            const orgs = await prisma.organisation.findMany({
                where: { integrations: { not: null as any } },
                select: { id: true, name: true, integrations: true }
            });

            for (const org of orgs) {
                const integrations = org.integrations as any;
                const metaAccounts: any[] = Array.isArray(integrations?.metaAccounts) ? integrations.metaAccounts : [];
                const legacyMatches = integrations?.meta?.fbUserId === fbUserId;
                const matchedAccounts = metaAccounts.filter((acc) => acc.fbUserId === fbUserId);

                if (matchedAccounts.length === 0 && !legacyMatches) continue;

                const now = new Date().toISOString();
                const updatedMetaAccounts = metaAccounts.map((acc) =>
                    acc.fbUserId === fbUserId ? { ...acc, connected: false, needsReconnect: true, deauthorizedAt: now } : acc
                );
                const updatedLegacy = legacyMatches
                    ? { ...integrations.meta, connected: false, needsReconnect: true, deauthorizedAt: now }
                    : integrations.meta;

                await prisma.organisation.update({
                    where: { id: org.id },
                    data: { integrations: { ...integrations, metaAccounts: updatedMetaAccounts, meta: updatedLegacy } }
                });

                logger.warn(`[MetaDeauthorize] Org "${org.name}" (${org.id}) - Facebook user ${fbUserId} revoked access, flagged for reconnect`, 'MetaDeauthorize');

                try {
                    const { NotificationService } = await import('./notificationService');
                    const admins = await prisma.user.findMany({
                        where: { organisationId: org.id, role: { in: ['admin', 'org_admin', 'organisation_admin'] }, isActive: true, isDeleted: false },
                        select: { id: true }
                    });
                    for (const admin of admins) {
                        await NotificationService.send(
                            admin.id,
                            'Meta connection removed',
                            'Someone removed PypeCRM\'s access from Facebook settings. Reconnect in Settings → Integrations to keep receiving leads and managing ads.',
                            'warning'
                        );
                    }
                } catch (notifyError) {
                    logger.error('[MetaDeauthorize] Failed to notify org admins', notifyError, 'MetaDeauthorize');
                }
            }
        } catch (error) {
            logger.error('[MetaDeauthorize] Failed to process deauthorize event', error, 'MetaDeauthorize');
        }
    }
};
