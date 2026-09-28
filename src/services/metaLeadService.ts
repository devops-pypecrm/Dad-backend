import axios from 'axios';
import prisma from '../config/prisma';
import { DistributionService } from './distributionService';
import { NotificationService } from './notificationService';
import { LeadSource, Prisma } from '../generated/client';
import { decrypt } from '../utils/encryption';
import { MetaLeadGuard } from './metaLeadGuard';

interface QueuedLead {
    leadgenId: string;
    pageId: string;
    adId?: string;
    formId?: string;
    attempts: number;
    nextRetry: number;
}

let leadQueue: QueuedLead[] = [];
let isProcessingQueue = false;

export const MetaLeadService = {
    /**
     * Processes an incoming lead from Meta Webhook
     */
    async processIncomingLead(leadgenId: string, pageId: string, adId?: string, formId?: string) {
        try {
            const META_API_VERSION = 'v18.0';
            console.log(`[MetaLeadService] Processing lead ${leadgenId} from Page ${pageId}...`);

            // 1. Find ALL organisations connected to this Page ID
            const candidates = await prisma.organisation.findMany({
                where: {
                    isDeleted: false,
                    OR: [
                        { integrations: { path: ['meta', 'pageId'], equals: pageId } },
                        { integrations: { path: ['facebook_payload', 'pageId'], equals: pageId } },
                        { integrations: { path: ['metaAccounts'], array_contains: [{ pageId: pageId }] } } 
                    ]
                }
            });

            const allCandidates = [...candidates];
            if (allCandidates.length === 0) {
                const potentialOrgs = await prisma.organisation.findMany({
                    where: { isDeleted: false, integrations: { not: Prisma.JsonNull } }
                });
                const dynamicMatches = potentialOrgs.filter(o => {
                    const accounts = (o.integrations as any)?.metaAccounts;
                    return Array.isArray(accounts) && accounts.some((acc: any) => acc.pageId === pageId);
                });
                dynamicMatches.forEach(dm => {
                    if (!allCandidates.find(c => c.id === dm.id)) allCandidates.push(dm);
                });
            }

            if (allCandidates.length === 0) {
                console.error(`[MetaLeadService] No organisation found with Meta Page ID: ${pageId}.`);
                return;
            }

            // 2. Fetch Lead Details
            let metaLeadData: any = null;
            let fetchedSuccess = false;
            let lastError: any = null;

            for (const candidate of allCandidates) {
                const integrations = (candidate.integrations as any) || {};
                const accounts = [...(integrations.metaAccounts || [])];
                if (integrations.meta) accounts.push(integrations.meta);
                const matchedAccount = accounts.find((acc: any) => acc.pageId === pageId);

                if (matchedAccount?.accessToken) {
                    try {
                        const accessToken = decrypt(matchedAccount.accessToken);
                        const response = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/${leadgenId}`, {
                            params: {
                                access_token: accessToken,
                                fields: 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id'
                            }
                        });
                        metaLeadData = response.data;
                        fetchedSuccess = true;
                        break;
                    } catch (e: any) {
                        lastError = e;
                        console.warn(`[MetaLeadService] Token for org ${candidate.id} failed, trying next...`);
                    }
                }
            }

            // 3. RETRY QUEUE LOGIC
            if (!fetchedSuccess || !metaLeadData) {
                const errorMsg = lastError?.response?.data?.error?.message || lastError?.message;
                const isRateLimit = errorMsg?.includes('rate') || lastError?.response?.status === 400;

                if (isRateLimit) {
                    console.warn(`[MetaLeadService] Rate limited by Meta. Adding lead ${leadgenId} to retry queue.`);
                    this.addToQueue(leadgenId, pageId, adId, formId);
                } else {
                    console.error(`[MetaLeadService] Failed to fetch lead data from Meta for lead ${leadgenId}: ${errorMsg}`);

                    // An auth/token failure here means the webhook path drops this lead with
                    // zero visibility to the tenant. The 30-min polling fallback alerts on the
                    // same class of error, but a webhook-only failure between polls previously
                    // had no alert at all — surface it to org admins the same way polling does.
                    const isAuthError = errorMsg?.includes('OAuthException') || errorMsg?.includes('access token') || errorMsg?.includes('Error validating');
                    if (isAuthError) {
                        const { MetaPollingService } = await import('./metaPollingService');
                        for (const candidate of allCandidates) {
                            await MetaPollingService.notifyOrgAdmins(candidate.id, candidate.name, errorMsg);
                        }
                    }
                }
                return;
            }

            // 4. Process the lead for EACH matching organisation
            for (const org of allCandidates) {
                // ✅ GUARD: Acquire idempotency lock before processing
                // This prevents duplicate creation if webhook + polling both fire for the same lead
                const lockAcquired = await MetaLeadGuard.acquireLock(leadgenId, org.id);
                if (!lockAcquired) continue; // Already being processed or already saved

                try {
                    const integrations = (org.integrations as any) || {};
                    const accounts = [...(integrations.metaAccounts || [])];
                    if (integrations.meta) accounts.push(integrations.meta);
                    const matchedAccount = accounts.find((acc: any) => acc.pageId === pageId);

                    if (!matchedAccount || !matchedAccount.connected) {
                        console.log(`[MetaLeadService] Skipping Org ${org.id}: Page ${pageId} is not connected/enabled for lead sync.`);
                        MetaLeadGuard.releaseLock(leadgenId, org.id);
                        continue;
                    }

                    // Ad-account whitelist validation now lives inside saveAndDistributeLead itself
                    // (see there for why) — this is the one chokepoint every entry path funnels
                    // through (webhook here, the 30-min polling fallback, and manual backfills),
                    // so putting the check there instead of duplicating it per-caller means no
                    // future caller can silently bypass it the way polling did before this fix.
                    await this.saveAndDistributeLead(org.id, pageId, metaLeadData, formId, adId);
                    MetaLeadGuard.markSuccess(leadgenId, org.id);
                } catch (orgErr: any) {
                    MetaLeadGuard.markFailure(leadgenId, org.id, orgErr);
                    console.error(`[MetaLeadService] Error processing for Org ${org.id}:`, orgErr.message);
                }
            }
        } catch (error: any) {
            console.error('[MetaLeadService] Error:', error.response?.data || error.message);
            throw error;
        }
    },

    /**
     * Add lead to retry queue with backoff
     */
    addToQueue(leadgenId: string, pageId: string, adId?: string, formId?: string, attempts = 0) {
        if (attempts >= 5) {
            console.error(`[MetaLeadService] Max retries reached for lead ${leadgenId}. Giving up.`);
            return;
        }

        // Exponential backoff: 1m, 2m, 4m, 8m, 16m
        const delay = Math.pow(2, attempts) * 60 * 1000;
        
        const alreadyInQueue = leadQueue.some(l => l.leadgenId === leadgenId);
        if (alreadyInQueue && attempts === 0) return; // Don't add fresh if already retrying

        leadQueue.push({
            leadgenId,
            pageId,
            adId,
            formId,
            attempts: attempts + 1,
            nextRetry: Date.now() + delay
        });

        console.log(`[MetaLeadService] Lead ${leadgenId} scheduled for retry #${attempts + 1} in ${delay / 1000}s`);
        this.startQueueProcessor();
    },

    /**
     * Periodically check and process the queue
     */
    startQueueProcessor() {
        if (isProcessingQueue) return;
        isProcessingQueue = true;

        const timer = setInterval(async () => {
            if (leadQueue.length === 0) {
                clearInterval(timer);
                isProcessingQueue = false;
                return;
            }

            const now = Date.now();
            const readyToProcess = leadQueue.filter(l => l.nextRetry <= now);
            leadQueue = leadQueue.filter(l => l.nextRetry > now);

            for (const item of readyToProcess) {
                console.log(`[MetaLeadService] Retrying lead ${item.leadgenId} (Attempt ${item.attempts})...`);
                try {
                    // Try to process again
                    await this.processIncomingLead(item.leadgenId, item.pageId, item.adId, item.formId);
                } catch (err) {
                    // processIncomingLead will re-add to queue if it fails with rate limit
                }
            }
        }, 30000); // Check every 30s
    },

    /**
     * Internal helper to save and distribute a lead
     */
    async saveAndDistributeLead(orgId: string, pageId: string, metaLeadData: any, formId?: string, adId?: string) {
        try {
            const leadgenId = metaLeadData.id;

            // Validate lead data structure before processing
            const validationError = MetaLeadGuard.validateLeadData(metaLeadData);
            if (validationError) {
                console.error(`[MetaLeadService] Invalid lead data for Org ${orgId}: ${validationError}`);
                return;
            }
            
            // 1. Final DB dedup check (last line of defence)
            const existing = await prisma.lead.findFirst({
                where: { 
                    organisationId: orgId, 
                    sourceDetails: { path: ['metaLeadgenId'], equals: leadgenId }
                }
            });

            if (existing) {
                console.log(`[MetaLeadService] Lead ${leadgenId} already exists in DB for Org ${orgId} (Lead ID: ${existing.id}). Skipping save.`);
                return;
            }

            // Fetched once, used by both the per-campaign filter and the ad-account check below.
            const orgForFilter = await prisma.organisation.findUnique({
                where: { id: orgId },
                select: { integrations: true }
            });
            const orgIntegrations = (orgForFilter?.integrations as any) || {};

            // 1b. Per-campaign sync filter — an org can opt specific campaigns OUT of lead
            // sync (Ads Manager checkbox) even while the ad account/page stays connected.
            // Absence from this list means "still enabled" so existing orgs/campaigns are
            // unaffected until someone explicitly unchecks one.
            if (metaLeadData.campaign_id) {
                const disabledCampaignIds = (orgIntegrations?.meta?.disabledLeadSyncCampaignIds as string[]) || [];
                if (disabledCampaignIds.includes(String(metaLeadData.campaign_id))) {
                    console.log(`[MetaLeadService] Lead ${leadgenId} skipped — campaign ${metaLeadData.campaign_id} is disabled for lead sync in Org ${orgId}.`);
                    return;
                }
            }

            // 1b-2. Per-account campaign ALLOWLIST — the inverse of the opt-out list above.
            // Some orgs share a Page with unrelated campaigns run through the same Facebook
            // Business/ad account on Meta's side (e.g. Edufolio's Page is also used to run
            // wholly unrelated "IQED"/"UNIVERSITY" campaigns for a different business) — the
            // ad-account whitelist below can't distinguish them since they're the same account.
            // When a metaAccounts[] entry sets allowedCampaignIds, ONLY those campaign IDs may
            // sync through that specific page for this org; everything else is blocked, even if
            // it shares the same ad account. Absence of this field means "no restriction" so
            // every other org/account is unaffected.
            {
                const accountsForAllowlist = [...(orgIntegrations.metaAccounts || [])];
                if (orgIntegrations.meta) accountsForAllowlist.push(orgIntegrations.meta);
                const matchedAccountForAllowlist = accountsForAllowlist.find((acc: any) => acc.pageId === pageId);
                const allowedCampaignIds = (matchedAccountForAllowlist?.allowedCampaignIds as string[]) || [];

                if (allowedCampaignIds.length > 0) {
                    // Meta doesn't always return campaign_id on a lead object (seen even while
                    // campaign_name is present, e.g. "IQED" leads coming through with a null
                    // campaign_id) — gating this check behind `if (metaLeadData.campaign_id)`
                    // meant every such lead silently skipped the allowlist entirely and leaked
                    // through. For a strictly-allowlisted account, "unverifiable" must mean
                    // "not allowed", not "let it through" — same fail-closed principle already
                    // used for the ad-account whitelist's permission-denied case below.
                    if (!metaLeadData.campaign_id) {
                        console.log(`[MetaLeadService] Lead ${leadgenId} skipped — no campaign_id on the lead payload and page ${pageId} in Org ${orgId} is restricted to specific campaigns.`);
                        return;
                    }
                    if (!allowedCampaignIds.includes(String(metaLeadData.campaign_id))) {
                        console.log(`[MetaLeadService] Lead ${leadgenId} skipped — campaign ${metaLeadData.campaign_id} is not in the allowed campaign list for page ${pageId} in Org ${orgId}.`);
                        return;
                    }
                }
            }

            // 1b-3. Per-form opt-out — confirmed against Meta's Graph API directly (both the
            // single-leadgen GET and the form's /leads list edge) that campaign_id/campaign_name/
            // ad_id are simply never returned at all for at least one of Edufolio's "IQED"-branded
            // forms on the MT Vlog page, even though allowedCampaignIds was already configured and
            // should fail-closed on a missing campaign_id (see 1b-2 above). form_id, unlike
            // campaign_id, IS always present on every lead payload from every path (webhook,
            // polling, and the leadgen_forms listing used to build this data) — so filtering by the
            // handful of "wrong business" form IDs is the one mechanism that can't silently degrade
            // to a no-op the way campaign-based filtering can for forms Meta won't attribute.
            const formIdForFilter = metaLeadData.form_id || formId;
            if (formIdForFilter) {
                const accountsForFormFilter = [...(orgIntegrations.metaAccounts || [])];
                if (orgIntegrations.meta) accountsForFormFilter.push(orgIntegrations.meta);
                const matchedAccountForFormFilter = accountsForFormFilter.find((acc: any) => acc.pageId === pageId);
                const disabledFormIds = (matchedAccountForFormFilter?.disabledLeadSyncFormIds as string[]) || [];
                if (disabledFormIds.includes(String(formIdForFilter))) {
                    console.log(`[MetaLeadService] Lead ${leadgenId} skipped — form ${formIdForFilter} is disabled for lead sync on page ${pageId} in Org ${orgId}.`);
                    return;
                }
            }

            // 1c. Ad-account whitelist — the single enforcement point for this check, so every
            // caller (webhook, the 30-min polling fallback, manual backfills) is covered uniformly.
            // A lead's own object never exposes ad_account_id (Meta rejects that field there), and
            // the polling path's /leads edge *does* include it — so only resolve it ourselves
            // (via the ad object, which does expose account_id) when it's not already present.
            {
                const accounts = [...(orgIntegrations.metaAccounts || [])];
                if (orgIntegrations.meta) accounts.push(orgIntegrations.meta);
                const matchedAccount = accounts.find((acc: any) => acc.pageId === pageId);

                const enabledAccounts = (matchedAccount?.enabledLeadSyncAccounts as string[]) || [];
                const globalEnabledAccounts = (orgIntegrations.meta?.enabledLeadSyncAccounts as string[]) || [];
                const allEnabledAccounts = [...new Set([...enabledAccounts, ...globalEnabledAccounts])];
                const mainAdAccountId = matchedAccount?.adAccountId ? String(matchedAccount.adAccountId) : null;
                const hasAnyFilter = allEnabledAccounts.length > 0 || !!mainAdAccountId;

                if (hasAnyFilter && matchedAccount?.accessToken) {
                    let resolvedAdAccountId = metaLeadData.ad_account_id || metaLeadData.ad?.account_id;
                    let lookupPermissionDenied = false;
                    const adIdForLookup = metaLeadData.ad_id || adId;

                    if (!resolvedAdAccountId && adIdForLookup) {
                        try {
                            const accessToken = decrypt(matchedAccount.accessToken);
                            const adResponse = await axios.get(`https://graph.facebook.com/v18.0/${adIdForLookup}`, {
                                params: { access_token: accessToken, fields: 'account_id' }
                            });
                            resolvedAdAccountId = adResponse.data.account_id;
                        } catch (adErr: any) {
                            const adErrMsg = adErr.response?.data?.error?.message || adErr.message;
                            console.warn(`[MetaLeadService] Could not resolve ad_account_id for ad ${adIdForLookup}:`, adErrMsg);
                            // A token that can manage its own connected ad account's leads should
                            // always be able to read its own ad's account_id. A permission error here
                            // specifically is the exact signature of an ad belonging to a *different*,
                            // unconnected ad account (confirmed manually for the cross-account
                            // "Edufolio July 22" / "MT May 12" leads) — so for a strictly-filtered org,
                            // "unverifiable" must mean "foreign", not "let it through".
                            if (adErr.response?.data?.error?.code === 100) {
                                lookupPermissionDenied = true;
                            }
                        }
                    }

                    if (resolvedAdAccountId) {
                        const strAdAccountId = String(resolvedAdAccountId);
                        const normalizedLeadAdId = strAdAccountId.startsWith('act_') ? strAdAccountId : `act_${strAdAccountId}`;

                        const isWhitelisted = allEnabledAccounts.some((id: string) => {
                            const strId = String(id);
                            const normalizedId = strId.startsWith('act_') ? strId : `act_${strId}`;
                            return normalizedId === normalizedLeadAdId;
                        });
                        const isMainMatch = mainAdAccountId && (
                            (mainAdAccountId.startsWith('act_') ? mainAdAccountId : `act_${mainAdAccountId}`) === normalizedLeadAdId
                        );

                        if (!isWhitelisted && !isMainMatch) {
                            console.warn(`[MetaLeadService] Blocking cross-account lead ${leadgenId} (AdAccount: ${normalizedLeadAdId}) for Org ${orgId}. MainAcc: ${mainAdAccountId}, Whitelist: [${allEnabledAccounts.join(',')}]`);
                            return;
                        }
                    } else if (lookupPermissionDenied) {
                        console.warn(`[MetaLeadService] Blocking lead ${leadgenId} for Org ${orgId}: ad account ownership could not be verified (permission denied) and this org has ad-account filtering configured.`);
                        return;
                    } else {
                        console.log(`[MetaLeadService] Lead ${leadgenId} has no resolvable ad_account_id. Proceeding without account filtering for Org ${orgId}.`);
                    }
                }
            }

            // 2. Map Field Data
            const fieldMap: Record<string, string> = {};
            // Preserves every question's original (not lowercased) label
            // alongside its answer - used below to keep whatever the
            // best-guess matching doesn't recognize, instead of silently
            // dropping it. There's no per-form manual mapping UI yet; this is
            // the safety net until one exists.
            const rawFormFields: { label: string; value: string }[] = [];
            metaLeadData.field_data.forEach((field: any) => {
                if (field.values && field.values.length > 0) {
                    fieldMap[field.name.toLowerCase()] = field.values[0];
                    rawFormFields.push({ label: field.name, value: field.values[0] });
                }
            });

            const getField = (keys: string[]) => {
                for (const key of keys) {
                    if (fieldMap[key]) return fieldMap[key];
                }
                return '';
            };

            const NAME_KEYS = ['full name', 'full_name', 'name', 'first_name', 'first name'];
            const PHONE_KEYS = ['phone', 'phone number', 'phone_number', 'mobile', 'mobile number'];
            const EMAIL_KEYS = ['email', 'email address', 'email_address'];
            const CITY_KEYS = ['city', 'location'];
            const COMPANY_KEYS = ['company', 'organization', 'company name'];
            const RECOGNIZED_KEYS = new Set([...NAME_KEYS, ...PHONE_KEYS, ...EMAIL_KEYS, ...CITY_KEYS, ...COMPANY_KEYS]);

            const leadData = {
                full_name: getField(NAME_KEYS),
                phone: getField(PHONE_KEYS),
                email: getField(EMAIL_KEYS),
                city: getField(CITY_KEYS),
                company: getField(COMPANY_KEYS),
                campaign_name: metaLeadData.campaign_name || metaLeadData.ad_name || metaLeadData.form_name || `Form: ${metaLeadData.form_id || formId}` || 'Meta Lead'
            };

            // Any question on the form whose label didn't match one of the
            // recognized synonyms above (e.g. "Preferred course", "Budget
            // range") - kept verbatim in enquiryAbout and sourceDetails.
            // formFields rather than lost, since there's nowhere else on the
            // Lead record a rep would see it otherwise.
            const unrecognizedFields = rawFormFields.filter((f) => !RECOGNIZED_KEYS.has(f.label.toLowerCase()));
            const unrecognizedSummary = unrecognizedFields.map((f) => `${f.label}: ${f.value}`).join('; ');

            const targetBranchId = await DistributionService.resolveBranchForMetaPage(orgId, pageId);

            const crmData = {
                firstName: leadData.full_name || 'Meta Lead',
                lastName: '',
                phone: leadData.phone || '',
                email: leadData.email || undefined,
                // city/company were already being extracted above but never
                // actually attached to the lead - fixed alongside the
                // unrecognized-field capture below since both were the same
                // class of "answered but silently lost" bug.
                company: leadData.company || undefined,
                enquiryAbout: [leadData.city, unrecognizedSummary].filter(Boolean).join(' | ') || undefined,
                organisationId: orgId,
                source: LeadSource.meta_leadgen,
                sourceDetails: {
                    metaLeadgenId: leadgenId,
                    metaFormId: formId || metaLeadData.form_id,
                    metaPageId: pageId,
                    metaAdId: adId || metaLeadData.ad_id,
                    adName: metaLeadData.ad_name,
                    campaignId: metaLeadData.campaign_id,
                    campaignName: leadData.campaign_name,
                    metaCreatedTime: metaLeadData.created_time,
                    // Every question this form actually asked, verbatim - the
                    // full record a future per-form field-mapping UI would
                    // read from, and a fallback a rep can still find in the
                    // raw data even before that UI exists.
                    formFields: rawFormFields
                }
            };

            const { DuplicateLeadService } = await import('./duplicateLeadService');
            const duplicateCheck = await DuplicateLeadService.checkDuplicate(
                crmData.phone, 
                crmData.email, 
                orgId, 
                targetBranchId || undefined
            );

            if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
                await DuplicateLeadService.handleReEnquiry(duplicateCheck.existingLead, crmData, orgId);
                return;
            }

            const lead = await prisma.lead.create({
                data: {
                    ...crmData,
                    branchId: targetBranchId
                }
            });

            await DistributionService.assignLead(lead, orgId);

            const admins = await prisma.user.findMany({
                where: { organisationId: orgId, role: { in: ['admin', 'super_admin'] }, isActive: true },
                select: { id: true }
            });
            for (const admin of admins) {
                await NotificationService.send(admin.id, 'New Meta Lead', `New lead: ${crmData.firstName}`, 'info');
            }
        } catch (error: any) {
            console.error(`[MetaLeadService] Error saving lead ${metaLeadData.id} for Org ${orgId}:`, error.message);
            throw error;
        }
    }
};

export default MetaLeadService;
