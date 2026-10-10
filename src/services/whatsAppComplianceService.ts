import prisma from '../config/prisma';
import { OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS } from '../config/whatsapp';
import { digitsOnly } from '../utils/whatsappPhone';

/** Consent handling: customers can stop business-initiated messages by replying STOP. */
export const WhatsAppComplianceService = {
    async isOptedOut(organisationId: string, phone: string): Promise<boolean> {
        const row = await prisma.whatsAppOptOut.findUnique({
            where: { organisationId_phoneNumber: { organisationId, phoneNumber: digitsOnly(phone) } }
        });
        return !!row;
    },

    async optedOutSet(organisationId: string, phones: string[]): Promise<Set<string>> {
        const digits = phones.map(digitsOnly);
        const rows = await prisma.whatsAppOptOut.findMany({ where: { organisationId, phoneNumber: { in: digits } }, select: { phoneNumber: true } });
        return new Set(rows.map(r => r.phoneNumber));
    },

    async optOut(organisationId: string, phone: string, reason: 'keyword' | 'manual' = 'keyword') {
        const phoneNumber = digitsOnly(phone);
        await prisma.whatsAppOptOut.upsert({
            where: { organisationId_phoneNumber: { organisationId, phoneNumber } },
            create: { organisationId, phoneNumber, reason },
            update: { reason }
        });
        // Stop anything automated that is still queued for this number.
        await prisma.whatsAppNurtureEnrollment.updateMany({
            where: { organisationId, phoneNumber, status: 'active' },
            data: { status: 'opted_out', nextRunAt: null }
        });
    },

    async optIn(organisationId: string, phone: string) {
        await prisma.whatsAppOptOut.deleteMany({ where: { organisationId, phoneNumber: digitsOnly(phone) } });
    },

    /** Returns 'out' / 'in' when an inbound text is an opt-out / opt-in keyword (exact match, so normal sentences are unaffected). */
    classifyKeyword(text: string | undefined | null): 'out' | 'in' | null {
        const t = (text || '').trim().toLowerCase();
        if (!t) return null;
        if (OPT_OUT_KEYWORDS.includes(t)) return 'out';
        if (OPT_IN_KEYWORDS.includes(t)) return 'in';
        return null;
    },

    async list(organisationId: string) {
        return prisma.whatsAppOptOut.findMany({ where: { organisationId }, orderBy: { createdAt: 'desc' }, take: 500 });
    }
};
