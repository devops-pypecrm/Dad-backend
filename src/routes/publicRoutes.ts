
import express from 'express';
import crypto from 'crypto';
import { submitWebForm, getPublicWebForm } from '../controllers/webFormController';
import { MetaIntegrationService } from '../services/metaIntegrationService';
import { getPublicFAQs } from '../controllers/siteFAQController';
import { getPublicTrainingVideos } from '../controllers/trainingVideoController';
import { ZapierWebhookService } from '../services/zapierWebhookService';
import { getPublicDailySummary } from '../controllers/dailySummaryController';
import { submitEnquiry } from '../controllers/enquiryController';

const router = express.Router();

/**
 * @route GET /api/public/health
 * @desc Public Health Check
 */
router.get('/health', (req, res) => res.status(200).send('OK'));

/**
 * @route POST /api/public/webforms/:id/submit
 * @desc Submit a web form to create a lead
 */
router.post('/webforms/:id/submit', submitWebForm);

/**
 * @route GET /api/public/webforms/:id
 * @desc Safe, public definition of an active form (fields/labels only) used to render it
 */
router.get('/webforms/:id', getPublicWebForm);

/**
 * @route POST /api/public/enquiries
 * @desc Submit a landing-page "Enquire" form - reviewed by a super admin
 * before any account is created (see enquiryController.ts).
 */
router.post('/enquiries', submitEnquiry);

/**
 * @route GET /api/public/meta/webhook
 * @desc Verify Meta Webhook
 */
router.get('/meta/webhook', (req, res) => MetaIntegrationService.verifyWebhook(req, res));

/**
 * @route POST /api/public/meta/webhook
 * @desc Handle Meta Webhook (Facebook Leads etc)
 *
 * Verifies X-Hub-Signature-256 the same way `/api/meta/webhook` in
 * metaAuthRoutes.ts already does, so this sibling endpoint (documented as a
 * fallback callback URL in the health-check response) can't be hit with
 * forged lead data by anyone who finds the URL. Same lenient behavior too -
 * only rejects when META_WEBHOOK_SECRET is actually configured AND the
 * signature doesn't match, so this can't start rejecting real traffic on an
 * org whose deployment never set that env var.
 */
router.post('/meta/webhook', (req, res) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const secret = process.env.META_WEBHOOK_SECRET;

    if (secret && signature) {
        const rawBody = (req as any).rawBody || JSON.stringify(req.body);
        const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const expectedSignature = `sha256=${digest}`;
        if (signature !== expectedSignature) {
            console.warn('❌ [PublicMetaWebhook] Invalid signature');
            return res.sendStatus(401);
        }
    }

    MetaIntegrationService.handleWebhook(req.body);
    res.sendStatus(200);
});

/**
 * @route POST /api/public/meta/deauthorize
 * @desc Meta's deauthorize_callback_url - called when a user removes this
 * app from their Facebook settings. Configure this exact URL in the Meta
 * App Dashboard under Facebook Login > Settings > "Deauthorize Callback URL".
 * See MetaIntegrationService.handleDeauthorize for what happens with it.
 */
router.post('/meta/deauthorize', express.urlencoded({ extended: true }), async (req, res) => {
    const signedRequest = req.body?.signed_request;
    const parsed = signedRequest ? MetaIntegrationService.verifyAndParseSignedRequest(signedRequest) : null;

    if (!parsed?.user_id) {
        return res.sendStatus(400);
    }

    await MetaIntegrationService.handleDeauthorize(parsed.user_id);
    res.sendStatus(200);
});

/**
 * @route GET /api/public/faqs
 * @desc Get active FAQs for landing page
 */
router.get('/faqs', getPublicFAQs);

/**
 * @route GET /api/public/training-videos
 * @desc Get active training video guides for the in-app Training page
 */
router.get('/training-videos', getPublicTrainingVideos);

/**
 * @route GET /api/public/daily-summary/:token
 * @desc Business-owner-facing daily report (calls + leads + revenue), linked from the
 *       WhatsApp daily report message. Signed token is the access control.
 */
router.get('/daily-summary/:token', getPublicDailySummary);

/**
 * @route POST /api/public/zapier/webhook/:orgId
 * @desc Receive leads from Zapier (Facebook Lead Ads, etc.)
 * @auth API Key via query param ?apiKey=xxx
 */
router.post('/zapier/webhook/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;
        const apiKey = (req.query.apiKey as string) || req.headers['x-api-key'] as string;

        if (!orgId || !apiKey) {
            return res.status(400).json({ message: 'Missing orgId or apiKey' });
        }

        const { valid, org } = await ZapierWebhookService.validateRequest(orgId, apiKey);
        if (!valid || !org) {
            return res.status(401).json({ message: 'Invalid API key or organisation' });
        }

        const result = await ZapierWebhookService.processLead(org, req.body);
        res.status(200).json({
            message: result.isReEnquiry ? 'Lead updated (re-enquiry)' : 'Lead created',
            leadId: result.leadId
        });
    } catch (error: any) {
        console.error('[ZapierWebhook] Route error:', error.message);
        res.status(500).json({ message: 'Failed to process webhook' });
    }
});

/**
 * @route POST /api/public/meta/payload/:orgId
 * @desc Receive leads from Meta Ads Payload (direct JSON)
 * @auth API Key via query param ?apiKey=xxx
 */
router.post('/meta/payload/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;
        const apiKey = (req.query.apiKey as string) || req.headers['x-api-key'] as string;
        const { MetaPayloadService } = await import('../services/metaPayloadService');

        if (!orgId || !apiKey) {
            return res.status(400).json({ message: 'Missing orgId or apiKey' });
        }

        const { valid, org } = await MetaPayloadService.validateRequest(orgId, apiKey);
        if (!valid || !org) {
            return res.status(401).json({ message: 'Invalid API key or organisation' });
        }

        const result = await MetaPayloadService.processLead(org, req.body);
        res.status(200).json({
            message: result.isReEnquiry ? 'Lead updated (re-enquiry)' : 'Lead created',
            leadId: result.leadId
        });
    } catch (error: any) {
        console.error('[MetaPayload] Route error:', error.message);
        res.status(500).json({ message: 'Failed to process webhook' });
    }
});

export default router;

