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
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/', protect, requireOrgAdmin, getFlows);
router.post('/', protect, requireOrgAdmin, createFlow);
router.get('/:id', protect, requireOrgAdmin, getFlowById);
router.put('/:id', protect, requireOrgAdmin, updateFlow);
router.delete('/:id', protect, requireOrgAdmin, deleteFlow);
router.get('/:id/sessions', protect, requireOrgAdmin, getFlowSessions);
router.post('/:id/test', protect, requireOrgAdmin, testFlow);

export default router;
