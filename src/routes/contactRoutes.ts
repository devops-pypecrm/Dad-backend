import express from 'express';
import { getContacts, createContact, getContactById, updateContact, deleteContact, getBlockedContacts, blockContact, unblockContact, getContactLeads, getContactsForLead } from '../controllers/contactController';
import { protect } from '../middleware/authMiddleware';
import { checkPlanLimits } from '../middleware/subscriptionMiddleware';

const router = express.Router();

router.get('/', protect, getContacts);
router.post('/', protect, checkPlanLimits('contacts'), createContact);
router.get('/blocked', protect, getBlockedContacts);
router.get('/by-lead/:leadId', protect, getContactsForLead);
router.get('/:id', protect, getContactById);
router.post('/:id/block', protect, blockContact);
router.post('/:id/unblock', protect, unblockContact);
router.get('/:id/leads', protect, getContactLeads);
router.put('/:id', protect, updateContact);
router.delete('/:id', protect, deleteContact);

export default router;
