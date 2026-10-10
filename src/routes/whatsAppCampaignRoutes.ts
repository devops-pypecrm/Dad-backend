import express from 'express';
import {
    getWhatsAppCampaigns, getWhatsAppCampaign, createWhatsAppCampaign, updateWhatsAppCampaign, deleteWhatsAppCampaign,
    previewAudience, sendWhatsAppCampaignNow, retryFailedRecipients, cancelWhatsAppCampaign
} from '../controllers/whatsAppCampaignController';
import { protect } from '../middleware/authMiddleware';
import { campaignLimiter } from '../middleware/rateLimiter';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/', protect, requireOrgAdmin, getWhatsAppCampaigns as any);
router.post('/preview', protect, requireOrgAdmin, previewAudience as any);
router.post('/', protect, requireOrgAdmin, campaignLimiter, createWhatsAppCampaign as any);
router.get('/:id', protect, requireOrgAdmin, getWhatsAppCampaign as any);
router.put('/:id', protect, requireOrgAdmin, updateWhatsAppCampaign as any);
router.post('/:id/send', protect, requireOrgAdmin, campaignLimiter, sendWhatsAppCampaignNow as any);
router.post('/:id/retry-failed', protect, requireOrgAdmin, campaignLimiter, retryFailedRecipients as any);
router.post('/:id/cancel', protect, requireOrgAdmin, cancelWhatsAppCampaign as any);
router.delete('/:id', protect, requireOrgAdmin, deleteWhatsAppCampaign as any);

export default router;
