import express from 'express';
import {
    getWhatsAppAssignmentRules,
    createWhatsAppAssignmentRule,
    updateWhatsAppAssignmentRule,
    deleteWhatsAppAssignmentRule
} from '../controllers/whatsAppAssignmentRuleController';
import { protect } from '../middleware/authMiddleware';
import { requireWhatsAppFeature } from '../services/whatsAppFeature';
import { requireOrgAdmin } from '../utils/whatsappHttp';

const router = express.Router();

router.get('/', protect, requireWhatsAppFeature, requireOrgAdmin, getWhatsAppAssignmentRules);
router.post('/', protect, requireWhatsAppFeature, requireOrgAdmin, createWhatsAppAssignmentRule);
router.put('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, updateWhatsAppAssignmentRule);
router.delete('/:id', protect, requireWhatsAppFeature, requireOrgAdmin, deleteWhatsAppAssignmentRule);

export default router;
