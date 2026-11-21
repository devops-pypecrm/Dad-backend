import express from 'express';
import { getFollowUps, createFollowUp, updateFollowUp, bulkUpdateFollowUpStatus } from '../controllers/followUpController';
import { protect } from '../middleware/authMiddleware';

const router = express.Router();

router.get('/', protect, getFollowUps);
router.post('/', protect, createFollowUp);
router.put('/bulk-status', protect, bulkUpdateFollowUpStatus);
router.put('/:id', protect, updateFollowUp);

export default router;
