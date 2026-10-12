import express from 'express';
import {
    getWhatsAppAccounts,
    createWhatsAppAccount,
    updateWhatsAppAccount,
    deleteWhatsAppAccount,
    getWhatsAppIntegrationReport
} from '../controllers/whatsAppAccountController';
import { protect } from '../middleware/authMiddleware';
import { requireWhatsAppFeature } from '../services/whatsAppFeature';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/report', protect, requireWhatsAppFeature, requireOrgAdmin, getWhatsAppIntegrationReport);
router.get('/', protect, requireWhatsAppFeature, requireOrgAdmin, getWhatsAppAccounts);
router.post('/', protect, requireWhatsAppFeature, requireOrgAdmin, createWhatsAppAccount);
router.put('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, updateWhatsAppAccount);
router.delete('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, deleteWhatsAppAccount);

export default router;
