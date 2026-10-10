import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getVisibleUserIds } from '../utils/hierarchyUtils';
import { hasOrgWideVisibility } from '../utils/roleUtils';
import { HttpError, handle, orgOf, str } from '../utils/whatsappHttp';
import { WhatsAppConversationService, windowState } from '../services/whatsAppConversationService';
import { WhatsAppSender } from '../services/whatsAppSender';
import { WhatsAppComplianceService } from '../services/whatsAppComplianceService';
import { digitsOnly, toWhatsAppNumber } from '../utils/whatsappPhone';
import { emitToOrg } from '../socket';

const userOf = (req: Request) => (req as any).user as { id: string; role: any; organisationId: string };

const visibility = async (req: Request): Promise<string[] | null> => {
    const user = userOf(req);
    return hasOrgWideVisibility(user) ? null : await getVisibleUserIds(user.id);
};

const loadConversation = async (req: Request) => {
    const orgId = orgOf(req);
    const convo = await WhatsAppConversationService.getById(orgId, req.params.id);
    if (!convo) throw new HttpError(404, 'Conversation not found');
    const visible = await visibility(req);
    if (visible && convo.assigneeId && !visible.includes(convo.assigneeId)) throw new HttpError(403, 'You do not have access to this conversation');
    return { orgId, convo };
};

export const listConversations = handle(async (req, res) => {
    const orgId = orgOf(req);
    const q = req.query as Record<string, string>;
    const result = await WhatsAppConversationService.list({
        organisationId: orgId, userId: userOf(req).id, visibleUserIds: await visibility(req),
        view: q.view, status: q.status, label: q.label, accountId: q.accountId, search: q.search, cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined
    });
    res.json(result);
});

export const conversationCounts = handle(async (req, res) => {
    res.json(await WhatsAppConversationService.counts(orgOf(req), userOf(req).id, await visibility(req)));
});

export const getConversation = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const [assignee, lead] = await Promise.all([
        convo.assigneeId ? prisma.user.findUnique({ where: { id: convo.assigneeId }, select: { id: true, firstName: true, lastName: true } }) : null,
        convo.leadId ? prisma.lead.findFirst({ where: { id: convo.leadId, organisationId: orgId }, select: { id: true, firstName: true, lastName: true, phone: true, email: true, status: true, source: true, nextFollowUp: true, assignedToId: true, tags: true } }) : null
    ]);
    const optedOut = await WhatsAppComplianceService.isOptedOut(orgId, convo.phoneNumber);
    res.json({ ...convo, assignee, lead, optedOut, window: windowState(convo.lastInboundAt) });
});

export const getConversationMessages = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const messages = await WhatsAppConversationService.messages(orgId, convo, { before: str(req.query.before as string, 40) || undefined, limit: req.query.limit ? Number(req.query.limit) : undefined });
    res.json({ messages, window: windowState(convo.lastInboundAt) });
});

export const sendConversationMessage = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const { text, template, media } = req.body || {};
    if (!text && !template && !media) throw new HttpError(400, 'Nothing to send');
    const result = await WhatsAppSender.send({
        organisationId: orgId, to: convo.phoneNumber, accountId: convo.whatsappAccountId, source: 'agent',
        agentId: userOf(req).id, leadId: convo.leadId, contactId: convo.contactId,
        ...(text ? { text: str(text, 4096) } : {}),
        ...(template ? { template: { name: str(template.name, 512), language: str(template.language, 20) || 'en_US', values: (template.values || []).map((v: any) => String(v)) } } : {}),
        ...(media ? { media: { type: media.type, mediaId: str(media.mediaId, 200), caption: str(media.caption, 1024) || undefined, filename: str(media.filename, 200) || undefined } } : {})
    });
    // replying implies ownership if nobody has the conversation yet
    if (!convo.assigneeId) await WhatsAppConversationService.update(orgId, convo.id, { assigneeId: userOf(req).id });
    res.json(result);
});

export const markConversationRead = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    await WhatsAppConversationService.markRead(orgId, convo);
    res.json({ success: true });
});

export const updateConversation = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const { assigneeId, status, labels } = req.body || {};
    const data: any = {};

    if (assigneeId !== undefined) {
        if (assigneeId !== null) {
            const user = await prisma.user.findFirst({ where: { id: assigneeId, organisationId: orgId, isDeleted: false } });
            if (!user) throw new HttpError(400, 'That user is not in your organisation');
        }
        data.assigneeId = assigneeId;
        if (assigneeId) data.botPausedUntil = new Date(Date.now() + 60 * 60_000);
    }
    if (status !== undefined) {
        if (!['open', 'pending', 'resolved'].includes(status)) throw new HttpError(400, 'Invalid status');
        data.status = status;
        // resolving hands the conversation back to bots/AI for the next inbound
        if (status === 'resolved') data.botPausedUntil = null;
    }
    if (labels !== undefined) {
        if (!Array.isArray(labels)) throw new HttpError(400, 'labels must be an array');
        data.labels = Array.from(new Set(labels.map((l: any) => str(l, 40)).filter(Boolean))).slice(0, 15);
    }
    const updated = await WhatsAppConversationService.update(orgId, convo.id, data);

    if (data.assigneeId && data.assigneeId !== userOf(req).id) {
        try {
            const { NotificationService } = await import('../services/notificationService');
            await NotificationService.send(data.assigneeId, 'WhatsApp conversation assigned to you', `${convo.displayName || '+' + convo.phoneNumber} was assigned to you.`, 'info');
        } catch { /* notification is best-effort */ }
    }
    res.json(updated);
});

export const listNotes = handle(async (req, res) => {
    const { convo } = await loadConversation(req);
    const notes = await prisma.whatsAppConversationNote.findMany({ where: { conversationId: convo.id }, orderBy: { createdAt: 'asc' } });
    const users = await prisma.user.findMany({ where: { id: { in: Array.from(new Set(notes.map(n => n.authorId))) } }, select: { id: true, firstName: true, lastName: true } });
    const names = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName || ''}`.trim()]));
    res.json(notes.map(n => ({ ...n, authorName: names.get(n.authorId) || 'Unknown' })));
});

export const addNote = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const body = str(req.body?.body, 2000);
    if (!body) throw new HttpError(400, 'Note cannot be empty');
    const note = await prisma.whatsAppConversationNote.create({ data: { conversationId: convo.id, organisationId: orgId, authorId: userOf(req).id, body } });
    res.status(201).json(note);
});

/** Start a conversation with any number (used by "New chat"). */
export const startConversation = handle(async (req, res) => {
    const orgId = orgOf(req);
    const { phone, text, template, accountId, leadId } = req.body || {};
    const to = toWhatsAppNumber(phone) || digitsOnly(phone);

    let lead = null;
    if (leadId) lead = await prisma.lead.findFirst({ where: { id: leadId, organisationId: orgId, isDeleted: false }, select: { id: true } });

    const result = await WhatsAppSender.send({
        organisationId: orgId, to, accountId, source: 'agent', agentId: userOf(req).id, leadId: lead?.id,
        ...(template ? { template: { name: str(template.name, 512), language: str(template.language, 20) || 'en_US', values: (template.values || []).map((v: any) => String(v)) } } : { text: str(text, 4096) })
    });
    const convo = await prisma.whatsAppConversation.findUnique({ where: { id: result.conversationId } });
    if (convo && !convo.assigneeId) await WhatsAppConversationService.update(orgId, convo.id, { assigneeId: userOf(req).id });
    res.status(201).json({ conversationId: result.conversationId });
});

/** Users the current user may assign conversations to. */
export const assignableUsers = handle(async (req, res) => {
    const orgId = orgOf(req);
    const visible = await visibility(req);
    const users = await prisma.user.findMany({
        where: { organisationId: orgId, isDeleted: false, isActive: true, ...(visible ? { id: { in: visible } } : {}) },
        select: { id: true, firstName: true, lastName: true, role: true }, orderBy: { firstName: 'asc' }
    });
    res.json(users);
});

// ---- quick replies -------------------------------------------------------
export const listQuickReplies = handle(async (req, res) => {
    res.json(await prisma.whatsAppQuickReply.findMany({ where: { organisationId: orgOf(req), isDeleted: false }, orderBy: { shortcut: 'asc' } }));
});
export const saveQuickReply = handle(async (req, res) => {
    const orgId = orgOf(req);
    const shortcut = str(req.body?.shortcut, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const body = str(req.body?.body, 1000);
    if (!shortcut || !body) throw new HttpError(400, 'Shortcut and message are required');
    if (req.params.id) {
        const existing = await prisma.whatsAppQuickReply.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
        if (!existing) throw new HttpError(404, 'Quick reply not found');
        return res.json(await prisma.whatsAppQuickReply.update({ where: { id: existing.id }, data: { shortcut, body } }));
    }
    res.status(201).json(await prisma.whatsAppQuickReply.create({ data: { organisationId: orgId, shortcut, body, createdById: userOf(req).id } }));
});
export const deleteQuickReply = handle(async (req, res) => {
    const r = await prisma.whatsAppQuickReply.updateMany({ where: { id: req.params.id, organisationId: orgOf(req) }, data: { isDeleted: true } });
    if (!r.count) throw new HttpError(404, 'Quick reply not found');
    res.json({ success: true });
});

// ---- labels --------------------------------------------------------------
export const listLabels = handle(async (req, res) => {
    res.json(await prisma.whatsAppLabel.findMany({ where: { organisationId: orgOf(req), isDeleted: false }, orderBy: { name: 'asc' } }));
});
export const createLabel = handle(async (req, res) => {
    const orgId = orgOf(req);
    const name = str(req.body?.name, 40);
    if (!name) throw new HttpError(400, 'Label name is required');
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body?.color || '') ? req.body.color : '#69a63a';
    const label = await prisma.whatsAppLabel.upsert({
        where: { organisationId_name: { organisationId: orgId, name } },
        create: { organisationId: orgId, name, color }, update: { color, isDeleted: false }
    });
    res.status(201).json(label);
});
export const deleteLabel = handle(async (req, res) => {
    const orgId = orgOf(req);
    const label = await prisma.whatsAppLabel.findFirst({ where: { id: req.params.id, organisationId: orgId } });
    if (!label) throw new HttpError(404, 'Label not found');
    await prisma.whatsAppLabel.update({ where: { id: label.id }, data: { isDeleted: true } });
    // strip the label from conversations that carried it
    const convos = await prisma.whatsAppConversation.findMany({ where: { organisationId: orgId, labels: { has: label.name } }, select: { id: true, labels: true } });
    for (const c of convos) await prisma.whatsAppConversation.update({ where: { id: c.id }, data: { labels: c.labels.filter(l => l !== label.name) } });
    emitToOrg(orgId, 'whatsapp_conversation_updated', {});
    res.json({ success: true });
});
