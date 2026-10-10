import prisma from '../config/prisma';
import { WhatsAppSender, WhatsAppSendError } from './whatsAppSender';
import { WhatsAppComplianceService } from './whatsAppComplianceService';
import { resolveParams, nextWorkingTime, isWithinWorkingHours, ParamSpec, WorkingHours } from '../utils/whatsappAutomation';
import { toWhatsAppNumber } from '../utils/whatsappPhone';

const LEAD_BATCH = 200;
const SEND_BATCH = 50;

/**
 * Auto Responder: sends an approved template to every NEW lead (from any source)
 * created after the responder was switched on. Lead creation itself is untouched -
 * this simply watches for new leads, so every capture path (Meta Ads, web forms,
 * imports, manual) is covered without editing each one.
 */
export const WhatsAppAutoResponderService = {
    async tick() {
        const responders = await prisma.whatsAppAutoResponder.findMany({ where: { isActive: true, isDeleted: false, activatedAt: { not: null } } });
        for (const r of responders) {
            try { await this.scheduleForNewLeads(r); } catch (err) { console.error('[AutoResponder] schedule failed', r.id, err); }
        }
        await this.sendDue();
    },

    async scheduleForNewLeads(r: any) {
        const leads = await prisma.lead.findMany({
            where: {
                organisationId: r.organisationId,
                isDeleted: false,
                createdAt: { gt: r.activatedAt },
                ...(r.sources?.length ? { source: { in: r.sources } } : {})
            },
            orderBy: { createdAt: 'asc' },
            take: LEAD_BATCH,
            select: { id: true, phone: true, phoneCountryCode: true, countryCode: true, createdAt: true }
        });
        if (!leads.length) return;

        const logged = await prisma.whatsAppAutoResponderLog.findMany({
            where: { responderId: r.id, leadId: { in: leads.map(l => l.id) } },
            select: { leadId: true }
        });
        const done = new Set(logged.map(l => l.leadId));
        const hours = r.workingHoursEnabled ? (r.workingHours as WorkingHours) : null;

        for (const lead of leads) {
            if (done.has(lead.id)) continue;
            const phone = toWhatsAppNumber(lead.phone, { phoneCountryCode: lead.phoneCountryCode, countryCode: lead.countryCode });
            if (!phone) {
                await prisma.whatsAppAutoResponderLog.create({ data: { responderId: r.id, leadId: lead.id, phoneNumber: lead.phone || '', status: 'skipped', error: 'No valid WhatsApp number' } }).catch(() => undefined);
                continue;
            }
            let when = new Date(lead.createdAt.getTime() + r.delayMinutes * 60_000);
            if (when < new Date()) when = new Date();
            if (hours && !isWithinWorkingHours(when, hours, r.timezone)) {
                if (r.outsideHoursBehavior === 'skip') {
                    await prisma.whatsAppAutoResponderLog.create({ data: { responderId: r.id, leadId: lead.id, phoneNumber: phone, status: 'skipped', error: 'Outside working hours' } }).catch(() => undefined);
                    continue;
                }
                when = nextWorkingTime(when, hours, r.timezone);
            }
            await prisma.whatsAppAutoResponderLog.create({ data: { responderId: r.id, leadId: lead.id, phoneNumber: phone, status: 'scheduled', scheduledFor: when } }).catch(() => undefined);
        }
    },

    async sendDue() {
        const due = await prisma.whatsAppAutoResponderLog.findMany({
            where: { status: 'scheduled', scheduledFor: { lte: new Date() } },
            orderBy: { scheduledFor: 'asc' },
            take: SEND_BATCH,
            include: { responder: true }
        });

        for (const log of due) {
            // claim so overlapping ticks can't double-send
            const claimed = await prisma.whatsAppAutoResponderLog.updateMany({ where: { id: log.id, status: 'scheduled' }, data: { status: 'processing' } });
            if (claimed.count !== 1) continue;
            const r = log.responder;
            try {
                if (!r.isActive || r.isDeleted) { await this.finish(log.id, 'skipped', 'Responder was switched off'); continue; }
                if (await WhatsAppComplianceService.isOptedOut(r.organisationId, log.phoneNumber)) { await this.finish(log.id, 'skipped', 'Contact opted out'); continue; }

                const [lead, org] = await Promise.all([
                    prisma.lead.findUnique({ where: { id: log.leadId } }),
                    prisma.organisation.findUnique({ where: { id: r.organisationId }, select: { name: true } })
                ]);
                if (!lead || lead.isDeleted) { await this.finish(log.id, 'skipped', 'Lead no longer exists'); continue; }

                await WhatsAppSender.send({
                    organisationId: r.organisationId,
                    to: log.phoneNumber,
                    accountId: r.whatsappAccountId,
                    source: 'auto_responder',
                    leadId: lead.id,
                    template: { name: r.templateName, language: r.templateLanguage, values: resolveParams(r.templateParams as unknown as ParamSpec[], lead, org?.name) }
                });
                await this.finish(log.id, 'sent');
            } catch (err: any) {
                const code = err instanceof WhatsAppSendError ? err.code : 'ERROR';
                await this.finish(log.id, code === 'OPTED_OUT' ? 'skipped' : 'failed', err.message);
            }
        }
    },

    async finish(id: string, status: 'sent' | 'skipped' | 'failed', error?: string) {
        await prisma.whatsAppAutoResponderLog.update({ where: { id }, data: { status, error: error || null, ...(status === 'sent' ? { sentAt: new Date() } : {}) } });
    },

    async stats(responderId: string) {
        const grouped = await prisma.whatsAppAutoResponderLog.groupBy({ by: ['status'], where: { responderId }, _count: true });
        const out: Record<string, number> = { scheduled: 0, sent: 0, skipped: 0, failed: 0 };
        grouped.forEach(g => { out[g.status] = (out[g.status] || 0) + g._count; });
        return out;
    }
};
