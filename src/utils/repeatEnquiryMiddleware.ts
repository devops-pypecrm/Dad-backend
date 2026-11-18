/**
 * Organisations with `allowDuplicateLeads` ON get a brand-new lead for every repeat enquiry
 * (see DuplicateLeadService.checkDuplicate). This hook makes that new lead *aware* of the earlier
 * one: it is flagged as a re-enquiry (isReEnquiry, reEnquiryCount, lastEnquiryDate), linked to the
 * earliest lead for that phone/email via originalLeadId, keeps status "new", and a history entry is
 * written on both leads. It runs on every Lead create, so all intake paths (manual, import, forms,
 * API, Meta, Google, Zapier, WhatsApp...) are covered without touching them. Organisations with the
 * toggle OFF are never affected: the flag is checked first and nothing else runs.
 */
const FLAG_TTL_MS = 10_000;
const flagCache = new Map<string, { v: boolean; at: number }>();

async function isEnabled(prisma: any, orgId: string): Promise<boolean> {
    const hit = flagCache.get(orgId);
    if (hit && Date.now() - hit.at < FLAG_TTL_MS) return hit.v;
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { allowDuplicateLeads: true } });
    const v = !!org?.allowDuplicateLeads;
    flagCache.set(orgId, { v, at: Date.now() });
    return v;
}

export function registerRepeatEnquiryMiddleware(prisma: any): void {
    prisma.$use(async (params: any, next: (p: any) => Promise<any>) => {
        if (params.model !== 'Lead' || params.action !== 'create' || !params.args?.data) return next(params);

        const data = params.args.data;
        const orgId: string | undefined = data.organisationId ?? data.organisation?.connect?.id;
        if (!orgId || data.originalLeadId) return next(params); // already linked (e.g. manual split-off)

        let original: any = null;
        let earlierCount = 0;
        try {
            if (!(await isEnabled(prisma, orgId))) return next(params);

            const digits = String(data.phone || '').replace(/\D/g, '');
            const core = digits.length >= 10 ? digits.slice(-10) : digits;
            const or: any[] = [];
            if (core) or.push({ phone: { endsWith: core } }, { secondaryPhone: { endsWith: core } });
            const email = typeof data.email === 'string' ? data.email.trim() : '';
            if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
            if (or.length) {
                const matches = await prisma.lead.findMany({
                    where: { organisationId: orgId, isDeleted: false, OR: or },
                    orderBy: { createdAt: 'asc' },
                    select: { id: true, firstName: true, lastName: true, assignedToId: true }
                });
                earlierCount = matches.length;
                original = matches[0] || null;
            }
        } catch (e) {
            console.error('[RepeatEnquiry] lookup failed; creating lead without the link', e);
            return next(params);
        }
        if (!original) return next(params);

        const originalName = `${original.firstName || ''} ${original.lastName || ''}`.trim() || 'Unnamed';
        const prevDetails = data.sourceDetails && typeof data.sourceDetails === 'object' && !Array.isArray(data.sourceDetails) ? data.sourceDetails : {};
        params.args = {
            ...params.args,
            data: {
                ...data,
                isReEnquiry: true,
                reEnquiryCount: earlierCount,
                lastEnquiryDate: new Date(),
                originalLeadId: original.id,
                sourceDetails: { ...prevDetails, repeatEnquiryOf: { leadId: original.id, name: originalName } },
            },
        };

        const created = await next(params);

        // History on both leads (best effort: never fail the lead creation over a log line).
        prisma.leadHistory.createMany({
            data: [
                { leadId: created.id, fieldName: 'reEnquiry', oldValue: null, newValue: original.id, reason: `Repeat enquiry: same number/email as an earlier lead (${originalName}). Created as a new lead because this organisation keeps repeat enquiries separate.` },
                { leadId: original.id, fieldName: 'reEnquiry', oldValue: null, newValue: created.id, reason: `Repeat enquiry received - created as a new separate lead (${created.firstName || ''} ${created.lastName || ''}`.trim() + ').' },
            ],
        }).catch((e: any) => console.error('[RepeatEnquiry] history write failed', e));

        return created;
    });
}
