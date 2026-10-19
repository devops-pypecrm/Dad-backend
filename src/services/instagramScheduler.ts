import cron from 'node-cron';
import prisma from '../config/prisma';
import { InstagramAuthService } from './instagramAuthService';

/** Instagram background jobs; registered once, on the primary PM2 instance only. */
export const initInstagramScheduler = () => {
    // Daily: refresh long-lived tokens that expire within 10 days.
    cron.schedule('20 3 * * *', async () => {
        try { await InstagramAuthService.refreshExpiring(); } catch (e) { console.error('[InstagramScheduler] token refresh failed:', e); }
    });
    // Hourly: drop expired chatbot chat-window sessions.
    cron.schedule('40 * * * *', async () => {
        try { await prisma.instagramChatbotSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }); } catch (e) { console.error('[InstagramScheduler] cleanup failed:', e); }
    });
    console.log('[InstagramScheduler] Jobs scheduled (token refresh daily, session cleanup hourly).');
};
