import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { HttpError, handle, orgOf, str } from '../utils/whatsappHttp';
import { WhatsAppCampaignService } from '../services/whatsAppCampaignService';
import { WhatsAppTemplateService } from '../services/whatsAppTemplateService';
import { PARAM_SOURCES } from '../utils/whatsappAutomation';

const userOf = (req: Request) => (req as any).user as { id: string };

const cleanParams = (v: any) =>
    (Array.isArray(v) ? v : []).slice(0, 10).map((p: any) => ({
        source: (PARAM_SOURCES as readonly string[]).includes(p?.source) ? p.source : 'static',
        value: str(p?.value, 200)
    }));

const cleanFilter = (f: any) => {
    if (!f || typeof f !== 'object') return null;
    const arr = (x: any) => (Array.isArray(x) ? x.map((s: any) => str(s, 80)).filter(Boolean) : undefined);
    const out: any = {};
    for (const k of ['sources', 'statuses', 'tags', 'assignedToIds']) { const a = arr(f[k]); if (a?.length) out[k] = a; }
    if (f.branchId) out.branchId = str(f.branchId, 80);
    if (f.createdFrom) out.createdFrom = str(f.createdFrom, 40);
    if (f.createdTo) out.createdTo = str(f.createdTo, 40);
    return Object.keys(out).length ? out : null;
};

const cleanRecipients = (v: any) =>
    (Array.isArray(v) ? v : []).slice(0, 5000).filter((r: any) => r && ['phone', 'lead', 'contact'].includes(r.type)).map((r: any) => ({
        type: r.type, id: r.id ? str(r.id, 80) : undefined, phone: r.phone ? str(r.phone, 30) : undefined, name: r.name ? str(r.name, 120) : undefined
    }));

async function requireApprovedTemplate(orgId: string, name: string, language: string) {
    if (!name) throw new HttpError(400, 'Choose an approved template. WhatsApp only allows broadcasts that use approved templates.');
    let tpl = await WhatsAppTemplateService.findApproved(orgId, name, language);
    if (!tpl) {
        await WhatsAppTemplateService.syncFromMeta(orgId).catch(() => undefined);
        tpl = await WhatsAppTemplateService.findApproved(orgId, name, language);
    }
    if (!tpl) throw new HttpError(400, `Template "${name}" (${language}) is not approved.`);
    return tpl;
}

const campaignInclude = { createdBy: { select: { id: true, firstName: true, lastName: true, email: true } } };

export const getWhatsAppCampaigns = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });
        res.json(await prisma.whatsAppCampaign.findMany({ where: { organisationId: orgId, isDeleted: false }, orderBy: { createdAt: 'desc' }, include: campaignInclude }));
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getWhatsAppCampaign = handle(async (req, res) => {
    const detail = await WhatsAppCampaignService.detail(orgOf(req), req.params.id, { status: str(req.query.status as string, 20) || undefined, page: Number(req.query.page) || 1 });
    if (!detail) throw new HttpError(404, 'Campaign not found');
    res.json(detail);
});

export const previewAudience = handle(async (req, res) => {
    const b = req.body || {};
    res.json(await WhatsAppCampaignService.preview(orgOf(req), { recipients: cleanRecipients(b.recipients), audienceFilter: cleanFilter(b.audienceFilter), whatsappAccountId: b.whatsappAccountId || null }));
});

export const createWhatsAppCampaign = handle(async (req, res) => {
    const orgId = orgOf(req);
    const b = req.body || {};
    const templateLanguage = str(b.templateLanguage, 20) || 'en_US';
    const tpl = await requireApprovedTemplate(orgId, str(b.templateId, 512), templateLanguage);

    const recipients = cleanRecipients(b.recipients);
    const audienceFilter = cleanFilter(b.audienceFilter);
    const testNumber = str(b.testNumber, 30) || null;
    if (!recipients.length && !audienceFilter && !testNumber) throw new HttpError(400, 'Choose who should receive this campaign.');

    const scheduledAt = b.scheduledAt ? new Date(b.scheduledAt) : null;
    if (scheduledAt && (isNaN(scheduledAt.getTime()))) throw new HttpError(400, 'Invalid schedule time');
    const sendNow = b.status === 'sent';
    const isFuture = !!scheduledAt && scheduledAt.getTime() > Date.now() + 30_000;

    const body = (tpl.components as any[]).find(c => c.type === 'BODY')?.text || '';
    const campaign = await prisma.whatsAppCampaign.create({
        data: {
            name: str(b.name, 120) || 'Untitled campaign',
            message: body || `Template: ${tpl.name}`,
            templateId: tpl.name, templateLanguage, templateParams: cleanParams(b.templateParams),
            whatsappAccountId: b.whatsappAccountId || null, flowId: b.flowId || null,
            recipients, audienceFilter: audienceFilter as any, testNumber,
            scheduledAt: isFuture ? scheduledAt : null,
            status: isFuture && !sendNow ? 'scheduled' : 'draft',
            organisationId: orgId, createdById: userOf(req).id,
            stats: { sent: 0, delivered: 0, read: 0, failed: 0, replied: 0 }
        }
    });

    try {
        const { logAudit } = await import('../utils/auditLogger');
        logAudit({ action: 'CREATE_WHATSAPP_CAMPAIGN', entity: 'WhatsAppCampaign', entityId: campaign.id, actorId: userOf(req).id, organisationId: orgId, details: { name: campaign.name, template: tpl.name } } as any);
    } catch (e) { console.error('Audit Log Error:', e); }

    if (sendNow && !isFuture) WhatsAppCampaignService.process(campaign.id).catch(err => console.error('Campaign processing error:', err));
    res.status(201).json(campaign);
});

export const updateWhatsAppCampaign = handle(async (req, res) => {
    const orgId = orgOf(req);
    const existing = await prisma.whatsAppCampaign.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!existing) throw new HttpError(404, 'Campaign not found');
    if (!['draft', 'scheduled'].includes(existing.status)) throw new HttpError(400, 'Only draft or scheduled campaigns can be edited.');

    const b = req.body || {};
    const data: any = {};
    if (b.name !== undefined) data.name = str(b.name, 120) || existing.name;
    if (b.templateId !== undefined) {
        const lang = str(b.templateLanguage, 20) || existing.templateLanguage || 'en_US';
        const tpl = await requireApprovedTemplate(orgId, str(b.templateId, 512), lang);
        data.templateId = tpl.name; data.templateLanguage = lang;
        data.message = (tpl.components as any[]).find(c => c.type === 'BODY')?.text || `Template: ${tpl.name}`;
    }
    if (b.templateParams !== undefined) data.templateParams = cleanParams(b.templateParams);
    if (b.recipients !== undefined) data.recipients = cleanRecipients(b.recipients);
    if (b.audienceFilter !== undefined) data.audienceFilter = cleanFilter(b.audienceFilter);
    if (b.whatsappAccountId !== undefined) data.whatsappAccountId = b.whatsappAccountId || null;
    if (b.flowId !== undefined) data.flowId = b.flowId || null;
    if (b.scheduledAt !== undefined) {
        const at = b.scheduledAt ? new Date(b.scheduledAt) : null;
        data.scheduledAt = at;
        data.status = at && at.getTime() > Date.now() ? 'scheduled' : 'draft';
    }

    const campaign = await prisma.whatsAppCampaign.update({ where: { id: existing.id }, data });
    if (b.status === 'sent') WhatsAppCampaignService.process(campaign.id).catch(err => console.error('Campaign processing error:', err));
    res.json(campaign);
});

export const sendWhatsAppCampaignNow = handle(async (req, res) => {
    const orgId = orgOf(req);
    const c = await prisma.whatsAppCampaign.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!c) throw new HttpError(404, 'Campaign not found');
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(400, `This campaign is already ${c.status}.`);
    WhatsAppCampaignService.process(c.id).catch(err => console.error('Campaign processing error:', err));
    res.json({ started: true });
});

export const retryFailedRecipients = handle(async (req, res) => {
    const orgId = orgOf(req);
    const c = await prisma.whatsAppCampaign.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!c) throw new HttpError(404, 'Campaign not found');
    if (!['sent', 'failed'].includes(c.status)) throw new HttpError(400, 'Wait for the campaign to finish first.');
    WhatsAppCampaignService.process(c.id, { retryFailedOnly: true }).catch(err => console.error('Campaign retry error:', err));
    res.json({ started: true });
});

export const cancelWhatsAppCampaign = handle(async (req, res) => {
    const r = await prisma.whatsAppCampaign.updateMany({ where: { id: req.params.id, organisationId: orgOf(req), status: { in: ['draft', 'scheduled'] } }, data: { status: 'cancelled' } });
    if (!r.count) throw new HttpError(400, 'Only draft or scheduled campaigns can be cancelled.');
    res.json({ success: true });
});

export const deleteWhatsAppCampaign = handle(async (req, res) => {
    const orgId = orgOf(req);
    const existing = await prisma.whatsAppCampaign.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!existing) throw new HttpError(404, 'Campaign not found');
    if (existing.status === 'sending') throw new HttpError(400, 'This campaign is sending right now.');
    await prisma.whatsAppCampaign.update({ where: { id: existing.id }, data: { isDeleted: true } });
    res.json({ message: 'WhatsApp Campaign deleted' });
});
