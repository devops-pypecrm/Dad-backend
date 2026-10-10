import cron from 'node-cron';
import { WhatsAppAutoResponderService } from './whatsAppAutoResponderService';
import { WhatsAppNurtureService } from './whatsAppNurtureService';
import { WhatsAppCampaignService } from './whatsAppCampaignService';
import { WhatsAppHealthService } from './whatsAppHealthService';

/** WhatsApp background jobs. Registered once, on the primary PM2 instance only (see index.ts). */
export const initWhatsAppScheduler = () => {
    let running = false;

    // Every minute: scheduled campaigns, auto responder, nurture steps.
    cron.schedule('* * * * *', async () => {
        if (running) return; // never overlap with a slow previous run
        running = true;
        try {
            await WhatsAppCampaignService.tickScheduled();
            await WhatsAppAutoResponderService.tick();
            await WhatsAppNurtureService.tick();
        } catch (error) {
            console.error('[WhatsAppScheduler] tick failed:', error);
        } finally {
            running = false;
        }
    });

    // Every 6 hours: refresh quality rating / messaging tier / token validity.
    cron.schedule('15 */6 * * *', async () => {
        try { await WhatsAppHealthService.checkAll(); } catch (error) { console.error('[WhatsAppScheduler] health check failed:', error); }
    });

    console.log('[WhatsAppScheduler] Jobs scheduled (automations every minute, health every 6h).');
};
