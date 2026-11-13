import express, { Request, Response } from 'express';
import { protect } from '../middleware/authMiddleware';
import { getOrgId } from '../utils/hierarchyUtils';
import { isOrgAdmin } from '../utils/roleUtils';
import { GoogleAdsService, isPlatformConfigured } from '../services/googleAdsService';

const router = express.Router();

/**
 * PUBLIC: Google Ads Lead Form Extension webhook.
 * Paste https://<api-host>/api/google-ads/lead-webhook as the "Webhook URL" and the org's key as the "Key"
 * in Google Ads -> Lead form -> Lead delivery. Google sends the key back inside the body as `google_key`.
 * Always answers 200 for a valid key so Google doesn't retry forever on our own processing errors.
 */
router.post('/lead-webhook', async (req: Request, res: Response) => {
    const key = String(req.body?.google_key || req.query.key || '');
    const orgId = await GoogleAdsService.findOrgByWebhookKey(key);
    if (!orgId) return res.status(401).json({ message: 'Invalid key' });
    try {
        const result = await GoogleAdsService.handleLeadFormPayload(orgId, req.body || {});
        return res.status(200).json(result);
    } catch (e: any) {
        console.error('[GoogleAds] lead webhook error:', e.message);
        return res.status(200).json({ status: 'error' });
    }
});

// Everything below is org-admin only.
router.use(protect);
router.use((req: any, res: Response, next) => {
    if (!isOrgAdmin(req.user)) return res.status(403).json({ message: 'Only admins can manage Google Ads' });
    next();
});

const wrap = (fn: (orgId: string, req: any, res: Response) => Promise<any>) => async (req: any, res: Response) => {
    try {
        const out = await fn(getOrgId(req.user) as string, req, res);
        if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e: any) {
        const g = e.response?.data?.error;
        console.error('[GoogleAds]', g?.message || e.message);
        res.status(e.response?.status && e.response.status < 500 ? e.response.status : 500).json({ message: g?.message || e.message });
    }
};

router.get('/status', wrap(async (orgId) => GoogleAdsService.getStatus(orgId)));

router.get('/auth-url', wrap(async (orgId, req, res) => {
    if (!isPlatformConfigured()) return res.status(500).json({ message: 'Google Ads is not configured on the server yet (client id/secret and developer token).' });
    return { authUrl: GoogleAdsService.getAuthUrl(orgId, req.user.id) };
}));

router.post('/callback', wrap(async (orgId, req, res) => {
    const { code, state } = req.body || {};
    if (!code) return res.status(400).json({ message: 'Authorization code is required' });
    if (!GoogleAdsService.verifyState(state, orgId, req.user.id)) return res.status(400).json({ message: 'Invalid or expired connect request. Please try again.' });
    return GoogleAdsService.handleCallback(orgId, code);
}));

router.get('/accounts', wrap(async (orgId) => ({ accounts: await GoogleAdsService.listAccounts(orgId) })));
router.post('/select-account', wrap(async (orgId, req, res) => {
    if (!req.body?.customerId) return res.status(400).json({ message: 'customerId is required' });
    await GoogleAdsService.selectAccount(orgId, req.body);
    return GoogleAdsService.getStatus(orgId);
}));

router.get('/campaigns', wrap(async (orgId, req) => ({ campaigns: await GoogleAdsService.getCampaigns(orgId, req.query.startDate as string, req.query.endDate as string) })));
router.get('/conversion-actions', wrap(async (orgId) => ({ actions: await GoogleAdsService.getConversionActions(orgId) })));

router.post('/regenerate-key', wrap(async (orgId) => ({ webhookKey: await GoogleAdsService.regenerateWebhookKey(orgId) })));
router.post('/disconnect', wrap(async (orgId) => { await GoogleAdsService.disconnect(orgId); return { disconnected: true }; }));

export default router;
