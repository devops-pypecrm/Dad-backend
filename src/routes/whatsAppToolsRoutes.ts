import express from 'express';
import { protect } from '../middleware/authMiddleware';
import { whatsappLimiter } from '../middleware/rateLimiter';
import { requireOrgAdmin } from '../utils/whatsappHttp';
import { requireWhatsAppFeature } from '../services/whatsAppFeature';
import * as c from '../controllers/whatsAppToolsController';

// WhatsApp Growth Tools (analytics, business profile, QR codes, conversation starters, blocked users, ad attribution).
const router = express.Router();
router.use(protect, requireWhatsAppFeature, whatsappLimiter, requireOrgAdmin);

router.get('/accounts', c.accounts as any);
router.get('/analytics', c.analytics as any);
router.get('/number-status', c.numberStatus as any);
router.get('/ad-referrals', c.referrals as any);

router.get('/business-profile', c.getProfile as any);
router.put('/business-profile', c.updateProfile as any);

router.get('/qr-codes', c.listQr as any);
router.post('/qr-codes', c.createQr as any);
router.put('/qr-codes/:code', c.updateQr as any);
router.delete('/qr-codes/:code', c.deleteQr as any);

router.get('/conversation-starters', c.getStarters as any);
router.put('/conversation-starters', c.saveStarters as any);

router.get('/blocked', c.listBlocked as any);
router.post('/blocked', c.blockUser as any);
router.post('/unblock', c.unblockUser as any);

export default router;
