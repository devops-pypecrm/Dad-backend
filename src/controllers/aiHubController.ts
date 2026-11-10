import { Request, Response } from 'express';
import { getOrgId } from '../utils/hierarchyUtils';
import { isOrgAdmin } from '../utils/roleUtils';
import * as hub from '../services/aiHubService';

type Handler = (orgId: string, req: Request) => Promise<any>;
const wrap = (fn: Handler) => async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!isOrgAdmin(user)) return res.status(403).json({ message: 'AI features are available to admins only' });
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation' });
        const data = await fn(orgId, req);
        if (data === null) return res.status(404).json({ message: 'Not found, or the AI service is unavailable right now' });
        res.json(data);
    } catch (e) {
        console.error('[aiHubController]', e);
        res.status(500).json({ message: 'AI request failed' });
    }
};

export const briefing = wrap((o) => hub.dailyBriefing(o));
export const hotLeads = wrap(async (o) => ({ leads: await hub.hotLeads(o) }));
export const forecast = wrap((o) => hub.forecast(o));
export const teamCoach = wrap((o) => hub.teamCoach(o));
export const summarizeLead = wrap((o, req) => hub.summarizeLead(o, String(req.params.leadId)));
export const draft = wrap((o, req) => {
    const { leadId, channel, goal, tone, language } = req.body || {};
    if (!leadId) return Promise.resolve(null);
    return hub.draftMessage(o, String(leadId), { channel: String(channel || 'whatsapp'), goal: String(goal || '').slice(0, 300), tone: String(tone || '').slice(0, 60), language: language ? String(language).slice(0, 30) : undefined });
});
export const searchLeads = wrap(async (o, req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return { leads: [] };
    const { default: prisma } = await import('../config/prisma');
    const leads = await prisma.lead.findMany({
        where: { organisationId: o, isDeleted: false, OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }, { company: { contains: q, mode: 'insensitive' } }] },
        select: { id: true, firstName: true, lastName: true, phone: true, status: true }, take: 8,
    });
    return { leads: leads.map((l) => ({ id: l.id, name: `${l.firstName} ${l.lastName || ''}`.trim(), phone: l.phone, status: l.status })) };
});
