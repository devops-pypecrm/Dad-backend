import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { protect } from '../middleware/authMiddleware';
import { whatsappLimiter } from '../middleware/rateLimiter';
import { requireOrgAdmin } from '../utils/whatsappHttp';
import { requireInstagramFeature } from '../services/whatsAppFeature';
import * as c from '../controllers/instagramToolsController';

// Instagram Growth Tools (insights, comment manager, publishing, DM entry points, competitor lookup).
const router = express.Router();
const dir = path.join(__dirname, '../../uploads/instagram-publishing');
fs.mkdirSync(dir, { recursive: true });
const upload = multer({
    storage: multer.diskStorage({ destination: dir, filename: (_r, f, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${path.extname(f.originalname).toLowerCase().replace(/[^.\w]/g, '')}`) }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (_r, f, cb) => cb(null, /^(image\/(jpeg|png)|video\/(mp4|quicktime))$/.test(f.mimetype))
});

router.use(protect, requireInstagramFeature, whatsappLimiter, requireOrgAdmin);

router.get('/status', c.status as any);
router.get('/insights', c.insights as any);
router.get('/top-media', c.topMedia as any);

router.get('/media', c.recentMedia as any);
router.get('/media/:mediaId/comments', c.comments as any);
router.post('/media/:mediaId/comments-enabled', c.toggleComments as any);
router.post('/comments/:id/reply', c.replyComment as any);
router.post('/comments/:id/hide', c.hideComment as any);
router.delete('/comments/:id', c.deleteComment as any);

router.get('/messaging-profile', c.getMessagingProfile as any);
router.put('/messaging-profile', c.saveMessagingProfile as any);

router.get('/discover', c.discover as any);

router.get('/posts', c.listPosts as any);
router.post('/posts', c.createPost as any);
router.delete('/posts/:id', c.cancelPost as any);
router.post('/posts/upload', upload.single('file'), c.uploadMedia as any);

export default router;
