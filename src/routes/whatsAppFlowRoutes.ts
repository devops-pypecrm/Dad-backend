import express from 'express';
import {
    getFlows,
    getFlowById,
    createFlow,
    updateFlow,
    deleteFlow,
    getFlowSessions,
    testFlow
} from '../controllers/whatsAppFlowController';
import { protect } from '../middleware/authMiddleware';
import { requireWhatsAppFeature } from '../services/whatsAppFeature';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/', protect, requireWhatsAppFeature, requireOrgAdmin, getFlows);
router.post('/', protect, requireWhatsAppFeature, requireOrgAdmin, createFlow);
router.get('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, getFlowById);
router.put('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, updateFlow);
router.delete('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, deleteFlow);
router.get('/:id/sessions', protect, requireWhatsAppFeature, requireOrgAdmin, getFlowSessions);
router.post('/:id/test', protect, requireWhatsAppFeature, requireOrgAdmin, testFlow);

export default router;
