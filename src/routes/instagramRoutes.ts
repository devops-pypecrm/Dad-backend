import express from 'express';
import { protect } from '../middleware/authMiddleware';
import { whatsappLimiter } from '../middleware/rateLimiter';
import { requireOrgAdmin } from '../utils/whatsappHttp';
import { requireInstagramFeature } from '../services/whatsAppFeature';
import * as c from '../controllers/instagramController';

const router = express.Router();

// ---- public: Meta webhook + OAuth redirect (no login; verified by signature / signed state) ----
router.get('/webhook', c.verifyWebhook);
router.post('/webhook', c.receiveWebhook);
router.get('/callback', c.oauthCallback);

// ---- everything below needs a signed-in user in an organisation that has the Instagram feature ----
router.use(protect, requireInstagramFeature, whatsappLimiter);

router.get('/connection', c.getConnection as any);
router.get('/connect-url', requireOrgAdmin, c.getConnectUrl as any);
router.post('/disconnect', requireOrgAdmin, c.disconnect as any);

// Shared inbox
router.get('/inbox/conversations', c.listConversations as any);
router.get('/inbox/counts', c.conversationCounts as any);
router.get('/inbox/assignable-users', c.assignableUsers as any);
router.get('/inbox/conversations/:id', c.getConversation as any);
router.patch('/inbox/conversations/:id', c.updateConversation as any);
router.get('/inbox/conversations/:id/messages', c.getMessages as any);
router.post('/inbox/conversations/:id/messages', c.sendMessage as any);
router.post('/inbox/conversations/:id/read', c.markRead as any);
router.get('/inbox/conversations/:id/notes', c.listNotes as any);
router.post('/inbox/conversations/:id/notes', c.addNote as any);

// Keyword chatbots
router.get('/chatbots', requireOrgAdmin, c.chatbotOverview as any);
router.post('/chatbots', requireOrgAdmin, c.createChatbot as any);
router.post('/chatbots/templates/:key/use', requireOrgAdmin, c.useChatbotTemplate as any);
router.get('/chatbots/:id', requireOrgAdmin, c.getChatbot as any);
router.put('/chatbots/:id', requireOrgAdmin, c.updateChatbot as any);
router.delete('/chatbots/:id', requireOrgAdmin, c.deleteChatbot as any);

// Ask to Follow (comment-gate bots)
router.get('/ask-to-follow', requireOrgAdmin, c.gateOverview as any);
router.get('/ask-to-follow/media', requireOrgAdmin, c.gateMedia as any);
router.post('/ask-to-follow/bots', requireOrgAdmin, c.createGateBot as any);
router.get('/ask-to-follow/bots/:id', requireOrgAdmin, c.getGateBot as any);
router.put('/ask-to-follow/bots/:id', requireOrgAdmin, c.updateGateBot as any);
router.delete('/ask-to-follow/bots/:id', requireOrgAdmin, c.deleteGateBot as any);
router.get('/ask-to-follow/bots/:id/events', requireOrgAdmin, c.gateEvents as any);

export default router;
