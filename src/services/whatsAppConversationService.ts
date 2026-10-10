import prisma from '../config/prisma';
import { WINDOW_MS } from '../config/whatsapp';
import { digitsOnly, phoneVariants } from '../utils/whatsappPhone';
import { emitToOrg } from '../socket';

export interface TouchParams {
    organisationId: string;
    whatsappAccountId?: string | null;
    phoneNumber: string;
    direction: 'incoming' | 'outgoing';
    preview?: string;
    displayName?: string | null;
    leadId?: string | null;
    contactId?: string | null;
    at?: Date;
}

export const windowState = (lastInboundAt: Date | null | undefined) => {
    if (!lastInboundAt) return { open: false, expiresAt: null as Date | null, msLeft: 0 };
    const expiresAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
    const msLeft = Math.max(0, expiresAt.getTime() - Date.now());
    return { open: msLeft > 0, expiresAt, msLeft };
};

export const previewFor = (messageType: string, content: any): string => {
    if (messageType === 'text') return (content?.text || '').slice(0, 140);
    if (messageType === 'template') return (content?.text || `Template: ${content?.templateName || ''}`).slice(0, 140);
    if (messageType === 'interactive') return (content?.text || 'Interactive message').slice(0, 140);
    const labels: Record<string, string> = { image: 'Photo', document: 'Document', audio: 'Audio', video: 'Video', location: 'Location' };
    return `${labels[messageType] || messageType}${content?.caption ? `: ${content.caption}` : ''}`.slice(0, 140);
};

export const WhatsAppConversationService = {
    /**
     * Create/update the conversation row for a message. Called for every inbound and
     * outbound message so the inbox, the 24h window and unread counts stay accurate.
     */
    async touch(p: TouchParams) {
        const phone = digitsOnly(p.phoneNumber);
        const accountKey = p.whatsappAccountId || 'default';
        const at = p.at || new Date();
        const inbound = p.direction === 'incoming';
        const where = { organisationId_accountKey_phoneNumber: { organisationId: p.organisationId, accountKey, phoneNumber: phone } };

        const existing = await prisma.whatsAppConversation.findUnique({ where });

        if (existing) {
            return prisma.whatsAppConversation.update({
                where,
                data: {
                    lastMessageAt: at,
                    lastMessagePreview: p.preview ?? existing.lastMessagePreview,
                    lastMessageDirection: p.direction,
                    ...(inbound ? { lastInboundAt: at, unreadCount: { increment: 1 }, status: existing.status === 'resolved' ? 'open' : existing.status } : {}),
                    ...(p.displayName && !existing.displayName ? { displayName: p.displayName } : {}),
                    ...(p.leadId && !existing.leadId ? { leadId: p.leadId } : {}),
                    ...(p.contactId && !existing.contactId ? { contactId: p.contactId } : {}),
                    isDeleted: false
                }
            });
        }

        // New conversation: default owner is the lead's owner, else the number's routing rule.
        let assigneeId: string | null = null;
        try {
            if (p.leadId) {
                const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { assignedToId: true } });
                assigneeId = lead?.assignedToId || null;
            }
            if (!assigneeId) {
                const { WhatsAppAssignmentService } = await import('./whatsAppAssignmentService');
                assigneeId = await WhatsAppAssignmentService.resolveAgent(p.whatsappAccountId, p.organisationId);
            }
        } catch (err) {
            console.error('[WhatsAppConversation] assignee resolution failed', err);
        }

        try {
            return await prisma.whatsAppConversation.create({
                data: {
                    organisationId: p.organisationId,
                    whatsappAccountId: p.whatsappAccountId || null,
                    accountKey,
                    phoneNumber: phone,
                    displayName: p.displayName || null,
                    leadId: p.leadId || null,
                    contactId: p.contactId || null,
                    assigneeId,
                    lastMessageAt: at,
                    lastMessagePreview: p.preview,
                    lastMessageDirection: p.direction,
                    lastInboundAt: inbound ? at : null,
                    unreadCount: inbound ? 1 : 0
                }
            });
        } catch (err: any) {
            if (err?.code === 'P2002') {
                // lost a race with a concurrent message from the same number
                return prisma.whatsAppConversation.update({ where, data: { lastMessageAt: at, lastMessagePreview: p.preview, lastMessageDirection: p.direction, ...(inbound ? { lastInboundAt: at, unreadCount: { increment: 1 } } : {}) } });
            }
            throw err;
        }
    },

    async list(params: {
        organisationId: string;
        visibleUserIds?: string[] | null; // null = org-wide
        userId: string;
        view?: string; // all | mine | unassigned | unread
        status?: string;
        label?: string;
        accountId?: string;
        search?: string;
        limit?: number;
        cursor?: string;
    }) {
        const where: any = { organisationId: params.organisationId, isDeleted: false };
        if (params.visibleUserIds) {
            where.OR = [{ assigneeId: { in: params.visibleUserIds } }, { assigneeId: null }];
        }
        if (params.view === 'mine') where.assigneeId = params.userId;
        if (params.view === 'unassigned') where.assigneeId = null;
        if (params.view === 'unread') where.unreadCount = { gt: 0 };
        if (params.status && params.status !== 'all') where.status = params.status;
        if (params.label) where.labels = { has: params.label };
        if (params.accountId) where.whatsappAccountId = params.accountId;
        if (params.search) {
            const q = params.search.trim();
            const and: any[] = [{ OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { phoneNumber: { contains: digitsOnly(q) || q } }, { lastMessagePreview: { contains: q, mode: 'insensitive' } }] }];
            where.AND = and;
        }

        const limit = Math.min(params.limit || 50, 100);
        const rows = await prisma.whatsAppConversation.findMany({
            where,
            orderBy: { lastMessageAt: 'desc' },
            take: limit + 1,
            ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {})
        });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);

        const assigneeIds = Array.from(new Set(page.map(r => r.assigneeId).filter(Boolean))) as string[];
        const users = assigneeIds.length
            ? await prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, firstName: true, lastName: true } })
            : [];
        const userMap = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName || ''}`.trim()]));

        return {
            conversations: page.map(c => ({
                ...c,
                assigneeName: c.assigneeId ? userMap.get(c.assigneeId) || null : null,
                window: windowState(c.lastInboundAt)
            })),
            nextCursor: hasMore ? page[page.length - 1].id : null
        };
    },

    async counts(organisationId: string, userId: string, visibleUserIds: string[] | null) {
        const base: any = { organisationId, isDeleted: false };
        if (visibleUserIds) base.OR = [{ assigneeId: { in: visibleUserIds } }, { assigneeId: null }];
        const [all, mine, unassigned, unread] = await Promise.all([
            prisma.whatsAppConversation.count({ where: { ...base, status: { not: 'resolved' } } }),
            prisma.whatsAppConversation.count({ where: { ...base, assigneeId: userId, status: { not: 'resolved' } } }),
            prisma.whatsAppConversation.count({ where: { ...base, assigneeId: null, status: { not: 'resolved' } } }),
            prisma.whatsAppConversation.count({ where: { ...base, unreadCount: { gt: 0 } } })
        ]);
        return { all, mine, unassigned, unread };
    },

    async getById(organisationId: string, id: string) {
        return prisma.whatsAppConversation.findFirst({ where: { id, organisationId, isDeleted: false } });
    },

    async messages(organisationId: string, conversation: { phoneNumber: string; whatsappAccountId: string | null }, opts: { limit?: number; before?: string } = {}) {
        const limit = Math.min(opts.limit || 60, 200);
        const rows = await prisma.whatsAppMessage.findMany({
            where: {
                organisationId,
                isDeleted: false,
                phoneNumber: { in: phoneVariants(conversation.phoneNumber) },
                ...(conversation.whatsappAccountId ? { OR: [{ whatsappAccountId: conversation.whatsappAccountId }, { whatsappAccountId: null }] } : {}),
                ...(opts.before ? { createdAt: { lt: new Date(opts.before) } } : {})
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: { agent: { select: { id: true, firstName: true, lastName: true } } }
        });
        return rows.reverse();
    },

    async markRead(organisationId: string, conversation: { id: string; phoneNumber: string }) {
        await prisma.whatsAppMessage.updateMany({
            where: { organisationId, phoneNumber: { in: phoneVariants(conversation.phoneNumber) }, direction: 'incoming', isReadByAgent: false },
            data: { isReadByAgent: true }
        });
        const updated = await prisma.whatsAppConversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
        emitToOrg(organisationId, 'whatsapp_conversation_updated', { id: updated.id });
        return updated;
    },

    async update(organisationId: string, id: string, data: { assigneeId?: string | null; status?: string; labels?: string[]; botPausedUntil?: Date | null }) {
        const convo = await prisma.whatsAppConversation.update({ where: { id }, data });
        emitToOrg(organisationId, 'whatsapp_conversation_updated', { id });
        return convo;
    },

    /** A human reply pauses bots/AI on this conversation for a while so they don't talk over the agent. */
    async pauseBots(conversationId: string, minutes = 60) {
        await prisma.whatsAppConversation.update({ where: { id: conversationId }, data: { botPausedUntil: new Date(Date.now() + minutes * 60_000) } }).catch(() => undefined);
    }
};
