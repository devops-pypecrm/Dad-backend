import express from 'express';
import {
    getWhatsAppAssignmentRules,
    createWhatsAppAssignmentRule,
    updateWhatsAppAssignmentRule,
    deleteWhatsAppAssignmentRule
} from '../controllers/whatsAppAssignmentRuleController';
import { protect } from '../middleware/authMiddleware';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/', protect, requireOrgAdmin, getWhatsAppAssignmentRules);
router.post('/', protect, requireOrgAdmin, createWhatsAppAssignmentRule);
router.put('/:id', protect, requireOrgAdmin, updateWhatsAppAssignmentRule);
router.delete('/:id', protect, requireOrgAdmin, deleteWhatsAppAssignmentRule);

export default router;
