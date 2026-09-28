import axios from 'axios';
import prisma from '../config/prisma';
import { MetaLeadService } from './metaLeadService';
import { decrypt } from '../utils/encryption';
import logger from '../utils/logger';

let isPolling = false;

// Rate-limit cooldown map: pageId -> timestamp when cooldown expires
const rateLimitCooldown = new Map<string, number>();
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// Org-admin alert cooldown map: orgId -> timestamp of last in-app alert sent
const orgAdminAlertCooldown = new Map<string, number>();
const ORG_ADMIN_ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

function isRateLimited(pageId: string): boolean {
    const expiresAt = rateLimitCooldown.get(pageId);
    if (!expiresAt) return false;
    if (Date.now() < expiresAt) return true;
    rateLimitCooldown.delete(pageId); // expired, clear it
    return false;
}

function markRateLimited(pageId: string) {
    const expiresAt = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    rateLimitCooldown.set(pageId, expiresAt);
    logger.info(`[MetaPolling] Page ${pageId} is rate-limited. Skipping for 2 hours until ${new Date(expiresAt).toISOString()}.`, 'MetaPolling');
}

export const MetaPollingService = {
    /**
     * Polls Meta for new leads across all connected organisations
     */
    async pollAllOrganisations() {
        if (isPolling) {
            logger.info('Meta polling is already in progress, skipping this run.', 'MetaPolling');
            return;
        }

        isPolling = true;
        try {
            const organisations = await prisma.organisation.findMany({
                where: {
                    isDeleted: false,
                    status: { in: ['active', 'suspended'] }
                },
                select: {
                    id: true,
                    name: true,
                    status: true,
                    integrations: true
                }
            });

            logger.info(`Found ${organisations.length} organisations to check for Meta integrations.`, 'MetaPolling');
            
            for (const org of organisations) {
                const integrations = (org.integrations as any) || {};
                const accounts = [...(integrations.metaAccounts || [])];
                
                if (integrations.meta && integrations.meta.connected) {
                    const exists = accounts.some(acc => acc.pageId === integrations.meta.pageId);
                    if (!exists) accounts.push(integrations.meta);
                }

                if (accounts.length === 0) continue;

                for (const account of accounts) {
                    if (!account.connected || !account.accessToken || !account.pageId) continue;

                    // Skip pages that are currently rate-limited
                    if (isRateLimited(account.pageId)) {
                        const expiresAt = new Date(rateLimitCooldown.get(account.pageId)!).toISOString();
                        logger.info(`[MetaPolling] Skipping page ${account.pageName || account.pageId} — rate-limited until ${expiresAt}`, 'MetaPolling', undefined, org.id);
                        continue;
                    }

                    try {
                        const accessToken = decrypt(account.accessToken);
                        
                        // 1. Get leadgen forms
                        const formsResponse = await axios.get(`https://graph.facebook.com/v18.0/${account.pageId}/leadgen_forms`, {
                            params: {
                                access_token: accessToken,
                                fields: 'id,name,status',
                                limit: 50
                            }
                        });

                        const allForms = formsResponse.data.data || [];
                        const forms = allForms.filter((f: any) => f.status === 'ACTIVE');

                        // Use 32 min buffer (cron runs every 30 min + 2 min safety overlap)
                        const sinceTime = Math.floor(Date.now() / 1000) - (32 * 60);
                        logger.info(`Checking ${forms.length} forms for page ${account.pageName || account.pageId} since ${new Date(sinceTime * 1000).toISOString()}`, 'MetaPolling', undefined, org.id);

                        for (const form of forms) {
                            try {
                                const leadsResponse = await axios.get(`https://graph.facebook.com/v18.0/${form.id}/leads`, {
                                    params: {
                                        access_token: accessToken,
                                        fields: 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,ad_account_id',
                                        filtering: JSON.stringify([{ 
                                            field: 'time_created', 
                                            operator: 'GREATER_THAN', 
                                            value: sinceTime 
                                        }]),
                                        limit: 100
                                    }
                                });

                                const leads = leadsResponse.data.data || [];
                                
                                if (leads.length > 0) {
                                    logger.info(`Found ${leads.length} leads for form ${form.name} (${account.pageName || account.pageId})`, 'MetaPolling', undefined, org.id);
                                    
                                    for (const leadData of leads) {
                                        try {
                                            // Attach form name so the lead service can use it as campaign name fallback
                                            leadData.form_name = form.name;

                                            // ✅ Route through MetaLeadGuard to prevent duplicates
                                            const { MetaLeadGuard } = await import('./metaLeadGuard');
                                            const lockAcquired = await MetaLeadGuard.acquireLock(leadData.id, org.id);
                                            if (!lockAcquired) {
                                                logger.info(`Lead ${leadData.id} already processed (webhook/dedup). Skipping.`, 'MetaPolling', undefined, org.id);
                                                continue;
                                            }
                                            try {
                                                await MetaLeadService.saveAndDistributeLead(org.id, account.pageId, leadData, form.id);
                                                MetaLeadGuard.markSuccess(leadData.id, org.id);
                                            } catch (saveErr: any) {
                                                MetaLeadGuard.markFailure(leadData.id, org.id, saveErr);
                                                throw saveErr;
                                            }
                                        } catch (leadErr: any) {
                                            if (!leadErr.message?.includes('already exists')) {
                                                logger.error(`Error processing lead ${leadData.id}: ${leadErr.message}`, leadErr, 'MetaPolling', undefined, org.id);
                                            }
                                        }
                                    }
                                }
                            } catch (formErr: any) {
                                const errorData = formErr.response?.data || formErr.message;
                                const errorCode = formErr.response?.data?.error?.code;
                                const errorString = JSON.stringify(errorData);

                                // If rate limited on a form, mark the whole page as rate-limited and bail out
                                if (errorCode === 80005 || errorString.includes('80005') || errorString.includes('too many leadgen api calls')) {
                                    markRateLimited(account.pageId);
                                    logger.error(`Page ${account.pageName || account.pageId} hit rate limit — stopping form loop for this page.`, formErr, 'MetaPolling', undefined, org.id);
                                    break; // stop processing more forms for this page
                                }

                                logger.error(`Failed to fetch leads for form ${form.id} (${org.name}): ${errorString}`, formErr, 'MetaPolling', undefined, org.id);
                                
                                // Send alert for critical auth errors
                                if (errorString.includes('Error validating access token') || (errorString.includes('OAuthException') && errorCode !== 80005)) {
                                    await this.sendAlertEmail(errorString, org.name, org.id);
                                }
                            }
                        }
                    } catch (accountErr: any) {
                        const errorData = accountErr.response?.data || accountErr.message;
                        const errorCode = accountErr.response?.data?.error?.code;
                        const errorString = JSON.stringify(errorData);

                        // Rate limit on the forms-list call itself
                        if (errorCode === 80005 || errorString.includes('80005') || errorString.includes('too many leadgen api calls')) {
                            markRateLimited(account.pageId);
                        } else {
                            logger.error(`Failed to poll Meta account ${account.pageId} (${org.name}): ${errorString}`, accountErr, 'MetaPolling', undefined, org.id);
                            if (errorString.includes('access token') || errorString.includes('permission')) {
                                await this.sendAlertEmail(errorString, org.name, org.id);
                            }
                        }
                    }
                }
            }
        } catch (error: any) {
            logger.error('Critical error in MetaPollingService:', error, 'MetaPolling');
        } finally {
            isPolling = false;
        }
    },
    
    /**
     * Sends a warning email if polling fails
     */
    async sendAlertEmail(errorMsg: string, orgName: string, orgId: string) {
        // Was hardcoded to a personal Gmail address - now reads from an env
        // var (with the same fallback preserved so nothing breaks if it's
        // never set), so this doesn't depend on one person's inbox.
        const alertRecipient = process.env.META_POLLING_ALERT_EMAIL || 'hostixpro@gmail.com';
        try {
            const { EmailService } = await import('./emailService');
            const subject = `⚠️ ALERT: Meta Lead Polling Failure - ${orgName}`;
            const html = `
                <div style="font-family: sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #d32f2f;">Meta Polling Integration Error</h2>
                    <p>The system encountered an error while polling for leads for <strong>${orgName}</strong>.</p>
                    <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; border-left: 5px solid #d32f2f;">
                        <code>${errorMsg}</code>
                    </div>
                    <p><strong>Org ID:</strong> ${orgId}</p>
                    <p>Please check the Meta integration settings and ensure the Page Access Token is still valid.</p>
                    <hr/>
                    <p style="font-size: 12px; color: #777;">This is an automated security alert from CRM Meta Service.</p>
                </div>
            `;

            await EmailService.sendEmail(alertRecipient, subject, html);
            logger.info(`Sent polling alert email to ${alertRecipient} for ${orgName}`, 'MetaPolling');
        } catch (e) {
            logger.error('Failed to send Meta alert email:', e, 'MetaPolling');
        }

        // Also alert the tenant's own admins — the internal inbox above is easy to miss,
        // and until this the org itself had zero signal that its Meta leads had stopped
        // flowing (this is what let edufolio's outage go unnoticed for weeks).
        await this.notifyOrgAdmins(orgId, orgName, errorMsg);
    },

    /**
     * In-app notification to the org's own admins when their Meta integration breaks.
     * Throttled per org so a page stuck in a broken state doesn't spam a notification
     * every 30 minutes forever.
     */
    async notifyOrgAdmins(orgId: string, orgName: string, errorMsg: string) {
        try {
            const lastAlertAt = orgAdminAlertCooldown.get(orgId);
            if (lastAlertAt && Date.now() - lastAlertAt < ORG_ADMIN_ALERT_COOLDOWN_MS) return;
            orgAdminAlertCooldown.set(orgId, Date.now());

            const { NotificationService } = await import('./notificationService');
            const admins = await prisma.user.findMany({
                where: { organisationId: orgId, role: { in: ['admin', 'super_admin'] }, isActive: true },
                select: { id: true }
            });
            for (const admin of admins) {
                await NotificationService.send(
                    admin.id,
                    'Meta Lead Sync Broken',
                    `We stopped receiving Facebook/Instagram leads for ${orgName} — the Meta integration needs to be reconnected in Settings → Integrations.`,
                    'error'
                );
            }
        } catch (e) {
            logger.error('Failed to notify org admins of Meta failure:', e, 'MetaPolling');
        }
    },

    /**
     * PING META API DAILY (CONSULTANT FALLBACK SCRIPT)
     * This hits the Marketing API (Insights & Campaigns) daily to satisfy 
     * Meta's App Review requirement of 15-day continuous API usage.
     * Ensures access isn't revoked during holidays/weekends when users aren't manually checking the CRM.
     * Note: Can be safely removed once App Review is fully approved or if no longer needed.
     */
    async pingMetaMarketingAPI() {
        logger.info('[MetaPolling] Starting daily Meta Marketing API ping...', 'MetaPolling');
        try {
            const organisations = await prisma.organisation.findMany({
                where: { isDeleted: false, status: { in: ['active', 'suspended'] } },
                select: { id: true, name: true, integrations: true }
            });

            for (const org of organisations) {
                const integrations = (org.integrations as any) || {};
                const metaAccounts = integrations.metaAccounts || [];
                
                if (integrations.meta && integrations.meta.connected) {
                    const exists = metaAccounts.some((acc: any) => acc.pageId === integrations.meta.pageId);
                    if (!exists) metaAccounts.push(integrations.meta);
                }

                for (const account of metaAccounts) {
                    if (!account.connected || !account.accessToken || !account.adAccountId) continue;

                    try {
                        const accessToken = decrypt(account.accessToken);
                        const adAccountId = account.adAccountId.startsWith('act_') ? account.adAccountId : `act_${account.adAccountId}`;
                        
                        // 1. Ping Insights API
                        await axios.get(`https://graph.facebook.com/v19.0/${adAccountId}/insights`, {
                            params: {
                                fields: 'spend,impressions,reach,ctr',
                                date_preset: 'last_7d',
                                access_token: accessToken
                            }
                        });

                        // 2. Ping Campaigns API
                        await axios.get(`https://graph.facebook.com/v19.0/${adAccountId}/campaigns`, {
                            params: {
                                fields: 'name,status,objective',
                                access_token: accessToken
                            }
                        });

                        logger.info(`[MetaPolling] Successfully pinged Marketing API for AdAccount ${adAccountId} (Org: ${org.name})`, 'MetaPolling', undefined, org.id);
                    } catch (err: any) {
                        const errorMsg = err.response?.data?.error?.message || err.message;
                        logger.error(`[MetaPolling] Failed to ping Marketing API for Org ${org.name}: ${errorMsg}`, err, 'MetaPolling', undefined, org.id);
                    }
                }
            }
            logger.info('[MetaPolling] Completed daily Meta Marketing API ping.', 'MetaPolling');
        } catch (error) {
            logger.error('[MetaPolling] Critical error during daily Meta ping:', error as Error, 'MetaPolling');
        }
    }
};

export default MetaPollingService;
