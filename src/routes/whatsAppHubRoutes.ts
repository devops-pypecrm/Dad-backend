import express from 'express';
import multer from 'multer';
import { protect } from '../middleware/authMiddleware';
import { whatsappLimiter } from '../middleware/rateLimiter';
import { requireOrgAdmin } from '../utils/whatsappHttp';
import * as inbox from '../controllers/whatsAppInboxController';
import * as hub from '../controllers/whatsAppHubController';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(protect, whatsappLimiter);

// ---- Team Inbox (any signed-in user; visibility follows the reporting hierarchy) ----
router.get('/inbox/conversations', inbox.listConversations as any);
router.get('/inbox/counts', inbox.conversationCounts as any);
router.post('/inbox/start', inbox.startConversation as any);
router.get('/inbox/assignable-users', inbox.assignableUsers as any);
router.get('/inbox/conversations/:id', inbox.getConversation as any);
router.patch('/inbox/conversations/:id', inbox.updateConversation as any);
router.get('/inbox/conversations/:id/messages', inbox.getConversationMessages as any);
router.post('/inbox/conversations/:id/messages', inbox.sendConversationMessage as any);
router.post('/inbox/conversations/:id/read', inbox.markConversationRead as any);
router.get('/inbox/conversations/:id/notes', inbox.listNotes as any);
router.post('/inbox/conversations/:id/notes', inbox.addNote as any);

router.get('/inbox/quick-replies', inbox.listQuickReplies as any);
router.post('/inbox/quick-replies', requireOrgAdmin, inbox.saveQuickReply as any);
router.put('/inbox/quick-replies/:id', requireOrgAdmin, inbox.saveQuickReply as any);
router.delete('/inbox/quick-replies/:id', requireOrgAdmin, inbox.deleteQuickReply as any);
router.get('/inbox/labels', inbox.listLabels as any);
router.post('/inbox/labels', inbox.createLabel as any);
router.delete('/inbox/labels/:id', requireOrgAdmin, inbox.deleteLabel as any);

// ---- Templates ----
router.post('/templates/sync', requireOrgAdmin, hub.syncTemplates as any);

// ---- Auto responder ----
router.get('/automation/responders', requireOrgAdmin, hub.listResponders as any);
router.post('/automation/responders', requireOrgAdmin, hub.createResponder as any);
router.put('/automation/responders/:id', requireOrgAdmin, hub.updateResponder as any);
router.delete('/automation/responders/:id', requireOrgAdmin, hub.deleteResponder as any);
router.get('/automation/responders/:id/logs', requireOrgAdmin, hub.responderLogs as any);

// ---- Lead nurturing ----
router.get('/automation/nurture', requireOrgAdmin, hub.listNurture as any);
router.post('/automation/nurture', requireOrgAdmin, hub.createNurture as any);
router.put('/automation/nurture/:id', requireOrgAdmin, hub.updateNurture as any);
router.delete('/automation/nurture/:id', requireOrgAdmin, hub.deleteNurture as any);
router.get('/automation/nurture/:id/enrollments', requireOrgAdmin, hub.nurtureEnrollments as any);

// ---- Chatbot library ----
router.get('/chatbot/overview', requireOrgAdmin, hub.chatbotOverview as any);
router.post('/chatbot/library/:key/use', requireOrgAdmin, hub.useChatbotTemplate as any);
router.post('/chatbot/:id/publish', requireOrgAdmin, hub.publishChatbot as any);

// ---- AI agent ----
router.get('/ai/status', requireOrgAdmin, hub.aiStatus as any);
router.put('/ai/agent', requireOrgAdmin, hub.aiUpdateAgent as any);
router.put('/ai/sections/:category', requireOrgAdmin, hub.aiSaveSection as any);
router.post('/ai/documents', requireOrgAdmin, upload.single('file'), hub.aiUploadDocument as any);
router.delete('/ai/documents/:id', requireOrgAdmin, hub.aiDeleteDocument as any);
router.post('/ai/test', requireOrgAdmin, hub.aiTest as any);

// ---- Settings, health, consent, insights ----
router.get('/settings/overview', requireOrgAdmin, hub.settingsOverview as any);
router.post('/settings/accounts/:id/refresh', requireOrgAdmin, hub.refreshAccountHealth as any);
router.post('/settings/refresh', requireOrgAdmin, hub.refreshAllHealth as any);
router.get('/optouts', requireOrgAdmin, hub.listOptOuts as any);
router.post('/optouts', requireOrgAdmin, hub.addOptOut as any);
router.delete('/optouts/:phone', requireOrgAdmin, hub.removeOptOut as any);
router.get('/insights', requireOrgAdmin, hub.insights as any);

export default router;
