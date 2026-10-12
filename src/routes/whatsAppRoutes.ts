import express from 'express';
import { protect } from '../middleware/authMiddleware';
import { requireWhatsAppFeature } from '../services/whatsAppFeature';
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
router.post('/send', protect, requireWhatsAppFeature, whatsappLimiter, validate(whatsappMessageSchema), sendMessage as any);
router.post('/send-media', protect, requireWhatsAppFeature, whatsappLimiter, validate(whatsappMediaMessageSchema), sendMediaMessage as any);
router.get('/messages', protect, requireWhatsAppFeature, whatsappLimiter, getMessages as any);
router.get('/messages/statistics', protect, requireWhatsAppFeature, whatsappLimiter, getMessageStatistics as any);
router.get('/messages/:messageId/status', protect, requireWhatsAppFeature, whatsappLimiter, getMessageStatus as any);
router.post('/messages/mark-read', protect, requireWhatsAppFeature, whatsappLimiter, validate(markReadSchema), markMessageAsRead as any);
router.post('/messages/mark-conversation-read', protect, requireWhatsAppFeature, whatsappLimiter, validate(markConversationReadSchema), markConversationAsRead as any);
router.get('/messages/media/:mediaId', protect, requireWhatsAppFeature, getMedia as any);
router.get('/connection', protect, requireWhatsAppFeature, whatsappLimiter, getConnectionStatus as any);
router.delete('/templates/:name', protect, requireWhatsAppFeature, whatsappLimiter, deleteTemplate as any);
router.get('/templates', protect, requireWhatsAppFeature, whatsappLimiter, getTemplates as any);
router.post('/templates', protect, requireWhatsAppFeature, whatsappLimiter, validate(whatsappTemplateSchema), createTemplate as any);
router.get('/analytics', protect, requireWhatsAppFeature, whatsappLimiter, getConversationAnalytics as any);
router.get('/lead/:leadId', protect, requireWhatsAppFeature, whatsappLimiter, getLeadWhatsAppMessages as any);
router.post('/test', protect, requireWhatsAppFeature, whatsappLimiter, testConnection as any);
router.get('/webhook', verifyWebhook as any);
router.post('/webhook', handleWebhook as any);
router.post('/webhook/gallabox', handleGallaboxWebhook as any);
router.post('/upload-media', protect, requireWhatsAppFeature, upload.single('file'), uploadMedia as any);

export default router;