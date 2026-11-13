import axios from 'axios';
import crypto from 'crypto';
import prisma from '../config/prisma';
import { encrypt, decrypt } from '../utils/encryption';
import { LeadSource } from '../generated/client';

/**
 * Google Ads integration (mirrors the Meta integration, stored in Organisation.integrations.googleAds):
 *  1. OAuth connect (scope `adwords`) -> encrypted refresh token, pick the Google Ads customer account.
 *  2. Lead Form Extension webhook -> leads land in the CRM with source `google_ads`.
 *  3. Campaign / performance reporting through the Google Ads API (GAQL).
 *  4. Offline conversions: send "won" deals back to Google by GCLID so Smart Bidding learns from real sales.
 *
 * Platform-level env (one set for the whole product, owned by PypeCRM's Google Ads manager (MCC) account):
 *   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID/SECRET (falls back to GOOGLE_CLIENT_ID/SECRET),
 *   GOOGLE_ADS_REDIRECT_URI, optional GOOGLE_ADS_API_VERSION, GOOGLE_ADS_LOGIN_CUSTOMER_ID.
 */

export const GOOGLE_ADS_SCOPES = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/userinfo.email'];

const apiVersion = () => process.env.GOOGLE_ADS_API_VERSION || 'v21';
const adsBase = () => `https://googleads.googleapis.com/${apiVersion()}`;
const clientId = () => process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = () => process.env.GOOGLE_ADS_REDIRECT_URI || `${process.env.CLIENT_URL || 'http://localhost:5173'}/settings/google-ads-callback`;
const digits = (s: any) => String(s || '').replace(/\D/g, '');

export const isPlatformConfigured = () => !!(clientId() && clientSecret() && process.env.GOOGLE_ADS_DEVELOPER_TOKEN);

const tokenCache = new Map<string, { token: string; exp: number }>();

async function readConfig(orgId: string): Promise<{ integrations: any; cfg: any }> {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { integrations: true } });
    const integrations: any = (org?.integrations as any) || {};
    return { integrations, cfg: integrations.googleAds || {} };
}

async function writeConfig(orgId: string, patch: Record<string, any> | null) {
    const { integrations, cfg } = await readConfig(orgId);
    if (patch === null) delete integrations.googleAds;
    else integrations.googleAds = { ...cfg, ...patch };
    await prisma.organisation.update({ where: { id: orgId }, data: { integrations } });
    tokenCache.delete(orgId);
}

const signState = (orgId: string, userId: string) => {
    const body = `${orgId}.${userId}`;
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update(body).digest('hex').slice(0, 32);
    return `${body}.${sig}`;
};

export const GoogleAdsService = {
    /** Consent URL. State is signed so the callback can't be replayed by another user/org. */
    getAuthUrl(orgId: string, userId: string): string {
        const p = new URLSearchParams({
            client_id: clientId(),
            redirect_uri: redirectUri(),
            response_type: 'code',
            scope: GOOGLE_ADS_SCOPES.join(' '),
            access_type: 'offline',
            prompt: 'consent', // always returns a refresh token
            include_granted_scopes: 'true',
            state: signState(orgId, userId)
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
    },

    verifyState(state: string, orgId: string, userId: string): boolean {
        return !!state && state === signState(orgId, userId);
    },

    /** Exchange the OAuth code, store the encrypted refresh token and list the accounts the user can reach. */
    async handleCallback(orgId: string, code: string) {
        const tok = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
            code, client_id: clientId(), client_secret: clientSecret(), redirect_uri: redirectUri(), grant_type: 'authorization_code'
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const { refresh_token, access_token, expires_in } = tok.data;
        if (!refresh_token) throw new Error('Google did not return a refresh token. Remove PypeCRM from your Google account permissions and connect again.');

        let email = '';
        try {
            const u = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
            email = u.data?.email || '';
        } catch { /* email is cosmetic */ }

        const existing = (await readConfig(orgId)).cfg;
        await writeConfig(orgId, {
            connected: true,
            email,
            refreshToken: encrypt(refresh_token),
            connectedAt: new Date().toISOString(),
            webhookKey: existing.webhookKey || crypto.randomBytes(24).toString('hex')
        });
        tokenCache.set(orgId, { token: access_token, exp: Date.now() + (expires_in - 60) * 1000 });
        return { email, accounts: await this.listAccounts(orgId) };
    },

    async getAccessToken(orgId: string): Promise<string> {
        const hit = tokenCache.get(orgId);
        if (hit && hit.exp > Date.now()) return hit.token;
        const { cfg } = await readConfig(orgId);
        if (!cfg.connected || !cfg.refreshToken) throw new Error('Google Ads is not connected');
        try {
            const r = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
                client_id: clientId(), client_secret: clientSecret(), refresh_token: decrypt(cfg.refreshToken), grant_type: 'refresh_token'
            }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            tokenCache.set(orgId, { token: r.data.access_token, exp: Date.now() + (r.data.expires_in - 60) * 1000 });
            return r.data.access_token;
        } catch (e: any) {
            // Revoked / expired grant: flag it so the UI asks the admin to reconnect.
            if (e.response?.data?.error === 'invalid_grant') await writeConfig(orgId, { needsReconnect: true });
            throw e;
        }
    },

    async headers(orgId: string, loginCustomerId?: string) {
        const { cfg } = await readConfig(orgId);
        const h: Record<string, string> = {
            Authorization: `Bearer ${await this.getAccessToken(orgId)}`,
            'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
            'Content-Type': 'application/json'
        };
        const login = digits(loginCustomerId || cfg.loginCustomerId || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
        if (login) h['login-customer-id'] = login;
        return h;
    },

    /** Customer accounts the connected Google user can access (id + descriptive name). */
    async listAccounts(orgId: string) {
        const h = await this.headers(orgId, '');
        delete h['login-customer-id'];
        const list = await axios.get(`${adsBase()}/customers:listAccessibleCustomers`, { headers: h });
        const names: string[] = list.data?.resourceNames || [];
        const out: any[] = [];
        for (const rn of names) {
            const id = rn.split('/')[1];
            try {
                const r = await axios.post(`${adsBase()}/customers/${id}/googleAds:search`,
                    { query: 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 1' },
                    { headers: { ...h, 'login-customer-id': id } });
                const c = r.data?.results?.[0]?.customer || {};
                out.push({ id, name: c.descriptiveName || id, isManager: !!c.manager, currency: c.currencyCode, timeZone: c.timeZone });
            } catch {
                out.push({ id, name: id, isManager: false, inaccessible: true });
            }
        }
        return out;
    },

    /** Save which customer account (and MCC, if the account sits under one) the org uses. */
    async selectAccount(orgId: string, body: { customerId: string; customerName?: string; loginCustomerId?: string; conversionActionId?: string; branchId?: string | null; currency?: string }) {
        const patch: any = {
            customerId: digits(body.customerId),
            customerName: body.customerName || '',
            loginCustomerId: digits(body.loginCustomerId) || undefined,
            needsReconnect: false
        };
        if (body.conversionActionId !== undefined) patch.conversionActionId = digits(body.conversionActionId) || undefined;
        if (body.branchId !== undefined) patch.branchId = body.branchId || undefined;
        if (body.currency) patch.currency = body.currency;
        await writeConfig(orgId, patch);
        return patch;
    },

    async regenerateWebhookKey(orgId: string) {
        const key = crypto.randomBytes(24).toString('hex');
        await writeConfig(orgId, { webhookKey: key });
        return key;
    },

    async disconnect(orgId: string) {
        const { cfg } = await readConfig(orgId);
        if (cfg.refreshToken) {
            try { await axios.post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token: decrypt(cfg.refreshToken) }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch { /* best effort */ }
        }
        await writeConfig(orgId, null);
    },

    async getStatus(orgId: string) {
        const { cfg } = await readConfig(orgId);
        return {
            platformConfigured: isPlatformConfigured(),
            connected: !!cfg.connected,
            needsReconnect: !!cfg.needsReconnect,
            email: cfg.email,
            customerId: cfg.customerId,
            customerName: cfg.customerName,
            loginCustomerId: cfg.loginCustomerId,
            conversionActionId: cfg.conversionActionId,
            branchId: cfg.branchId,
            webhookKey: cfg.webhookKey,
            lastLeadAt: cfg.lastLeadAt,
            lastTestAt: cfg.lastTestAt,
            lastConversion: cfg.lastConversion,
            connectedAt: cfg.connectedAt
        };
    },

    // ---------------------------------------------------------------- reporting

    async runQuery(orgId: string, query: string) {
        const { cfg } = await readConfig(orgId);
        if (!cfg.customerId) throw new Error('Select a Google Ads account first');
        const r = await axios.post(`${adsBase()}/customers/${cfg.customerId}/googleAds:search`, { query }, { headers: await this.headers(orgId) });
        return r.data?.results || [];
    },

    /** Campaigns with spend and results for a date range (YYYY-MM-DD). Cost is converted from micros. */
    async getCampaigns(orgId: string, startDate?: string, endDate?: string) {
        const range = startDate && endDate ? `segments.date BETWEEN '${startDate}' AND '${endDate}'` : 'segments.date DURING LAST_30_DAYS';
        const rows = await this.runQuery(orgId,
            `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                    metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc
             FROM campaign WHERE ${range} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 200`);
        return rows.map((r: any) => ({
            id: r.campaign.id,
            name: r.campaign.name,
            status: r.campaign.status,
            channel: r.campaign.advertisingChannelType,
            impressions: Number(r.metrics?.impressions || 0),
            clicks: Number(r.metrics?.clicks || 0),
            cost: Number(r.metrics?.costMicros || 0) / 1e6,
            conversions: Number(r.metrics?.conversions || 0),
            ctr: Number(r.metrics?.ctr || 0),
            avgCpc: Number(r.metrics?.averageCpc || 0) / 1e6
        }));
    },

    /** Conversion actions the account can upload to (used to pick the "won deal" action). */
    async getConversionActions(orgId: string) {
        const rows = await this.runQuery(orgId,
            `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status
             FROM conversion_action WHERE conversion_action.status = 'ENABLED'`);
        return rows.map((r: any) => ({ id: r.conversionAction.id, name: r.conversionAction.name, type: r.conversionAction.type }));
    },

    // ---------------------------------------------------------------- lead form webhook

    async findOrgByWebhookKey(key: string): Promise<string | null> {
        if (!key || key.length < 16) return null;
        const org = await prisma.organisation.findFirst({
            where: { integrations: { path: ['googleAds', 'webhookKey'], equals: key } },
            select: { id: true }
        });
        return org?.id || null;
    },

    /**
     * Handles one Google Lead Form Extension payload. Always safe to call twice for the same lead
     * (Google retries on non-200), dedup is by Google's lead_id.
     */
    async handleLeadFormPayload(orgId: string, payload: any): Promise<{ status: string; leadId?: string }> {
        const col = (...ids: string[]) => {
            const f = (payload.user_column_data || []).find((c: any) => ids.includes(String(c.column_id || '').toUpperCase()));
            return (f?.string_value || '').toString().trim();
        };

        if (payload.is_test) {
            await writeConfig(orgId, { lastTestAt: new Date().toISOString() });
            return { status: 'test_received' };
        }

        const googleLeadId = String(payload.lead_id || '');
        if (googleLeadId) {
            const dup = await prisma.lead.findFirst({
                where: { organisationId: orgId, sourceDetails: { path: ['googleLeadId'], equals: googleLeadId } },
                select: { id: true }
            });
            if (dup) return { status: 'duplicate', leadId: dup.id };
        }

        const fullName = col('FULL_NAME');
        const first = col('FIRST_NAME') || fullName.split(/\s+/)[0] || 'Google Lead';
        const last = col('LAST_NAME') || (fullName.includes(' ') ? fullName.split(/\s+/).slice(1).join(' ') : '');
        const phone = col('PHONE_NUMBER');
        const email = col('EMAIL');
        const city = col('CITY');
        const KNOWN = new Set(['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'EMAIL', 'CITY', 'COMPANY_NAME']);
        const extra = (payload.user_column_data || []).filter((c: any) => !KNOWN.has(String(c.column_id || '').toUpperCase()) && c.string_value)
            .map((c: any) => `${c.column_name || c.column_id}: ${c.string_value}`).join('; ');

        // Campaign name for the CRM columns/assignment rules: look it up once per campaign id, fall back to the id.
        let campaignName = payload.campaign_name || '';
        if (!campaignName && payload.campaign_id) campaignName = await this.lookupCampaignName(orgId, String(payload.campaign_id));

        const { cfg } = await readConfig(orgId);
        const crmData: any = {
            firstName: first,
            lastName: last,
            phone,
            email: email || undefined,
            company: col('COMPANY_NAME') || undefined,
            enquiryAbout: [city, extra].filter(Boolean).join(' | ') || undefined,
            organisationId: orgId,
            source: LeadSource.google_ads,
            sourceDetails: {
                googleLeadId,
                gclid: payload.gcl_id || undefined,
                campaignId: payload.campaign_id ? String(payload.campaign_id) : undefined,
                campaignName: campaignName || (payload.campaign_id ? `Google Campaign ${payload.campaign_id}` : 'Google Ads'),
                adGroupId: payload.adgroup_id ? String(payload.adgroup_id) : undefined,
                creativeId: payload.creative_id ? String(payload.creative_id) : undefined,
                formId: payload.form_id ? String(payload.form_id) : undefined,
                formFields: payload.user_column_data
            }
        };

        const { ContactLinkService } = await import('./contactLinkService');
        if (phone && await ContactLinkService.isBlocked(orgId, phone)) return { status: 'blocked' };

        const { DuplicateLeadService } = await import('./duplicateLeadService');
        const dupCheck = await DuplicateLeadService.checkDuplicate(phone, email, orgId, cfg.branchId || undefined);
        if (dupCheck.isDuplicate && dupCheck.existingLead) {
            await DuplicateLeadService.handleReEnquiry(dupCheck.existingLead, crmData, orgId);
            await writeConfig(orgId, { lastLeadAt: new Date().toISOString() });
            return { status: 're_enquiry', leadId: dupCheck.existingLead.id };
        }

        const lead = await prisma.lead.create({ data: { ...crmData, branchId: cfg.branchId || undefined } });
        const { DistributionService } = await import('./distributionService');
        await DistributionService.assignLead(lead, orgId);

        const { NotificationService } = await import('./notificationService');
        const admins = await prisma.user.findMany({
            where: { organisationId: orgId, role: { in: ['admin', 'super_admin'] }, isActive: true }, select: { id: true }
        });
        for (const a of admins) await NotificationService.send(a.id, 'New Google Ads Lead', `New lead: ${first}`, 'info');

        await writeConfig(orgId, { lastLeadAt: new Date().toISOString() });
        return { status: 'created', leadId: lead.id };
    },

    async lookupCampaignName(orgId: string, campaignId: string): Promise<string> {
        try {
            const rows = await this.runQuery(orgId, `SELECT campaign.name FROM campaign WHERE campaign.id = ${digits(campaignId)} LIMIT 1`);
            return rows[0]?.campaign?.name || '';
        } catch { return ''; }
    },

    // ---------------------------------------------------------------- offline conversions

    /**
     * Uploads a click conversion (a won deal) for a lead that arrived with a GCLID.
     * Needs a conversion action of type "Import -> CRM / other data sources" in Google Ads.
     * Safe to call repeatedly: orderId makes Google ignore duplicates.
     */
    async uploadWonConversion(orgId: string, leadId: string, opts: { value?: number; currency?: string; orderId: string; at?: Date }) {
        const { cfg } = await readConfig(orgId);
        if (!cfg.connected || !cfg.customerId || !cfg.conversionActionId) return { skipped: 'not_configured' };

        const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { sourceDetails: true } });
        const sd: any = lead?.sourceDetails || {};
        const gclid = sd.gclid || sd.gcl_id || sd.rawPayload?.gclid;
        if (!gclid) return { skipped: 'no_gclid' };

        const when = (opts.at || new Date());
        // Google wants "yyyy-mm-dd hh:mm:ss+|-hh:mm" in the account's time zone; UTC is always valid.
        const pad = (n: number) => String(n).padStart(2, '0');
        const conversionDateTime = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}+00:00`;

        try {
            const r = await axios.post(`${adsBase()}/customers/${cfg.customerId}:uploadClickConversions`, {
                conversions: [{
                    gclid,
                    conversionAction: `customers/${cfg.customerId}/conversionActions/${cfg.conversionActionId}`,
                    conversionDateTime,
                    conversionValue: opts.value ?? 0,
                    currencyCode: opts.currency || cfg.currency || 'INR',
                    orderId: opts.orderId
                }],
                partialFailure: true,
                validateOnly: false
            }, { headers: await this.headers(orgId) });
            const err = r.data?.partialFailureError?.message;
            await writeConfig(orgId, { lastConversion: { at: new Date().toISOString(), ok: !err, message: err || 'Uploaded', leadId } });
            return { ok: !err, error: err };
        } catch (e: any) {
            const msg = e.response?.data?.error?.message || e.message;
            await writeConfig(orgId, { lastConversion: { at: new Date().toISOString(), ok: false, message: msg, leadId } });
            return { ok: false, error: msg };
        }
    }
};

export default GoogleAdsService;
