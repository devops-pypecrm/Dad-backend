import express from 'express';
import { protect } from '../middleware/authMiddleware';
import { generateContent } from '../controllers/aiController';
import { chatWithAssistant, streamWithAssistant, warmAssistant } from '../controllers/aiAssistantController';
import * as hub from '../controllers/aiHubController';
import { requireAiFeature } from '../services/whatsAppFeature';
import { generalLimiter } from '../middleware/rateLimiter';

const router = express.Router();

router.use(protect);

// Apply rate limiting to prevent abuse
router.post('/generate', generalLimiter, generateContent);

// AI Assistant Hub — switched on per organisation by the Super Admin (feature key 'ai_assistant').
router.get('/assistant/warm', requireAiFeature, warmAssistant);
router.post('/assistant/stream', requireAiFeature, generalLimiter, streamWithAssistant);
router.post('/assistant/chat', requireAiFeature, generalLimiter, chatWithAssistant);
router.get('/hub/briefing', requireAiFeature, generalLimiter, hub.briefing);
router.get('/hub/hot-leads', requireAiFeature, generalLimiter, hub.hotLeads);
router.get('/hub/forecast', requireAiFeature, generalLimiter, hub.forecast);
router.get('/hub/team-coach', requireAiFeature, generalLimiter, hub.teamCoach);
router.get('/hub/leads/search', requireAiFeature, hub.searchLeads);
router.get('/hub/leads/:leadId/summary', requireAiFeature, generalLimiter, hub.summarizeLead);
router.post('/hub/draft', requireAiFeature, generalLimiter, hub.draft);

export default router;
