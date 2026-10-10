import express from 'express';
import {
    getWhatsAppAccounts,
    createWhatsAppAccount,
    updateWhatsAppAccount,
    deleteWhatsAppAccount,
    getWhatsAppIntegrationReport
} from '../controllers/whatsAppAccountController';
import { protect } from '../middleware/authMiddleware';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/report', protect, requireOrgAdmin, getWhatsAppIntegrationReport);
router.get('/', protect, requireOrgAdmin, getWhatsAppAccounts);
router.post('/', protect, requireOrgAdmin, createWhatsAppAccount);
router.put('/:id', protect, requireOrgAdmin, updateWhatsAppAccount);
router.delete('/:id', protect, requireOrgAdmin, deleteWhatsAppAccount);

export default router;
