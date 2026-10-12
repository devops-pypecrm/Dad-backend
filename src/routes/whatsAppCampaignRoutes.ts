import express from 'express';
import {
    getWhatsAppCampaigns, getWhatsAppCampaign, createWhatsAppCampaign, updateWhatsAppCampaign, deleteWhatsAppCampaign,
    previewAudience, sendWhatsAppCampaignNow, retryFailedRecipients, cancelWhatsAppCampaign
} from '../controllers/whatsAppCampaignController';
import { protect } from '../middleware/authMiddleware';
import { requireWhatsAppFeature } from '../services/whatsAppFeature';
import { campaignLimiter } from '../middleware/rateLimiter';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/', protect, requireWhatsAppFeature, requireOrgAdmin, getWhatsAppCampaigns as any);
router.post('/preview', protect, requireWhatsAppFeature, requireOrgAdmin, previewAudience as any);
router.post('/', protect, requireWhatsAppFeature, requireOrgAdmin, campaignLimiter, createWhatsAppCampaign as any);
router.get('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, getWhatsAppCampaign as any);
router.put('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, updateWhatsAppCampaign as any);
router.post('/:id/send', protect, requireWhatsAppFeature, requireOrgAdmin, campaignLimiter, sendWhatsAppCampaignNow as any);
router.post('/:id/retry-failed', protect, requireWhatsAppFeature, requireOrgAdmin, campaignLimiter, retryFailedRecipients as any);
router.post('/:id/cancel', protect, requireWhatsAppFeature, requireOrgAdmin, cancelWhatsAppCampaign as any);
router.delete('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, deleteWhatsAppCampaign as any);

export default router;
