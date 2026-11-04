import express from 'express';
import {
    createCommission,
    deleteCommission,
    deleteIncentiveConfig,
    getCommissions,
    getIncentiveConfig,
    recalculateIncentives,
    updateCommission,
    updateIncentiveConfig,
} from '../controllers/commissionController';
import { protect, admin } from '../middleware/authMiddleware';

const router = express.Router();

router.get('/', protect, getCommissions);
router.get('/incentive-config', protect, getIncentiveConfig);
router.put('/incentive-config', protect, admin, updateIncentiveConfig);
router.delete('/incentive-config', protect, admin, deleteIncentiveConfig);
router.post('/recalculate', protect, admin, recalculateIncentives);
router.post('/', protect, admin, createCommission);
router.put('/:id', protect, admin, updateCommission);
router.delete('/:id', protect, admin, deleteCommission);

export default router;
