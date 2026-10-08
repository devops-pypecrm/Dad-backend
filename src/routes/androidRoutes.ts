import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getAndroidLeads, getLeadLastNote, uploadCallRecording, syncCallLogs, uploadHelperLogs } from '../controllers/androidController';
import { logExternalMessage } from '../controllers/whatsAppController';
import { protect } from '../middleware/authMiddleware';
import prisma from '../config/prisma';
import rateLimit from 'express-rate-limit';

// Rate limiter for WhatsApp sync endpoint to protect against broken clients
const whatsappSyncLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20, // Limit each IP to 20 requests per `window`
    message: { message: "Too many WhatsApp sync requests from this IP, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiter for bulk-sync: 1 request per user per 30 seconds (was 10
// minutes — shortened so a call syncs to the CRM almost immediately during
// dialer testing; still bounded so a device can't hammer the server).
//
// DB-backed rather than an in-memory Map -- this backend runs as multiple
// PM2-clustered processes (see cronService.ts's own NODE_APP_INSTANCE guard,
// added specifically because cron jobs can't assume a single process), and a
// per-process Map only rate-limits requests that happen to land on that same
// worker. A user's requests can round-robin across workers behind the
// load balancer and blow straight through an in-memory limit. Uses
// SystemSetting as a lightweight per-user KV store (avoids a schema
// migration for a single timestamp) and one atomic
// `INSERT ... ON CONFLICT ... WHERE` so two concurrent requests from the
// same user -- even on two different processes -- can never both pass:
// only the request whose WHERE clause actually matches gets its UPDATE
// applied and a row back; the other gets zero rows and is rate-limited.
const BULK_SYNC_COOLDOWN_MS = 30 * 1000; // 30 seconds

const bulkSyncRateLimiter = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userId = (req as any).user?.id;
    if (!userId) return next();

    const key = `bulk_sync_last_call:${userId}`;
    try {
        const claimed = await prisma.$queryRaw<{ updatedAt: Date }[]>`
            INSERT INTO "SystemSetting" (id, key, value, "group", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${key}, ${String(Date.now())}, 'rate_limit', now(), now())
            ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, "updatedAt" = now()
                WHERE (EXTRACT(EPOCH FROM (now() - "SystemSetting"."updatedAt")) * 1000) >= ${BULK_SYNC_COOLDOWN_MS}
            RETURNING "updatedAt"
        `;

        if (claimed.length === 0) {
            // Row exists and the cooldown hasn't elapsed yet -- read it back
            // purely to compute an accurate wait time for the client.
            const existing = await prisma.systemSetting.findUnique({ where: { key } });
            const elapsed = existing ? Date.now() - existing.updatedAt.getTime() : BULK_SYNC_COOLDOWN_MS;
            const waitSecs = Math.max(1, Math.ceil((BULK_SYNC_COOLDOWN_MS - elapsed) / 1000));
            console.log(`[BulkSync] Rate limited user ${userId} — try again in ${waitSecs}s`);
            return res.status(429).json({
                message: `Too many bulk-sync requests. Please wait ${waitSecs} seconds.`,
                retryAfterSeconds: waitSecs
            });
        }

        next();
    } catch (err) {
        // Fail open -- never let the rate-limit mechanism itself block a
        // sync. If the DB is genuinely unreachable, the actual sync work
        // below will fail on its own and surface that properly instead of
        // this middleware masking it as a rate-limit response.
        console.error('[BulkSync] Rate limiter check failed, allowing request through:', err);
        next();
    }
};

const router = express.Router();

// Configure multer for audio uploads
const storage = multer.diskStorage({
    destination(req, file, cb) {
        const uploadDir = path.join(process.cwd(), 'uploads', 'recordings');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename(req, file, cb) {
        cb(null, `call-recording-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit for recordings
});

// Helper middleware to accept either 'audio' or 'file' field for recordings
const uploadRecordingFiles = upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]);

const handleRecordingUpload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    uploadRecordingFiles(req, res, (err) => {
        if (err) {
            return next(err);
        }
        // Normalize req.file from either field
        const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
        if (files) {
            if (files.audio && files.audio.length > 0) {
                req.file = files.audio[0];
            } else if (files.file && files.file.length > 0) {
                req.file = files.file[0];
            }
        }
        next();
    });
};

// Routes
router.get('/leads', protect, getAndroidLeads as any);
router.get('/leads/:leadId/last-note', protect, getLeadLastNote as any);
router.post('/recordings', protect, handleRecordingUpload, uploadCallRecording as any);
router.post('/whatsapp/sync', whatsappSyncLimiter, protect, logExternalMessage as any);
router.post('/bulk-sync', protect, bulkSyncRateLimiter, syncCallLogs as any);
router.post('/helper-logs', protect, uploadHelperLogs as any);

export default router;

