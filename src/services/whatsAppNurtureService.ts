import prisma from '../config/prisma';
import { WhatsAppSender, WhatsAppSendError } from './whatsAppSender';
import { WhatsAppComplianceService } from './whatsAppComplianceService';
import { resolveParams, ParamSpec } from '../utils/whatsappAutomation';
import { toWhatsAppNumber, digitsOnly } from '../utils/whatsappPhone';

const LEAD_BATCH = 200;
const SEND_BATCH = 50;
export const UNENGAGED_TAG = 'whatsapp_unengaged';

/**
 * Lead Nurturing: a sequence of approved templates sent with delays
 * (e.g. +1 day, +3 days, +7 days). Any reply from the lead stops the sequence;
 * a lead who goes through every step without replying is tagged "unengaged".
 */
export const WhatsAppNurtureService = {
    async tick() {
        const sequences = await prisma.whatsAppNurtureSequence.findMany({
            where: { isActive: true, isDeleted: false, activatedAt: { not: null } },
            include: { steps: { orderBy: { position: 'asc' } } }
        });
        for (const seq of sequences) {
            if (!seq.steps.length) continue;
            try { await this.enrollNewLeads(seq); } catch (err) { console.error('[Nurture] enrol failed', seq.id, err); }
        }
        await this.sendDue();
    },

    async enrollNewLeads(seq: any) {
        const leads = await prisma.lead.findMany({
            where: { organisationId: seq.organisationId, isDeleted: false, createdAt: { gt: seq.activatedAt }, ...(seq.sources?.length ? { source: { in: seq.sources } } : {}) },
            orderBy: { createdAt: 'asc' },
            take: LEAD_BATCH,
            select: { id: true, phone: true, phoneCountryCode: true, countryCode: true, createdAt: true }
        });
        if (!leads.length) return;

        const phones = leads.map(l => toWhatsAppNumber(l.phone, { phoneCountryCode: l.phoneCountryCode, countryCode: l.countryCode }));
        const existing = await prisma.whatsAppNurtureEnrollment.findMany({
            where: { sequenceId: seq.id, phoneNumber: { in: phones.filter(Boolean) as string[] } }, select: { phoneNumber: true }
        });
        const enrolled = new Set(existing.map(e => e.phoneNumber));
        const optedOut = await WhatsAppComplianceService.optedOutSet(seq.organisationId, phones.filter(Boolean) as string[]);

        for (let i = 0; i < leads.length; i++) {
            const phone = phones[i];
            if (!phone || enrolled.has(phone) || optedOut.has(phone)) continue;
            const first = new Date(leads[i].createdAt.getTime() + seq.steps[0].delayMinutes * 60_000);
            await prisma.whatsAppNurtureEnrollment.create({
                data: { sequenceId: seq.id, organisationId: seq.organisationId, leadId: leads[i].id, phoneNumber: phone, nextRunAt: first < new Date() ? new Date() : first }
            }).catch(() => undefined); // unique(sequenceId, phoneNumber) guards races
        }
    },

    async sendDue() {
        const due = await prisma.whatsAppNurtureEnrollment.findMany({
            where: { status: 'active', nextRunAt: { lte: new Date() } },
            orderBy: { nextRunAt: 'asc' },
            take: SEND_BATCH,
            include: { sequence: { include: { steps: { orderBy: { position: 'asc' } } } } }
        });

        for (const e of due) {
            const seq = e.sequence;
            // claim by pushing nextRunAt out; restored below on success
            const claimed = await prisma.whatsAppNurtureEnrollment.updateMany({ where: { id: e.id, status: 'active', nextRunAt: e.nextRunAt }, data: { nextRunAt: new Date(Date.now() + 10 * 60_000) } });
            if (claimed.count !== 1) continue;

            try {
                if (!seq.isActive || seq.isDeleted) { await this.setStatus(e.id, 'cancelled'); continue; }
                if (await WhatsAppComplianceService.isOptedOut(e.organisationId, e.phoneNumber)) { await this.setStatus(e.id, 'opted_out'); continue; }
                if (seq.stopOnReply) {
                    const replied = await prisma.whatsAppMessage.findFirst({ where: { organisationId: e.organisationId, direction: 'incoming', phoneNumber: { in: [e.phoneNumber, `+${e.phoneNumber}`] }, createdAt: { gt: e.createdAt } }, select: { id: true } });
                    if (replied) { await this.setStatus(e.id, 'replied'); continue; }
                }
                const step = seq.steps[e.stepsSent];
                if (!step) { await this.complete(e); continue; }

                const [lead, org] = await Promise.all([
                    e.leadId ? prisma.lead.findUnique({ where: { id: e.leadId } }) : null,
                    prisma.organisation.findUnique({ where: { id: e.organisationId }, select: { name: true } })
                ]);
                if (e.leadId && (!lead || lead.isDeleted)) { await this.setStatus(e.id, 'cancelled'); continue; }

                await WhatsAppSender.send({
                    organisationId: e.organisationId, to: e.phoneNumber, accountId: seq.whatsappAccountId, source: 'nurture', leadId: e.leadId,
                    template: { name: step.templateName, language: step.templateLanguage, values: resolveParams(step.templateParams as unknown as ParamSpec[], lead, org?.name) }
                });

                const next = seq.steps[e.stepsSent + 1];
                if (next) {
                    await prisma.whatsAppNurtureEnrollment.update({ where: { id: e.id }, data: { stepsSent: e.stepsSent + 1, lastSentAt: new Date(), nextRunAt: new Date(Date.now() + next.delayMinutes * 60_000), lastError: null } });
                } else {
                    await this.complete({ ...e, stepsSent: e.stepsSent + 1 });
                }
            } catch (err: any) {
                const optedOut = err instanceof WhatsAppSendError && err.code === 'OPTED_OUT';
                await prisma.whatsAppNurtureEnrollment.update({ where: { id: e.id }, data: { status: optedOut ? 'opted_out' : 'failed', lastError: err.message, nextRunAt: null } }).catch(() => undefined);
            }
        }
    },

    async complete(e: { id: string; leadId: string | null; stepsSent: number }) {
        await prisma.whatsAppNurtureEnrollment.update({ where: { id: e.id }, data: { status: 'completed', stepsSent: e.stepsSent, lastSentAt: new Date(), nextRunAt: null } });
        if (e.leadId) {
            const lead = await prisma.lead.findUnique({ where: { id: e.leadId }, select: { tags: true } });
            if (lead && !lead.tags.includes(UNENGAGED_TAG)) {
                await prisma.lead.update({ where: { id: e.leadId }, data: { tags: { push: UNENGAGED_TAG } } }).catch(() => undefined);
            }
        }
    },

    async setStatus(id: string, status: string) {
        await prisma.whatsAppNurtureEnrollment.update({ where: { id }, data: { status, nextRunAt: null } });
    },

    /** Inbound reply from a lead: stop any sequence configured to stop on reply. */
    async cancelOnReply(organisationId: string, phone: string) {
        const digits = digitsOnly(phone);
        const active = await prisma.whatsAppNurtureEnrollment.findMany({
            where: { organisationId, phoneNumber: digits, status: 'active', sequence: { stopOnReply: true } }, select: { id: true }
        });
        if (!active.length) return;
        await prisma.whatsAppNurtureEnrollment.updateMany({ where: { id: { in: active.map(a => a.id) } }, data: { status: 'replied', nextRunAt: null } });
    },

    async stats(sequenceId: string) {
        const grouped = await prisma.whatsAppNurtureEnrollment.groupBy({ by: ['status'], where: { sequenceId }, _count: true });
        const out: Record<string, number> = { active: 0, completed: 0, replied: 0, opted_out: 0, failed: 0, cancelled: 0 };
        grouped.forEach(g => { out[g.status] = (out[g.status] || 0) + g._count; });
        return out;
    }
};
