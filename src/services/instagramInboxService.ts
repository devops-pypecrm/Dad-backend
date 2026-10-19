import prisma from '../config/prisma';
import { IG_WINDOW_MS } from '../config/instagram';
import { emitToOrg } from '../socket';

export const igWindowState = (lastInboundAt: Date | null | undefined) => {
    if (!lastInboundAt) return { open: false, expiresAt: null as Date | null, msLeft: 0 };
    const expiresAt = new Date(lastInboundAt.getTime() + IG_WINDOW_MS);
    const msLeft = Math.max(0, expiresAt.getTime() - Date.now());
    return { open: msLeft > 0, expiresAt, msLeft };
};

export const igPreview = (messageType: string, content: any): string => {
    if (messageType === 'text') return (content?.text || '').slice(0, 140);
    const labels: Record<string, string> = { image: 'Photo', video: 'Video', audio: 'Voice message', share: 'Shared a post', story_reply: 'Replied to your story', story_mention: 'Mentioned you in a story', reaction: 'Reacted to a message', unsupported: 'Unsupported message' };
    return `${labels[messageType] || messageType}${content?.text ? `: ${content.text}` : ''}`.slice(0, 140);
};

export interface IgTouch {
    organisationId: string;
    accountId: string;
    igsid: string;
    direction: 'incoming' | 'outgoing';
    preview?: string;
    username?: string | null;
    displayName?: string | null;
    profilePicUrl?: string | null;
    at?: Date;
}

export const InstagramInboxService = {
    async touch(p: IgTouch) {
        const at = p.at || new Date();
        const inbound = p.direction === 'incoming';
        const where = { accountId_igsid: { accountId: p.accountId, igsid: p.igsid } };
        const existing = await prisma.instagramConversation.findUnique({ where });

        if (existing) {
            return prisma.instagramConversation.update({
                where,
                data: {
                    lastMessageAt: at, lastMessagePreview: p.preview ?? existing.lastMessagePreview, lastMessageDirection: p.direction,
                    ...(inbound ? { lastInboundAt: at, unreadCount: { increment: 1 }, status: existing.status === 'resolved' ? 'open' : existing.status } : {}),
                    ...(p.username && !existing.username ? { username: p.username } : {}),
                    ...(p.displayName && !existing.displayName ? { displayName: p.displayName } : {}),
                    ...(p.profilePicUrl ? { profilePicUrl: p.profilePicUrl } : {}),
                    isDeleted: false
                }
            });
        }
        try {
            return await prisma.instagramConversation.create({
                data: {
                    organisationId: p.organisationId, accountId: p.accountId, igsid: p.igsid, username: p.username || null,
                    displayName: p.displayName || null, profilePicUrl: p.profilePicUrl || null, lastMessageAt: at,
                    lastMessagePreview: p.preview, lastMessageDirection: p.direction, lastInboundAt: inbound ? at : null, unreadCount: inbound ? 1 : 0
                }
            });
        } catch (err: any) {
            if (err?.code === 'P2002') return prisma.instagramConversation.update({ where, data: { lastMessageAt: at, lastMessagePreview: p.preview, lastMessageDirection: p.direction, ...(inbound ? { lastInboundAt: at, unreadCount: { increment: 1 } } : {}) } });
            throw err;
        }
    },

    async list(p: { organisationId: string; userId: string; visibleUserIds: string[] | null; view?: string; status?: string; search?: string; cursor?: string; limit?: number }) {
        const where: any = { organisationId: p.organisationId, isDeleted: false };
        if (p.visibleUserIds) where.OR = [{ assigneeId: { in: p.visibleUserIds } }, { assigneeId: null }];
        if (p.view === 'mine') where.assigneeId = p.userId;
        if (p.view === 'unassigned') where.assigneeId = null;
        if (p.view === 'unread') where.unreadCount = { gt: 0 };
        if (p.status && p.status !== 'all') where.status = p.status;
        if (p.search) {
            const q = p.search.trim();
            where.AND = [{ OR: [{ username: { contains: q, mode: 'insensitive' } }, { displayName: { contains: q, mode: 'insensitive' } }, { lastMessagePreview: { contains: q, mode: 'insensitive' } }] }];
        }
        const limit = Math.min(p.limit || 50, 100);
        const rows = await prisma.instagramConversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: limit + 1, ...(p.cursor ? { cursor: { id: p.cursor }, skip: 1 } : {}) });
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const ids = Array.from(new Set(page.map(r => r.assigneeId).filter(Boolean))) as string[];
        const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
        const names = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName || ''}`.trim()]));
        return {
            conversations: page.map(c => ({ ...c, assigneeName: c.assigneeId ? names.get(c.assigneeId) || null : null, window: igWindowState(c.lastInboundAt) })),
            nextCursor: hasMore ? page[page.length - 1].id : null
        };
    },

    async counts(organisationId: string, userId: string, visibleUserIds: string[] | null) {
        const base: any = { organisationId, isDeleted: false };
        if (visibleUserIds) base.OR = [{ assigneeId: { in: visibleUserIds } }, { assigneeId: null }];
        const [all, mine, unassigned, unread] = await Promise.all([
            prisma.instagramConversation.count({ where: { ...base, status: { not: 'resolved' } } }),
            prisma.instagramConversation.count({ where: { ...base, assigneeId: userId, status: { not: 'resolved' } } }),
            prisma.instagramConversation.count({ where: { ...base, assigneeId: null, status: { not: 'resolved' } } }),
            prisma.instagramConversation.count({ where: { ...base, unreadCount: { gt: 0 } } })
        ]);
        return { all, mine, unassigned, unread };
    },

    async update(organisationId: string, id: string, data: { assigneeId?: string | null; status?: string; labels?: string[]; botPausedUntil?: Date | null; unreadCount?: number }) {
        const c = await prisma.instagramConversation.update({ where: { id }, data });
        emitToOrg(organisationId, 'instagram_conversation_updated', { id });
        return c;
    },

    async pauseBots(conversationId: string, minutes = 60) {
        await prisma.instagramConversation.update({ where: { id: conversationId }, data: { botPausedUntil: new Date(Date.now() + minutes * 60_000) } }).catch(() => undefined);
    }
};
