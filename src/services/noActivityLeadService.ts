import crypto from 'crypto';
import prisma from '../config/prisma';
import { generateInsight } from './aiService';

// A lead is "no activity" when it is still a live prospect (valid status, no
// opportunity) but nobody has touched it for STALE_DAYS. This module owns that
// definition so the dashboard count, the list page and the clean-up tool never
// disagree.

export const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StatusCategory = 'active' | 'closed' | 'invalid';

export interface StatusClassification {
    id: string;
    label: string;
    category: StatusCategory;
    source: 'system' | 'ai' | 'keywords';
    leadCount?: number;
}

// Statuses that are final by definition, regardless of what an org calls them.
const ALWAYS_CLOSED = ['converted', 'lost', 'won', 'closed', 'closed_won', 'closed_lost'];

const INVALID_WORDS = /(invalid|wrong\s*(number|no)|junk|spam|fake|dnd|do\s*not\s*(call|disturb)|not\s*reachable|unreachable|duplicate|test\s*lead|blacklist|incorrect|no\s*requirement|not\s*interested|not\s*eligible|not\s*enquired|never\s*enquired)/i;
const CLOSED_WORDS = /(won|lost|closed|converted|admitted|enrolled|joined|registered|sale\s*done|completed|booked)/i;

function keywordCategory(id: string, label: string): StatusCategory {
    const text = `${id} ${label}`.replace(/_/g, ' ');
    if (ALWAYS_CLOSED.includes(id.toLowerCase())) return 'closed';
    if (INVALID_WORDS.test(text)) return 'invalid';
    if (CLOSED_WORDS.test(text)) return 'closed';
    return 'active';
}

const DEFAULT_STATUSES = [
    { id: 'new', label: 'New' }, { id: 'contacted', label: 'Contacted' }, { id: 'interested', label: 'Interested' },
    { id: 'pre_qualified', label: 'Pre-qualified Lead' }, { id: 'qualified', label: 'Qualified Lead' },
    { id: 'nurturing', label: 'Nurturing' }, { id: 'converted', label: 'Converted' }, { id: 'lost', label: 'Lost' },
    { id: 'not_interested', label: 'Not Interested' }, { id: 're_enquiry', label: 'Re-Enquiry' },
    { id: 'shuffled_lead', label: 'Shuffled' },
];

async function getOrgStatusList(orgId: string): Promise<{ id: string; label: string }[]> {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { leadStatuses: true } });
    const configured = Array.isArray(org?.leadStatuses) ? (org!.leadStatuses as any[]) : [];
    const list = configured.length ? configured : DEFAULT_STATUSES;
    const seen = new Set<string>();
    const out: { id: string; label: string }[] = [];
    for (const s of list) {
        if (!s?.id || seen.has(s.id)) continue;
        seen.add(s.id);
        out.push({ id: String(s.id), label: String(s.label || s.id) });
    }
    // Statuses that exist on leads but were later removed from the org config still count.
    const used: { status: string }[] = await prisma.lead.groupBy({
        by: ['status'], where: { organisationId: orgId, isDeleted: false }, _count: true,
    }).then((rows: any[]) => rows.map(r => ({ status: r.status })));
    for (const u of used) {
        if (u.status && !seen.has(u.status)) { seen.add(u.status); out.push({ id: u.status, label: u.status }); }
    }
    return out;
}

const settingKey = (orgId: string) => `no_activity_status_class:${orgId}`;

function statusHash(list: { id: string; label: string }[]) {
    return crypto.createHash('sha1').update(JSON.stringify(list.map(s => [s.id, s.label]))).digest('hex');
}

// Gathers real evidence per status (how many leads, how many ever got an
// interaction, how many turned into opportunities, sample enquiries) so the AI
// judges the status by how leads in it actually behave, not by its name alone.
async function buildEvidence(orgId: string, list: { id: string; label: string }[]) {
    const evidence: any[] = [];
    for (const s of list) {
        const where = { organisationId: orgId, isDeleted: false, status: s.id };
        const [count, sample] = await Promise.all([
            prisma.lead.count({ where }),
            prisma.lead.findMany({ where, select: { id: true, enquiryAbout: true }, take: 25, orderBy: { updatedAt: 'desc' } }),
        ]);
        let withInteraction = 0, withOpp = 0;
        if (sample.length) {
            const ids = sample.map(l => l.id);
            const [inter, opps] = await Promise.all([
                prisma.interaction.findMany({ where: { organisationId: orgId, leadId: { in: ids } }, select: { leadId: true }, distinct: ['leadId'] }),
                prisma.opportunity.findMany({ where: { organisationId: orgId, leadId: { in: ids } }, select: { leadId: true }, distinct: ['leadId'] }),
            ]);
            withInteraction = inter.length; withOpp = opps.length;
        }
        evidence.push({
            id: s.id, label: s.label, leads: count, sampled: sample.length,
            sampledWithInteraction: withInteraction, sampledWithOpportunity: withOpp,
            sampleEnquiries: sample.map(l => l.enquiryAbout).filter(Boolean).slice(0, 3),
        });
    }
    return evidence;
}

async function classifyWithAi(evidence: any[]): Promise<Record<string, StatusCategory> | null> {
    const prompt = `You classify CRM lead statuses for ONE company. Statuses are custom names, so judge by name AND the evidence of how leads in each status behave.
Categories:
- "active": the lead is still a live prospect worth following up (new, contacted, interested, follow-up, nurturing, callback, qualified, etc.)
- "closed": the lead's journey ended successfully or finally (won, converted, admitted/enrolled/joined, sale done, lost to competitor, closed)
- "invalid": the lead is dead or junk and should never be followed up (invalid/wrong number, spam, fake, duplicate, not interested, no requirement, DND, not reachable)
Evidence per status (JSON): ${JSON.stringify(evidence)}
Reply with ONLY a JSON object mapping every status id to its category, e.g. {"new":"active","wrong_number":"invalid"}.`;
    const text = await generateInsight(prompt);
    if (!text) return null;
    try {
        const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        const out: Record<string, StatusCategory> = {};
        for (const [k, v] of Object.entries(json)) {
            if (v === 'active' || v === 'closed' || v === 'invalid') out[k] = v;
        }
        return out;
    } catch {
        return null;
    }
}

/**
 * Per-org classification of every lead status. Cached in SystemSetting and
 * rebuilt when the org's status list changes (or when `force` is set).
 */
export async function getStatusClassification(orgId: string, force = false): Promise<StatusClassification[]> {
    const list = await getOrgStatusList(orgId);
    const hash = statusHash(list);
    const key = settingKey(orgId);

    if (!force) {
        const cached = await prisma.systemSetting.findUnique({ where: { key } });
        if (cached) {
            try {
                const parsed = JSON.parse(cached.value);
                if (parsed.hash === hash) return parsed.items;
            } catch { /* rebuild */ }
        }
    }

    const evidence = await buildEvidence(orgId, list);
    const ai = await classifyWithAi(evidence);

    const items: StatusClassification[] = list.map(s => {
        const leadCount = evidence.find(e => e.id === s.id)?.leads ?? 0;
        // Built-in terminal statuses are never overridden by AI.
        if (ALWAYS_CLOSED.includes(s.id.toLowerCase())) {
            return { ...s, category: 'closed', source: 'system', leadCount };
        }
        if (ai?.[s.id]) return { ...s, category: ai[s.id], source: 'ai', leadCount };
        return { ...s, category: keywordCategory(s.id, s.label), source: 'keywords', leadCount };
    });

    await prisma.systemSetting.upsert({
        where: { key },
        create: { key, group: 'no_activity_status_class', value: JSON.stringify({ hash, items }) },
        update: { value: JSON.stringify({ hash, items }) },
    });
    return items;
}

export async function getActiveStatusIds(orgId: string): Promise<string[]> {
    return (await getStatusClassification(orgId)).filter(s => s.category === 'active').map(s => s.id);
}

export const staleThreshold = (days = STALE_DAYS) => new Date(Date.now() - days * DAY_MS);

// Lead ids to leave out of any no-activity result: leads with an interaction in the
// window, and leads that became an opportunity (won/lost/open - the work lives on the
// opportunity now). Fetched per org first, because Prisma's `none` filter compiles to
// an org-unscoped NOT IN (see the note on getLeadHealth in analyticsController.ts).
export async function getExcludedLeadIds(orgId: string, threshold: Date): Promise<string[]> {
    const [recent, withOpp] = await Promise.all([
        prisma.interaction.findMany({
            where: { organisationId: orgId, leadId: { not: null }, date: { gte: threshold } },
            select: { leadId: true }, distinct: ['leadId'],
        }),
        prisma.opportunity.findMany({
            where: { organisationId: orgId, isDeleted: false, leadId: { not: null } },
            select: { leadId: true }, distinct: ['leadId'],
        }),
    ]);
    return Array.from(new Set([...recent, ...withOpp].map(r => r.leadId as string)));
}

/** Base where for "no activity" leads, restricted to statuses a rep could still work. */
export async function buildNoActivityWhere(orgId: string, days = STALE_DAYS) {
    const threshold = staleThreshold(days);
    const [excludedIds, activeIds] = await Promise.all([
        getExcludedLeadIds(orgId, threshold),
        getActiveStatusIds(orgId),
    ]);
    return {
        threshold,
        where: {
            organisationId: orgId,
            isDeleted: false,
            status: { in: activeIds },
            updatedAt: { lt: threshold },
            id: { notIn: excludedIds },
        } as any,
    };
}

// ---------------------------------------------------------------------------
// Clean-up tool: preview + soft-delete of stale leads picked by admin filters.
// ---------------------------------------------------------------------------

export interface CleanupFilters {
    statuses: string[];            // required - which lead statuses to clean
    inactiveDays?: number;         // untouched for at least N days (min 30)
    createdBefore?: string;        // ISO date
    createdAfter?: string;
    ownerIds?: string[];           // assigned to any of these users
    includeUnassigned?: boolean;   // ...and/or unassigned
    sources?: string[];
    neverContacted?: boolean;      // only leads with zero logged interactions ever
}

export async function buildCleanupWhere(orgId: string, f: CleanupFilters) {
    const days = Math.max(STALE_DAYS, Number(f.inactiveDays) || STALE_DAYS);
    const threshold = staleThreshold(days);

    const [recent, ever, withOpp, withContact, withAccount] = await Promise.all([
        prisma.interaction.findMany({
            where: { organisationId: orgId, leadId: { not: null }, date: { gte: threshold } },
            select: { leadId: true }, distinct: ['leadId'],
        }),
        f.neverContacted
            ? prisma.interaction.findMany({ where: { organisationId: orgId, leadId: { not: null } }, select: { leadId: true }, distinct: ['leadId'] })
            : Promise.resolve([] as { leadId: string | null }[]),
        prisma.opportunity.findMany({ where: { organisationId: orgId, leadId: { not: null } }, select: { leadId: true }, distinct: ['leadId'] }),
        prisma.contact.findMany({ where: { organisationId: orgId, isDeleted: false, leadId: { not: null } }, select: { leadId: true }, distinct: ['leadId'] }),
        prisma.account.findMany({ where: { organisationId: orgId, isDeleted: false, leadId: { not: null } }, select: { leadId: true }, distinct: ['leadId'] }),
    ]);
    // Leads that became an opportunity/contact/account are customers now - never cleaned
    // here, because deleting a lead cascades to those records.
    const protectedIds = Array.from(new Set(
        [...recent, ...ever, ...withOpp, ...withContact, ...withAccount].map(r => r.leadId as string)
    ));

    const where: any = {
        organisationId: orgId,
        isDeleted: false,
        status: { in: f.statuses },
        updatedAt: { lt: threshold },
        id: { notIn: protectedIds },
    };
    const created: any = {};
    if (f.createdBefore) created.lt = new Date(f.createdBefore);
    if (f.createdAfter) created.gte = new Date(f.createdAfter);
    if (Object.keys(created).length) where.createdAt = created;

    const ownerOr: any[] = [];
    if (f.ownerIds?.length) ownerOr.push({ assignedToId: { in: f.ownerIds } });
    if (f.includeUnassigned) ownerOr.push({ assignedToId: null });
    if (ownerOr.length) where.OR = ownerOr;

    if (f.sources?.length) where.source = { in: f.sources };
    return { where, days };
}

export async function previewCleanup(orgId: string, f: CleanupFilters) {
    const { where, days } = await buildCleanupWhere(orgId, f);
    const [total, byStatus, range, sample] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.groupBy({ by: ['status'], where, _count: true }),
        prisma.lead.aggregate({ where, _min: { createdAt: true }, _max: { createdAt: true } }),
        prisma.lead.findMany({
            where, take: 15, orderBy: { updatedAt: 'asc' },
            select: { id: true, firstName: true, lastName: true, phone: true, status: true, createdAt: true, updatedAt: true },
        }),
    ]);
    return {
        total,
        inactiveDays: days,
        byStatus: byStatus.map((r: any) => ({ status: r.status, count: r._count })),
        oldestCreated: range._min.createdAt,
        newestCreated: range._max.createdAt,
        sample,
    };
}

const BATCH = 1000;

export async function executeCleanup(orgId: string, f: CleanupFilters, expectedCount: number) {
    const { where } = await buildCleanupWhere(orgId, f);
    const total = await prisma.lead.count({ where });
    if (total !== expectedCount) {
        return { ok: false as const, total };
    }
    let deleted = 0;
    const now = new Date();
    while (deleted < total) {
        const ids = (await prisma.lead.findMany({ where, select: { id: true }, take: BATCH })).map(l => l.id);
        if (!ids.length) break;
        // Re-check org + not-deleted inside the update so a concurrent change can't widen it.
        const res = await prisma.lead.updateMany({
            where: { id: { in: ids }, organisationId: orgId, isDeleted: false },
            data: { isDeleted: true, deletedAt: now },
        });
        deleted += res.count;
        if (res.count === 0) break;
    }
    return { ok: true as const, deleted };
}
