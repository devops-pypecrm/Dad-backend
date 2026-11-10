import axios from 'axios';
import prisma from '../config/prisma';
import { buildOrgSnapshot } from './aiAssistantService';

const GEMINI_MODEL = 'gemini-3.6-flash';

/** One-shot Gemini call. With `json` the model is forced to return parseable JSON. */
async function gemini<T = string>(system: string, user: string, json = false, maxTokens = 1200): Promise<T | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const r = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
                {
                    system_instruction: { parts: [{ text: system }] },
                    contents: [{ role: 'user', parts: [{ text: user }] }],
                    generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 }, ...(json ? { responseMimeType: 'application/json' } : {}) },
                },
                { timeout: 25000 }
            );
            const text: string | undefined = r.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('');
            if (!text) return null;
            return (json ? JSON.parse(text) : text) as T;
        } catch (e) {
            const status = (e as any).response?.status;
            if (attempt === 3 || ![429, 503].includes(status)) { console.error('[aiHub] gemini failed', status || (e as Error).message); return null; }
            await new Promise((r) => setTimeout(r, 700 * attempt));
        }
    }
    return null;
}

const CLOSED = /won|lost|convert|closed|junk|invalid|dead|not.?interested/i;
const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');
const daysAgo = (d?: Date | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null);

export interface Briefing { headline: string; highlights: string[]; risks: string[]; actions: string[] }

export async function dailyBriefing(orgId: string): Promise<{ briefing: Briefing | null; snapshot: any }> {
    const snapshot = await buildOrgSnapshot(orgId);
    const briefing = await gemini<Briefing>(
        'You are a sales operations analyst briefing a CRM admin. Using ONLY the data given, return JSON {"headline": one sentence, "highlights": 3-4 short bullets of what is going well or notable, "risks": 2-4 short bullets of problems (overdue follow-ups, stalled stages, low conversion), "actions": 3 concrete things to do today}. Never invent numbers.',
        JSON.stringify(snapshot), true, 900
    );
    return { briefing, snapshot };
}

export interface HotLead { id: string; name: string; phone: string; status: string; source: string; owner: string; lastContactDays: number | null; reason: string; nextAction: string; urgency: 'high' | 'medium' | 'low' }

export async function hotLeads(orgId: string): Promise<HotLead[]> {
    const rows = await prisma.lead.findMany({
        where: { organisationId: orgId, isDeleted: false },
        orderBy: [{ isHotLead: 'desc' }, { leadScore: 'desc' }, { updatedAt: 'desc' }],
        take: 60,
        select: {
            id: true, firstName: true, lastName: true, phone: true, status: true, source: true, leadScore: true, engagementScore: true, isHotLead: true, enquiryAbout: true,
            lastContactDate: true, nextFollowUp: true, createdAt: true, updatedAt: true, isReEnquiry: true, reEnquiryCount: true,
            assignedTo: { select: { firstName: true, lastName: true } },
        },
    });
    const open = rows.filter((l) => !CLOSED.test(l.status || '')).slice(0, 25);
    if (!open.length) return [];
    const compact = open.map((l) => ({
        id: l.id, name: `${l.firstName} ${l.lastName || ''}`.trim(), status: l.status, source: l.source, score: l.leadScore, engagement: l.engagementScore, hot: l.isHotLead,
        interest: l.enquiryAbout, ageDays: daysAgo(l.createdAt), lastContactDays: daysAgo(l.lastContactDate), followUpDue: l.nextFollowUp, reEnquiry: l.reEnquiryCount,
    }));
    const ai = await gemini<{ picks: { id: string; reason: string; nextAction: string; urgency: string }[] }>(
        'You prioritise sales leads. From the list, choose up to 8 leads most worth contacting TODAY (high score/engagement, re-enquiries, overdue or missing follow-ups, recent interest, going cold). Return JSON {"picks":[{"id","reason":"max 18 words","nextAction":"max 14 words","urgency":"high|medium|low"}]} ordered by priority. Use only ids from the list.',
        JSON.stringify(compact), true, 1200
    );
    const byId = new Map(open.map((l) => [l.id, l]));
    const picks = ai?.picks?.filter((p) => byId.has(p.id)) ?? [];
    const source = picks.length ? picks : open.slice(0, 8).map((l) => ({ id: l.id, reason: l.isHotLead ? 'Marked as a hot lead' : `Lead score ${l.leadScore}`, nextAction: 'Call or message today', urgency: 'medium' }));
    return source.map((p) => {
        const l = byId.get(p.id)!;
        return { id: l.id, name: `${l.firstName} ${l.lastName || ''}`.trim(), phone: l.phone, status: l.status, source: String(l.source), owner: fullName(l.assignedTo), lastContactDays: daysAgo(l.lastContactDate), reason: p.reason, nextAction: p.nextAction, urgency: (['high', 'medium', 'low'].includes(p.urgency) ? p.urgency : 'medium') as any };
    });
}

export async function draftMessage(orgId: string, leadId: string, opts: { channel: string; goal: string; tone: string; language?: string }) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, organisationId: orgId, isDeleted: false } });
    if (!lead) return null;
    const history = await prisma.interaction.findMany({ where: { leadId, organisationId: orgId }, orderBy: { date: 'desc' }, take: 8, select: { type: true, direction: true, subject: true, description: true, date: true } });
    const channel = ['email', 'whatsapp', 'sms'].includes(opts.channel) ? opts.channel : 'whatsapp';
    const out = await gemini<{ subject?: string; body: string }>(
        `You write ${channel} messages for a sales rep. Tone: ${opts.tone || 'friendly and professional'}. Language: ${opts.language || 'English'}. Goal: ${opts.goal || 'follow up'}.
Rules: ${channel === 'email' ? 'include a short subject; 90-150 words.' : 'no subject; under 60 words; conversational.'} Use the lead's first name. Reference their interest/history naturally. Do not invent prices, discounts or promises. Return JSON {"subject": string or null, "body": string}.`,
        JSON.stringify({ lead: { name: `${lead.firstName} ${lead.lastName || ''}`.trim(), company: lead.company, interest: lead.enquiryAbout, status: lead.status, source: lead.source }, recentInteractions: history }),
        true, 700
    );
    return out ? { channel, subject: out.subject || null, body: out.body } : null;
}

export async function summarizeLead(orgId: string, leadId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, organisationId: orgId, isDeleted: false }, include: { assignedTo: { select: { firstName: true, lastName: true } } } });
    if (!lead) return null;
    const [interactions, followUps] = await Promise.all([
        prisma.interaction.findMany({ where: { leadId, organisationId: orgId }, orderBy: { date: 'desc' }, take: 15, select: { type: true, direction: true, subject: true, description: true, date: true } }),
        prisma.followUp.findMany({ where: { leadId, isDeleted: false }, orderBy: { dueDate: 'desc' }, take: 5, select: { dueDate: true, status: true, description: true } }).catch(() => []),
    ]);
    const ai = await gemini<{ summary: string; sentiment: string; keyPoints: string[]; nextStep: string }>(
        'Summarise this CRM lead for a manager. Return JSON {"summary": 2-3 sentences, "sentiment": "positive|neutral|negative|unknown", "keyPoints": up to 4 short bullets (needs, objections, budget, timing), "nextStep": one concrete next action}. Use only the data given.',
        JSON.stringify({ lead: { name: `${lead.firstName} ${lead.lastName || ''}`.trim(), status: lead.status, source: lead.source, interest: lead.enquiryAbout, owner: fullName(lead.assignedTo), createdDaysAgo: daysAgo(lead.createdAt), lastContactDaysAgo: daysAgo(lead.lastContactDate) }, interactions, followUps }),
        true, 700
    );
    return ai ? { leadName: `${lead.firstName} ${lead.lastName || ''}`.trim(), ...ai } : null;
}

export async function forecast(orgId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const base = { organisationId: orgId, isDeleted: false };
    const [open, wonRecent] = await Promise.all([
        prisma.opportunity.findMany({
            where: { ...base, stage: { notIn: ['closed_won', 'closed_lost'] } },
            select: { id: true, name: true, amount: true, stage: true, probability: true, closeDate: true, updatedAt: true, createdAt: true, account: { select: { name: true } }, owner: { select: { firstName: true, lastName: true } } },
            take: 500,
        }),
        prisma.opportunity.findMany({ where: { ...base, stage: 'closed_won', closeDate: { gte: new Date(now.getFullYear(), now.getMonth() - 5, 1) } }, select: { amount: true, closeDate: true } }),
    ]);
    const weighted = open.reduce((s, o) => s + (o.amount || 0) * ((o.probability ?? 0) / 100), 0);
    const pipeline = open.reduce((s, o) => s + (o.amount || 0), 0);
    const closingThisMonth = open.filter((o) => o.closeDate && o.closeDate >= monthStart && o.closeDate < monthEnd);
    const byStage: Record<string, { count: number; amount: number }> = {};
    open.forEach((o) => { const b = (byStage[o.stage] ||= { count: 0, amount: 0 }); b.count++; b.amount += o.amount || 0; });
    const monthly: Record<string, { count: number; amount: number }> = {};
    wonRecent.forEach((o) => { if (!o.closeDate) return; const k = `${o.closeDate.getFullYear()}-${String(o.closeDate.getMonth() + 1).padStart(2, '0')}`; const b = (monthly[k] ||= { count: 0, amount: 0 }); b.count++; b.amount += o.amount || 0; });
    const wonThisMonth = wonRecent.filter((o) => o.closeDate && o.closeDate >= monthStart).reduce((s, o) => s + (o.amount || 0), 0);

    const atRisk = open
        .map((o) => ({ id: o.id, name: o.name, account: o.account?.name || '', owner: fullName(o.owner), stage: o.stage, amount: o.amount, idleDays: daysAgo(o.updatedAt) ?? 0, overdueClose: !!(o.closeDate && o.closeDate < now) }))
        .filter((o) => o.idleDays >= 14 || o.overdueClose)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);

    const stats = { pipelineTotal: pipeline, weightedForecast: Math.round(weighted), openDeals: open.length, closingThisMonth: { count: closingThisMonth.length, amount: closingThisMonth.reduce((s, o) => s + (o.amount || 0), 0) }, wonThisMonth, byStage, wonByMonth: monthly };
    const ai = await gemini<{ outlook: string; advice: string[]; dealActions: { id: string; action: string }[] }>(
        'You are a sales forecasting analyst. Return JSON {"outlook": 2-3 sentences on likely revenue this month and the trend vs recent months, "advice": 3 short recommendations, "dealActions":[{"id","action":"max 14 words rescue step"}] for the at-risk deals}. Use only the given numbers; do not invent figures.',
        JSON.stringify({ stats, atRisk }), true, 1000
    );
    const actions = new Map((ai?.dealActions || []).map((d) => [d.id, d.action]));
    return { stats, outlook: ai?.outlook || null, advice: ai?.advice || [], atRisk: atRisk.map((o) => ({ ...o, action: actions.get(o.id) || 'Reach out to the customer and re-confirm timing' })) };
}

export async function teamCoach(orgId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const users = await prisma.user.findMany({ where: { organisationId: orgId, isActive: true }, select: { id: true, firstName: true, lastName: true, role: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return { members: [], summary: null };
    const [newLeads, openLeads, won, overdue, calls] = await Promise.all([
        prisma.lead.groupBy({ by: ['assignedToId'], where: { organisationId: orgId, isDeleted: false, assignedToId: { in: ids }, createdAt: { gte: monthStart } }, _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['assignedToId'], where: { organisationId: orgId, isDeleted: false, assignedToId: { in: ids } }, _count: { _all: true } }),
        prisma.opportunity.groupBy({ by: ['ownerId'], where: { organisationId: orgId, isDeleted: false, stage: 'closed_won', closeDate: { gte: monthStart }, ownerId: { in: ids } }, _count: { _all: true }, _sum: { amount: true } }),
        prisma.followUp.groupBy({ by: ['assignedToId' as any], where: { organisationId: orgId, isDeleted: false, dueDate: { lt: now }, status: { notIn: ['completed'] as any }, assignedToId: { in: ids } } as any, _count: { _all: true } }).catch(() => [] as any[]),
        prisma.interaction.groupBy({ by: ['createdById'], where: { organisationId: orgId, type: 'call', date: { gte: monthStart }, createdById: { in: ids } }, _count: { _all: true } }),
    ]);
    const m = (rows: any[], key: string) => new Map(rows.map((r) => [r[key], r]));
    const nl = m(newLeads, 'assignedToId'), ol = m(openLeads, 'assignedToId'), w = m(won, 'ownerId'), od = m(overdue as any[], 'assignedToId'), c = m(calls, 'createdById');
    const members = users.map((u) => ({
        id: u.id, name: fullName(u), role: u.role,
        newLeadsThisMonth: (nl.get(u.id) as any)?._count._all || 0, totalLeads: (ol.get(u.id) as any)?._count._all || 0,
        wonThisMonth: (w.get(u.id) as any)?._count._all || 0, wonAmount: (w.get(u.id) as any)?._sum.amount || 0,
        overdueFollowUps: (od.get(u.id) as any)?._count._all || 0, callsThisMonth: (c.get(u.id) as any)?._count._all || 0,
    })).filter((x) => x.totalLeads + x.wonThisMonth + x.callsThisMonth > 0).sort((a, b) => b.wonAmount - a.wonAmount || b.callsThisMonth - a.callsThisMonth).slice(0, 25);
    const ai = await gemini<{ summary: string; coaching: { id: string; note: string }[] }>(
        'You are a sales coach advising a manager. Return JSON {"summary": 2 sentences on overall team performance, "coaching":[{"id","note":"max 20 words: one strength or one thing to fix, based only on their numbers"}]} covering every member given.',
        JSON.stringify(members.map(({ id, name, ...rest }) => ({ id, name, ...rest }))), true, 1400
    );
    const notes = new Map((ai?.coaching || []).map((x) => [x.id, x.note]));
    return { summary: ai?.summary || null, members: members.map((x) => ({ ...x, note: notes.get(x.id) || '' })) };
}
