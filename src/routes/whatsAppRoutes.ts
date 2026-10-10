import express from 'express';
import { protect } from '../middleware/authMiddleware';
import {
    sendMessage,
    getMessages,
    testConnection,
    getTemplates,
    createTemplate,
    sendMediaMessage,
    getMessageStatus,
    markMessageAsRead,
    getConversationAnalytics,
    getMessageStatistics,
    markConversationAsRead,
    getLeadWhatsAppMessages,
    getMedia,
    uploadMedia,
    handleWebhook,
    verifyWebhook,
    handleGallaboxWebhook,
    getConnectionStatus,
    deleteTemplate
} from '../controllers/whatsAppController';
import { whatsappLimiter } from '../middleware/rateLimiter';
import multer from 'multer';
import {
    validate,
    whatsappMessageSchema,
    whatsappMediaMessageSchema,
    whatsappTemplateSchema,
    markReadSchema,
    markConversationReadSchema
} from '../middleware/validation';

const upload = multer();
const router = express.Router();

// WhatsApp messaging endpoints with rate limiting and validation
router.post('/send', protect, whatsappLimiter, validate(whatsappMessageSchema), sendMessage as any);
router.post('/send-media', protect, whatsappLimiter, validate(whatsappMediaMessageSchema), sendMediaMessage as any);
router.get('/messages', protect, whatsappLimiter, getMessages as any);
router.get('/messages/statistics', protect, whatsappLimiter, getMessageStatistics as any);
router.get('/messages/:messageId/status', protect, whatsappLimiter, getMessageStatus as any);
router.post('/messages/mark-read', protect, whatsappLimiter, validate(markReadSchema), markMessageAsRead as any);
router.post('/messages/mark-conversation-read', protect, whatsappLimiter, validate(markConversationReadSchema), markConversationAsRead as any);
router.get('/messages/media/:mediaId', protect, getMedia as any);
router.get('/connection', protect, whatsappLimiter, getConnectionStatus as any);
router.delete('/templates/:name', protect, whatsappLimiter, deleteTemplate as any);
router.get('/templates', protect, whatsappLimiter, getTemplates as any);
router.post('/templates', protect, whatsappLimiter, validate(whatsappTemplateSchema), createTemplate as any);
router.get('/analytics', protect, whatsappLimiter, getConversationAnalytics as any);
router.get('/lead/:leadId', protect, whatsappLimiter, getLeadWhatsAppMessages as any);
router.post('/test', protect, whatsappLimiter, testConnection as any);
router.get('/webhook', verifyWebhook as any);
router.post('/webhook', handleWebhook as any);
router.post('/webhook/gallabox', handleGallaboxWebhook as any);
router.post('/upload-media', protect, upload.single('file'), uploadMedia as any);

export default router;