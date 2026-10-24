import express from 'express';
import {
    handleBridgeVoice,
    handleBridgeRecordingStatus,
    getBridgeConfig,
    updateBridgeConfig,
    reportBridgeOutcome,
    getBridgeOutcomeSummary,
    verifyTwilioSignature,
} from '../controllers/telephonyBridgeController';
import { protect } from '../middleware/authMiddleware';

const router = express.Router();

// Public webhooks — Twilio needs to reach these from outside, same
// verified against Twilio's request signature (see verifyTwilioSignature).
router.post('/voice', verifyTwilioSignature, handleBridgeVoice);
router.post('/recording-status', verifyTwilioSignature, handleBridgeRecordingStatus);

// Protected — org-admin config (no Dad-frontend UI yet, see controller note).
router.get('/config', protect, getBridgeConfig);
router.put('/config', protect, updateBridgeConfig);
router.post('/outcome', protect, reportBridgeOutcome);
router.get('/outcome-summary', protect, getBridgeOutcomeSummary);

export default router;
