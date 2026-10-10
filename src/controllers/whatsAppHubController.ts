import { Request } from 'express';
import prisma from '../config/prisma';
import { HttpError, handle, orgOf, str } from '../utils/whatsappHttp';
import { WhatsAppTemplateService } from '../services/whatsAppTemplateService';
import { WhatsAppAutoResponderService } from '../services/whatsAppAutoResponderService';
import { WhatsAppNurtureService } from '../services/whatsAppNurtureService';
import { WhatsAppAIService } from '../services/whatsAppAIService';
import { WhatsAppComplianceService } from '../services/whatsAppComplianceService';
import { WhatsAppHealthService } from '../services/whatsAppHealthService';
import { CHATBOT_TEMPLATES, buildFlowFromTemplate, getChatbotTemplate } from '../services/whatsAppChatbotLibrary';
import { DEFAULT_WORKING_HOURS, PARAM_SOURCES } from '../utils/whatsappAutomation';
import { digitsOnly } from '../utils/whatsappPhone';

const userOf = (req: Request) => (req as any).user as { id: string };
const LEAD_SOURCES = ['website', 'referral', 'social', 'paid_ad', 'import', 'api', 'manual', 'whatsapp', 'meta_leadgen', 'cold_call', 'social_media', 'email_campaign', 'meta_ads', 'google_ads', 'facebook_payload', 'lead_squared', 'zapier', 'other'];

const cleanSources = (v: any): string[] => (Array.isArray(v) ? v.filter((s: any) => LEAD_SOURCES.includes(s)) : []);

const cleanParams = (v: any) =>
    (Array.isArray(v) ? v : []).slice(0, 10).map((p: any) => ({
        source: (PARAM_SOURCES as readonly string[]).includes(p?.source) ? p.source : 'static',
        value: str(p?.value, 200)
    }));

/** A template used for business-initiated messages must exist and be approved. */
const assertApprovedTemplate = async (orgId: string, name: string, language: string) => {
    if (!name) throw new HttpError(400, 'Choose a template');
    let tpl = await WhatsAppTemplateService.findApproved(orgId, name, language);
    if (!tpl) {
        await WhatsAppTemplateService.syncFromMeta(orgId).catch(() => undefined);
        tpl = await WhatsAppTemplateService.findApproved(orgId, name, language);
    }
    if (!tpl) throw new HttpError(400, `Template "${name}" (${language}) is not approved. Only approved templates can be used to message new leads.`);
};

const cleanHours = (v: any) => {
    if (!v || typeof v !== 'object') return DEFAULT_WORKING_HOURS;
    const out: any = {};
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
        const day = v[d];
        out[d] = day && /^\d{2}:\d{2}$/.test(day.start) && /^\d{2}:\d{2}$/.test(day.end) ? { start: day.start, end: day.end } : null;
    }
    return out;
};

// ===================== templates =====================
export const listTemplates = handle(async (req, res) => {
    const rows = await WhatsAppTemplateService.list(orgOf(req), { status: str(req.query.status as string, 20) || undefined, refresh: req.query.refresh === '1' });
    res.json(rows);
});
export const syncTemplates = handle(async (req, res) => {
    res.json(await WhatsAppTemplateService.syncFromMeta(orgOf(req)));
});
export const createTemplateHandler = handle(async (req, res) => {
    const { name, category, language, components, accountId } = req.body || {};
    if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) throw new HttpError(400, 'Invalid category');
    if (!Array.isArray(components) || !components.length) throw new HttpError(400, 'Template components are required');
    res.status(201).json(await WhatsAppTemplateService.create(orgOf(req), { name, category, language: language || 'en_US', components }, accountId));
});
export const deleteTemplateHandler = handle(async (req, res) => {
    await WhatsAppTemplateService.remove(orgOf(req), req.params.name);
    res.json({ success: true });
});

// ===================== auto responders =====================
const responderBody = async (orgId: string, b: any) => {
    const templateLanguage = str(b.templateLanguage, 20) || 'en_US';
    const templateName = str(b.templateName, 512);
    await assertApprovedTemplate(orgId, templateName, templateLanguage);
    return {
        name: str(b.name, 120) || 'Welcome message',
        whatsappAccountId: b.whatsappAccountId || null,
        templateName, templateLanguage,
        templateParams: cleanParams(b.templateParams),
        delayMinutes: Math.min(Math.max(parseInt(b.delayMinutes) || 0, 0), 60 * 24 * 7),
        sources: cleanSources(b.sources),
        workingHoursEnabled: !!b.workingHoursEnabled,
        workingHours: cleanHours(b.workingHours),
        timezone: str(b.timezone, 60) || 'Asia/Kolkata',
        outsideHoursBehavior: b.outsideHoursBehavior === 'skip' ? 'skip' : 'wait'
    };
};

export const listResponders = handle(async (req, res) => {
    const rows = await prisma.whatsAppAutoResponder.findMany({ where: { organisationId: orgOf(req), isDeleted: false }, orderBy: { createdAt: 'desc' } });
    const withStats = await Promise.all(rows.map(async r => ({ ...r, stats: await WhatsAppAutoResponderService.stats(r.id) })));
    res.json(withStats);
});
export const createResponder = handle(async (req, res) => {
    const orgId = orgOf(req);
    const data = await responderBody(orgId, req.body || {});
    const isActive = !!req.body?.isActive;
    res.status(201).json(await prisma.whatsAppAutoResponder.create({ data: { ...data, organisationId: orgId, createdById: userOf(req).id, isActive, activatedAt: isActive ? new Date() : null } as any }));
});
export const updateResponder = handle(async (req, res) => {
    const orgId = orgOf(req);
    const existing = await prisma.whatsAppAutoResponder.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!existing) throw new HttpError(404, 'Auto responder not found');
    const b = req.body || {};
    const data: any = b.templateName !== undefined ? await responderBody(orgId, { ...existing, ...b }) : {};
    if (b.isActive !== undefined) {
        data.isActive = !!b.isActive;
        // switching on starts a fresh baseline: only leads created from now on are answered
        if (data.isActive && !existing.isActive) data.activatedAt = new Date();
    }
    if (data.isActive === true) {
        const tplName = data.templateName || existing.templateName;
        await assertApprovedTemplate(orgId, tplName, data.templateLanguage || existing.templateLanguage);
    }
    res.json(await prisma.whatsAppAutoResponder.update({ where: { id: existing.id }, data }));
});
export const deleteResponder = handle(async (req, res) => {
    const r = await prisma.whatsAppAutoResponder.updateMany({ where: { id: req.params.id, organisationId: orgOf(req) }, data: { isDeleted: true, isActive: false } });
    if (!r.count) throw new HttpError(404, 'Auto responder not found');
    res.json({ success: true });
});
export const responderLogs = handle(async (req, res) => {
    const orgId = orgOf(req);
    const r = await prisma.whatsAppAutoResponder.findFirst({ where: { id: req.params.id, organisationId: orgId } });
    if (!r) throw new HttpError(404, 'Auto responder not found');
    const logs = await prisma.whatsAppAutoResponderLog.findMany({ where: { responderId: r.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    const leads = await prisma.lead.findMany({ where: { id: { in: logs.map(l => l.leadId) } }, select: { id: true, firstName: true, lastName: true } });
    const names = new Map(leads.map(l => [l.id, `${l.firstName} ${l.lastName || ''}`.trim()]));
    res.json(logs.map(l => ({ ...l, leadName: names.get(l.leadId) || 'Lead' })));
});

// ===================== lead nurturing =====================
const nurtureSteps = async (orgId: string, v: any) => {
    if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'Add at least one step');
    if (v.length > 10) throw new HttpError(400, 'A sequence can have at most 10 steps');
    const steps = [];
    for (let i = 0; i < v.length; i++) {
        const s = v[i];
        const language = str(s.templateLanguage, 20) || 'en_US';
        await assertApprovedTemplate(orgId, str(s.templateName, 512), language);
        steps.push({
            position: i, label: str(s.label, 80) || null,
            delayMinutes: Math.min(Math.max(parseInt(s.delayMinutes) || 60, 5), 60 * 24 * 90),
            templateName: str(s.templateName, 512), templateLanguage: language, templateParams: cleanParams(s.templateParams)
        });
    }
    return steps;
};

export const listNurture = handle(async (req, res) => {
    const rows = await prisma.whatsAppNurtureSequence.findMany({ where: { organisationId: orgOf(req), isDeleted: false }, orderBy: { createdAt: 'desc' }, include: { steps: { orderBy: { position: 'asc' } } } });
    res.json(await Promise.all(rows.map(async r => ({ ...r, stats: await WhatsAppNurtureService.stats(r.id) }))));
});
export const createNurture = handle(async (req, res) => {
    const orgId = orgOf(req);
    const b = req.body || {};
    const steps = await nurtureSteps(orgId, b.steps);
    const isActive = !!b.isActive;
    const seq = await prisma.whatsAppNurtureSequence.create({
        data: {
            organisationId: orgId, name: str(b.name, 120) || 'Lead nurture', whatsappAccountId: b.whatsappAccountId || null,
            sources: cleanSources(b.sources), stopOnReply: b.stopOnReply !== false, isActive, activatedAt: isActive ? new Date() : null,
            createdById: userOf(req).id, steps: { create: steps }
        },
        include: { steps: { orderBy: { position: 'asc' } } }
    });
    res.status(201).json(seq);
});
export const updateNurture = handle(async (req, res) => {
    const orgId = orgOf(req);
    const existing = await prisma.whatsAppNurtureSequence.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!existing) throw new HttpError(404, 'Sequence not found');
    const b = req.body || {};
    const data: any = {};
    if (b.name !== undefined) data.name = str(b.name, 120) || existing.name;
    if (b.sources !== undefined) data.sources = cleanSources(b.sources);
    if (b.stopOnReply !== undefined) data.stopOnReply = !!b.stopOnReply;
    if (b.whatsappAccountId !== undefined) data.whatsappAccountId = b.whatsappAccountId || null;
    if (b.isActive !== undefined) {
        data.isActive = !!b.isActive;
        if (data.isActive && !existing.isActive) data.activatedAt = new Date();
    }
    const steps = b.steps !== undefined ? await nurtureSteps(orgId, b.steps) : null;
    const updated = await prisma.$transaction(async tx => {
        if (steps) {
            await tx.whatsAppNurtureStep.deleteMany({ where: { sequenceId: existing.id } });
            await tx.whatsAppNurtureStep.createMany({ data: steps.map(s => ({ ...s, sequenceId: existing.id })) });
        }
        return tx.whatsAppNurtureSequence.update({ where: { id: existing.id }, data, include: { steps: { orderBy: { position: 'asc' } } } });
    });
    res.json(updated);
});
export const deleteNurture = handle(async (req, res) => {
    const orgId = orgOf(req);
    const r = await prisma.whatsAppNurtureSequence.updateMany({ where: { id: req.params.id, organisationId: orgId }, data: { isDeleted: true, isActive: false } });
    if (!r.count) throw new HttpError(404, 'Sequence not found');
    await prisma.whatsAppNurtureEnrollment.updateMany({ where: { sequenceId: req.params.id, status: 'active' }, data: { status: 'cancelled', nextRunAt: null } });
    res.json({ success: true });
});
export const nurtureEnrollments = handle(async (req, res) => {
    const orgId = orgOf(req);
    const seq = await prisma.whatsAppNurtureSequence.findFirst({ where: { id: req.params.id, organisationId: orgId } });
    if (!seq) throw new HttpError(404, 'Sequence not found');
    const rows = await prisma.whatsAppNurtureEnrollment.findMany({ where: { sequenceId: seq.id, ...(req.query.status ? { status: String(req.query.status) } : {}) }, orderBy: { updatedAt: 'desc' }, take: 100 });
    const leads = await prisma.lead.findMany({ where: { id: { in: rows.map(r => r.leadId).filter(Boolean) as string[] } }, select: { id: true, firstName: true, lastName: true } });
    const names = new Map(leads.map(l => [l.id, `${l.firstName} ${l.lastName || ''}`.trim()]));
    res.json(rows.map(r => ({ ...r, leadName: r.leadId ? names.get(r.leadId) || 'Lead' : null })));
});

// ===================== chatbot library =====================
export const chatbotOverview = handle(async (req, res) => {
    const orgId = orgOf(req);
    const flows = await prisma.whatsAppFlow.findMany({ where: { organisationId: orgId, isDeleted: false }, include: { _count: { select: { sessions: true } } } });
    const messagesSent = await prisma.whatsAppMessage.count({ where: { organisationId: orgId, source: 'flow' } });
    const used = new Map(flows.filter(f => f.sourceTemplateKey).map(f => [f.sourceTemplateKey!, f]));
    res.json({
        stats: {
            messagesSent,
            active: flows.filter(f => f.isActive).length,
            inactive: flows.filter(f => !f.isActive).length,
            custom: flows.filter(f => !f.sourceTemplateKey).length,
            systemTemplates: CHATBOT_TEMPLATES.length
        },
        library: CHATBOT_TEMPLATES.map(t => ({
            key: t.key, name: t.name, category: t.category, badge: t.badge, benefit: t.benefit, description: t.description, tags: t.tags,
            triggerKeywords: t.triggerKeywords,
            flowId: used.get(t.key)?.id || null,
            isPublished: used.get(t.key)?.isActive || false
        }))
    });
});
export const useChatbotTemplate = handle(async (req, res) => {
    const orgId = orgOf(req);
    const t = getChatbotTemplate(req.params.key);
    if (!t) throw new HttpError(404, 'Template not found');
    const existing = await prisma.whatsAppFlow.findFirst({ where: { organisationId: orgId, sourceTemplateKey: t.key, isDeleted: false } });
    if (existing) return res.json(existing); // idempotent: one clone per template
    const { nodes, edges } = buildFlowFromTemplate(t);
    const flow = await prisma.whatsAppFlow.create({
        data: {
            organisationId: orgId, name: t.name, description: t.description, category: t.category, sourceTemplateKey: t.key,
            whatsappAccountId: req.body?.whatsappAccountId || null,
            triggerType: 'keyword', triggerKeywords: t.triggerKeywords, isActive: false, nodes, edges, createdById: userOf(req).id
        }
    });
    res.status(201).json(flow);
});
export const publishChatbot = handle(async (req, res) => {
    const orgId = orgOf(req);
    const flow = await prisma.whatsAppFlow.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!flow) throw new HttpError(404, 'Chatbot not found');
    const publish = !!req.body?.publish;
    if (publish) {
        const nodes = (flow.nodes as any[]) || [];
        if (!nodes.length) throw new HttpError(400, 'This chatbot has no steps yet.');
        if (flow.triggerType === 'keyword' && !flow.triggerKeywords.length) throw new HttpError(400, 'Add at least one trigger keyword before publishing.');
    }
    res.json(await prisma.whatsAppFlow.update({ where: { id: flow.id }, data: { isActive: publish } }));
});

// ===================== AI agent =====================
export const aiStatus = handle(async (req, res) => { res.json(await WhatsAppAIService.status(orgOf(req))); });
export const aiUpdateAgent = handle(async (req, res) => {
    const b = req.body || {};
    const clean: any = { ...b };
    if (clean.chatbotName !== undefined) clean.chatbotName = str(clean.chatbotName, 60) || 'AI Assistant';
    if (clean.footerText !== undefined) clean.footerText = str(clean.footerText, 80);
    if (clean.handoffMessage !== undefined) clean.handoffMessage = str(clean.handoffMessage, 300);
    res.json(await WhatsAppAIService.updateAgent(orgOf(req), clean));
});
export const aiSaveSection = handle(async (req, res) => {
    try { await WhatsAppAIService.saveSection(orgOf(req), req.params.category, String(req.body?.content ?? '')); }
    catch (e: any) { throw new HttpError(400, e.message); }
    res.json({ success: true });
});
export const aiUploadDocument = handle(async (req, res) => {
    const file = (req as any).file;
    if (!file) throw new HttpError(400, 'No file uploaded');
    try { res.status(201).json(await WhatsAppAIService.addDocument(orgOf(req), userOf(req).id, file)); }
    catch (e: any) { throw new HttpError(400, e.message); }
});
export const aiDeleteDocument = handle(async (req, res) => {
    try { await WhatsAppAIService.deleteDocument(orgOf(req), req.params.id); }
    catch (e: any) { throw new HttpError(404, e.message); }
    res.json({ success: true });
});
export const aiTest = handle(async (req, res) => {
    const q = str(req.body?.question, 500);
    if (!q) throw new HttpError(400, 'Type a question to test');
    res.json(await WhatsAppAIService.test(orgOf(req), q));
});

// ===================== settings / health / consent =====================
export const settingsOverview = handle(async (req, res) => {
    const orgId = orgOf(req);
    const [accounts, optOuts, assignmentRules] = await Promise.all([
        prisma.whatsAppAccount.findMany({ where: { organisationId: orgId, isDeleted: false }, orderBy: { createdAt: 'asc' }, include: { assignmentRules: { where: { isDeleted: false } }, _count: { select: { campaigns: true, messages: true } } } }),
        prisma.whatsAppOptOut.count({ where: { organisationId: orgId } }),
        prisma.whatsAppAssignmentRule.count({ where: { organisationId: orgId, isDeleted: false } })
    ]);
    const serverUrl = process.env.SERVER_URL || '';
    res.json({
        accounts: accounts.map(({ accessToken, ...a }) => ({ ...a, hasToken: !!accessToken })),
        optOutCount: optOuts,
        assignmentRules,
        webhook: {
            callbackUrl: `${serverUrl}/api/whatsapp/webhook`,
            verifyTokenConfigured: !!process.env.WHATSAPP_VERIFY_TOKEN,
            appSecretConfigured: !!(process.env.WHATSAPP_APP_SECRET || process.env.WHATSAPP_WEBHOOK_SECRET),
            subscribedFields: ['messages', 'message_template_status_update', 'phone_number_quality_update']
        }
    });
});
export const refreshAccountHealth = handle(async (req, res) => {
    const orgId = orgOf(req);
    const acct = await prisma.whatsAppAccount.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!acct) throw new HttpError(404, 'Number not found');
    const updated = await WhatsAppHealthService.checkAccount(acct.id);
    if (updated) { const { accessToken, ...safe } = updated as any; return res.json(safe); }
    res.json({ message: 'Health check is only available for Meta numbers.' });
});
export const refreshAllHealth = handle(async (req, res) => {
    const rows = await WhatsAppHealthService.checkOrg(orgOf(req));
    res.json({ checked: rows.length });
});

export const listOptOuts = handle(async (req, res) => { res.json(await WhatsAppComplianceService.list(orgOf(req))); });
export const addOptOut = handle(async (req, res) => {
    const phone = digitsOnly(req.body?.phone);
    if (phone.length < 8) throw new HttpError(400, 'Enter a valid number');
    await WhatsAppComplianceService.optOut(orgOf(req), phone, 'manual');
    res.status(201).json({ success: true });
});
export const removeOptOut = handle(async (req, res) => {
    await WhatsAppComplianceService.optIn(orgOf(req), req.params.phone);
    res.json({ success: true });
});

// ===================== insights =====================
export const insights = handle(async (req, res) => {
    const orgId = orgOf(req);
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);

    const [byDay, bySource, open, unassigned, resolved, ai] = await Promise.all([
        prisma.$queryRaw<Array<{ day: Date; direction: string; count: bigint }>>`
            SELECT date_trunc('day', "createdAt") AS day, direction, COUNT(*)::bigint AS count
            FROM "WhatsAppMessage"
            WHERE "organisationId" = ${orgId} AND "isDeleted" = false AND "createdAt" >= ${since}
            GROUP BY 1, 2 ORDER BY 1`,
        prisma.whatsAppMessage.groupBy({ by: ['source'], where: { organisationId: orgId, direction: 'outgoing', createdAt: { gte: since } }, _count: true }),
        prisma.whatsAppConversation.count({ where: { organisationId: orgId, isDeleted: false, status: { not: 'resolved' } } }),
        prisma.whatsAppConversation.count({ where: { organisationId: orgId, isDeleted: false, assigneeId: null, status: { not: 'resolved' } } }),
        prisma.whatsAppConversation.count({ where: { organisationId: orgId, isDeleted: false, status: 'resolved' } }),
        prisma.whatsAppAIUsage.findUnique({ where: { organisationId_month: { organisationId: orgId, month: new Date().toISOString().slice(0, 7) } } })
    ]);

    const statusCounts = await prisma.whatsAppMessage.groupBy({ by: ['status'], where: { organisationId: orgId, direction: 'outgoing', createdAt: { gte: since } }, _count: true });
    const sc = (s: string) => statusCounts.find(x => x.status === s)?._count || 0;
    const delivered = sc('delivered') + sc('read');

    res.json({
        days,
        daily: byDay.map(r => ({ day: r.day, direction: r.direction, count: Number(r.count) })),
        outgoingBySource: bySource.map(s => ({ source: s.source || 'agent', count: s._count })),
        delivery: { sent: sc('sent') + delivered, delivered, read: sc('read'), failed: sc('failed') },
        conversations: { open, unassigned, resolved },
        aiMessagesThisMonth: ai?.count || 0
    });
});
