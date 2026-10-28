import prisma from '../config/prisma';

/**
 * Phone matching + block list for Contacts.
 *
 * A contact's numbers are stored as normalized "keys" (digits only, last 10
 * when the number is at least 10 digits) so +91 98765 43210, 919876543210 and
 * 9876543210 all resolve to the same key. Leads are linked to contacts by
 * the same key at read time - nothing is copied onto the lead.
 */
export const phoneKey = (raw: unknown): string => {
    const digits = (raw ?? '').toString().replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
};

export const phoneKeysFrom = (phones: unknown): string[] => {
    const list = Array.isArray(phones) ? phones : [];
    const keys = list
        .map((p: any) => phoneKey(typeof p === 'string' ? p : p?.number))
        .filter((k) => k.length >= 6);
    return Array.from(new Set(keys));
};

export const ContactLinkService = {
    /** True when a blocked contact owns this number in the org. */
    async isBlocked(organisationId: string | null | undefined, phone: unknown): Promise<boolean> {
        const key = phoneKey(phone);
        if (!organisationId || key.length < 6) return false;
        try {
            const hit = await prisma.contact.findFirst({
                where: { organisationId, isBlocked: true, isDeleted: false, phoneKeys: { has: key } },
                select: { id: true }
            });
            return !!hit;
        } catch (e) {
            // Never let a lookup failure take lead capture down.
            console.error('[ContactLink] isBlocked lookup failed:', (e as Error).message);
            return false;
        }
    },

    /** Contacts (not deleted) that own any of the given numbers. */
    async findContactsForPhones(organisationId: string, phones: unknown[]) {
        const keys = Array.from(new Set(phones.map(phoneKey).filter((k) => k.length >= 6)));
        if (keys.length === 0) return [];
        return prisma.contact.findMany({
            where: { organisationId, isDeleted: false, phoneKeys: { hasSome: keys } },
            select: { id: true, firstName: true, lastName: true, isBlocked: true, phones: true }
        });
    },

    /** Leads whose primary/secondary number matches any of the keys. */
    async findLeadsForKeys(organisationId: string, keys: string[], limit = 200) {
        if (keys.length === 0) return [];
        return prisma.$queryRaw<any[]>`
            SELECT l.id, l."firstName", l."lastName", l.phone, l.status, l.source, l."createdAt",
                   l."isReEnquiry", l."reEnquiryCount", l."assignedToId",
                   u."firstName" AS "ownerFirstName", u."lastName" AS "ownerLastName"
            FROM "Lead" l
            LEFT JOIN "User" u ON u.id = l."assignedToId"
            WHERE l."organisationId" = ${organisationId}
              AND l."isDeleted" = false
              AND (right(regexp_replace(l.phone, '\D', '', 'g'), 10) = ANY(${keys})
                   OR right(regexp_replace(coalesce(l."secondaryPhone", ''), '\D', '', 'g'), 10) = ANY(${keys}))
            ORDER BY l."createdAt" DESC
            LIMIT ${limit}`;
    }
};
