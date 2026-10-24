import express from 'express';
import {
    handleBridgeVoice,
    handleBridgeRecordingStatus,
    getBridgeConfig,
    updateBridgeConfig,
} from '../controllers/telephonyBridgeController';
import { protect } from '../middleware/authMiddleware';

const router = express.Router();

// Public webhooks — Twilio needs to reach these from outside, same
// simple-for-now stance telephonyRoutes.ts already takes on its own
// webhooks (no Twilio signature verification yet either).
router.post('/voice', handleBridgeVoice);
router.post('/recording-status', handleBridgeRecordingStatus);

// Protected — org-admin config (no Dad-frontend UI yet, see controller note).
router.get('/config', protect, getBridgeConfig);
router.put('/config', protect, updateBridgeConfig);

export default router;
