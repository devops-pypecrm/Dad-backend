import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { instagramConfig, isInstagramConfigured } from '../config/instagram';
import { getVisibleUserIds } from '../utils/hierarchyUtils';
import { hasOrgWideVisibility } from '../utils/roleUtils';
import { HttpError, handle, orgOf, str } from '../utils/whatsappHttp';
import { InstagramAuthService } from '../services/instagramAuthService';
import { InstagramInboxService, igWindowState } from '../services/instagramInboxService';
import { InstagramSender } from '../services/instagramSender';
import { InstagramWebhookService } from '../services/instagramWebhookService';
import { IG_CHATBOT_TEMPLATES, getIgChatbotTemplate } from '../services/instagramChatbotLibrary';
import { ig } from '../services/instagramApi';
import { isInstagramEnabled } from '../services/whatsAppFeature';
import { WhatsAppService } from '../services/whatsAppService';

const userOf = (req: Request) => (req as any).user as { id: string; role: any; organisationId: string };
const visibility = async (req: Request): Promise<string[] | null> => (hasOrgWideVisibility(userOf(req)) ? null : await getVisibleUserIds(userOf(req).id));

// ===================== webhook (public) =====================
export const verifyWebhook = (req: Request, res: Response) => {
    const { verifyToken } = instagramConfig();
    if (!verifyToken) return res.sendStatus(500);
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) return res.status(200).send(req.query['hub.challenge']);
    res.sendStatus(403);
};

export const receiveWebhook = async (req: Request, res: Response) => {
    const { appSecret } = instagramConfig();
    const rawBody: Buffer | undefined = (req as any).rawBody;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!appSecret) {
        if (process.env.NODE_ENV === 'production') return res.sendStatus(401);
    } else if (!signature || !rawBody || !WhatsAppService.verifySignature(rawBody.toString('utf8'), signature, appSecret)) {
        return res.sendStatus(401);
    }
    res.sendStatus(200); // acknowledge fast; Meta retries slow responders
    InstagramWebhookService.handle(req.body).catch(err => console.error('[InstagramWebhook] failed:', err));
};

// ===================== connect =====================
export const getConnectUrl = handle(async (req, res) => {
    const orgId = orgOf(req);
    const returnPath = typeof req.query.returnPath === 'string' && req.query.returnPath.startsWith('/') ? req.query.returnPath : '/instagram/inbox';
    try {
        res.json({ url: InstagramAuthService.buildAuthUrl({ organisationId: orgId, userId: userOf(req).id, returnPath }) });
    } catch (e: any) {
        throw new HttpError(503, e.message, 'INSTAGRAM_NOT_CONFIGURED');
    }
});

/** OAuth redirect target (no login cookie; the signed `state` identifies the user). */
export const oauthCallback = async (req: Request, res: Response) => {
    const { clientUrl } = instagramConfig();
    let returnPath = '/instagram/inbox';
    const fail = (message: string) => res.redirect(`${clientUrl}${returnPath}?instagram=error&message=${encodeURIComponent(message)}`);
    try {
        if (!req.query.state) return res.redirect(`${clientUrl}${returnPath}?instagram=error`);
        const state = InstagramAuthService.verifyState(String(req.query.state));
        returnPath = state.returnPath;
        if (req.query.error) return fail(String(req.query.error_description || 'Instagram connection was cancelled'));
        if (!(await isInstagramEnabled(state.organisationId))) return fail('Instagram is not enabled for your organisation.');
        await InstagramAuthService.connect(state.organisationId, state.userId, String(req.query.code || '').replace(/#_$/, ''));
        res.redirect(`${clientUrl}${returnPath}?instagram=connected`);
    } catch (err: any) {
        console.error('[Instagram OAuth] callback failed:', err.message);
        fail(err.message || 'Could not connect Instagram');
    }
};

export const getConnection = handle(async (req, res) => {
    const account = await InstagramAuthService.getAccount(orgOf(req));
    if (!account) return res.json({ connected: false, configured: isInstagramConfigured() });
    const { accessToken, ...safe } = account;
    void accessToken;
    res.json({ connected: true, configured: true, healthy: account.status === 'active', account: safe });
});

export const disconnect = handle(async (req, res) => {
    await InstagramAuthService.disconnect(orgOf(req));
    res.json({ success: true });
});

// ===================== inbox =====================
const loadConversation = async (req: Request) => {
    const orgId = orgOf(req);
    const convo = await prisma.instagramConversation.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!convo) throw new HttpError(404, 'Conversation not found');
    const visible = await visibility(req);
    if (visible && convo.assigneeId && !visible.includes(convo.assigneeId)) throw new HttpError(403, 'You do not have access to this conversation');
    return { orgId, convo };
};

export const listConversations = handle(async (req, res) => {
    const q = req.query as Record<string, string>;
    res.json(await InstagramInboxService.list({ organisationId: orgOf(req), userId: userOf(req).id, visibleUserIds: await visibility(req), view: q.view, status: q.status, search: q.search, cursor: q.cursor }));
});
export const conversationCounts = handle(async (req, res) => { res.json(await InstagramInboxService.counts(orgOf(req), userOf(req).id, await visibility(req))); });

export const getConversation = handle(async (req, res) => {
    const { convo } = await loadConversation(req);
    const assignee = convo.assigneeId ? await prisma.user.findUnique({ where: { id: convo.assigneeId }, select: { id: true, firstName: true, lastName: true } }) : null;
    res.json({ ...convo, assignee, window: igWindowState(convo.lastInboundAt) });
});

export const getMessages = handle(async (req, res) => {
    const { convo } = await loadConversation(req);
    const rows = await prisma.instagramMessage.findMany({
        where: { conversationId: convo.id, ...(req.query.before ? { createdAt: { lt: new Date(String(req.query.before)) } } : {}) },
        orderBy: { createdAt: 'desc' }, take: 80
    });
    res.json({ messages: rows.reverse(), window: igWindowState(convo.lastInboundAt) });
});

export const sendMessage = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const text = str(req.body?.text, 1000);
    if (!text) throw new HttpError(400, 'Type a message to send');
    const result = await InstagramSender.send({ organisationId: orgId, to: convo.igsid, text, source: 'agent', agentId: userOf(req).id, username: convo.username });
    if (!convo.assigneeId) await InstagramInboxService.update(orgId, convo.id, { assigneeId: userOf(req).id });
    res.json(result);
});

export const markRead = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    await InstagramInboxService.update(orgId, convo.id, { unreadCount: 0 });
    res.json({ success: true });
});

export const updateConversation = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const { assigneeId, status, labels } = req.body || {};
    const data: any = {};
    if (assigneeId !== undefined) {
        if (assigneeId !== null && !(await prisma.user.findFirst({ where: { id: assigneeId, organisationId: orgId, isDeleted: false } }))) throw new HttpError(400, 'That user is not in your organisation');
        data.assigneeId = assigneeId;
        if (assigneeId) data.botPausedUntil = new Date(Date.now() + 60 * 60_000);
    }
    if (status !== undefined) {
        if (!['open', 'pending', 'resolved'].includes(status)) throw new HttpError(400, 'Invalid status');
        data.status = status;
        if (status === 'resolved') data.botPausedUntil = null;
    }
    if (labels !== undefined) {
        if (!Array.isArray(labels)) throw new HttpError(400, 'labels must be an array');
        data.labels = Array.from(new Set(labels.map((l: any) => str(l, 40)).filter(Boolean))).slice(0, 15);
    }
    res.json(await InstagramInboxService.update(orgId, convo.id, data));
});

export const listNotes = handle(async (req, res) => {
    const { convo } = await loadConversation(req);
    const notes = await prisma.instagramConversationNote.findMany({ where: { conversationId: convo.id }, orderBy: { createdAt: 'asc' } });
    const users = await prisma.user.findMany({ where: { id: { in: Array.from(new Set(notes.map(n => n.authorId))) } }, select: { id: true, firstName: true, lastName: true } });
    const names = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName || ''}`.trim()]));
    res.json(notes.map(n => ({ ...n, authorName: names.get(n.authorId) || 'Unknown' })));
});
export const addNote = handle(async (req, res) => {
    const { orgId, convo } = await loadConversation(req);
    const body = str(req.body?.body, 2000);
    if (!body) throw new HttpError(400, 'Note cannot be empty');
    res.status(201).json(await prisma.instagramConversationNote.create({ data: { conversationId: convo.id, organisationId: orgId, authorId: userOf(req).id, body } }));
});
export const assignableUsers = handle(async (req, res) => {
    const visible = await visibility(req);
    res.json(await prisma.user.findMany({
        where: { organisationId: orgOf(req), isDeleted: false, isActive: true, ...(visible ? { id: { in: visible } } : {}) },
        select: { id: true, firstName: true, lastName: true }, orderBy: { firstName: 'asc' }
    }));
});

// ===================== keyword chatbots =====================
const cleanMessages = (v: any) => {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 5).map((m: any) => ({
        text: str(m?.text, 1000),
        buttons: (Array.isArray(m?.buttons) ? m.buttons : []).slice(0, 3)
            .map((b: any) => ({ title: str(b?.title, 20), url: str(b?.url, 500) }))
            .filter((b: { title: string; url: string }) => b.title && /^https?:\/\//i.test(b.url))
    })).filter((m: { text: string }) => m.text);
};
const cleanKeywords = (v: any) => Array.from(new Set((Array.isArray(v) ? v : []).map((k: any) => str(k, 60).toLowerCase()).filter((k: string) => k.length >= 2))).slice(0, 30) as string[];

const botData = (b: any) => ({
    name: str(b.name, 120) || 'Untitled workflow',
    keywords: cleanKeywords(b.keywords),
    matchType: b.matchType === 'exact' ? 'exact' : 'contains',
    chatWindowMinutes: Math.min(Math.max(parseInt(b.chatWindowMinutes) || 60, 1), 60 * 24 * 7),
    messages: cleanMessages(b.messages),
    nodes: b.nodes && JSON.stringify(b.nodes).length < 50_000 ? b.nodes : undefined
});

const assertPublishable = (d: { keywords: string[]; messages: unknown[] }) => {
    if (!d.keywords.length) throw new HttpError(400, 'Add at least one keyword before switching the chatbot on.');
    if (!d.messages.length) throw new HttpError(400, 'Add at least one message before switching the chatbot on.');
};

export const chatbotOverview = handle(async (req, res) => {
    const orgId = orgOf(req);
    const bots = await prisma.instagramChatbot.findMany({ where: { organisationId: orgId, isDeleted: false }, orderBy: { createdAt: 'desc' } });
    const [messagesSent, sessions] = await Promise.all([
        prisma.instagramMessage.count({ where: { organisationId: orgId, source: { in: ['chatbot', 'comment_bot'] } } }),
        prisma.instagramChatbotSession.groupBy({ by: ['botId'], where: { botId: { in: bots.map(b => b.id) } }, _count: true })
    ]);
    const used = new Set(bots.filter(b => b.sourceTemplateKey).map(b => b.sourceTemplateKey));
    const counts = new Map(sessions.map(s => [s.botId, s._count]));
    res.json({
        stats: { messagesSent, active: bots.filter(b => b.isActive).length, inactive: bots.filter(b => !b.isActive).length, custom: bots.filter(b => !b.sourceTemplateKey).length, templates: IG_CHATBOT_TEMPLATES.length },
        chatbots: bots.map(b => ({ ...b, triggered: counts.get(b.id) || 0 })),
        templates: IG_CHATBOT_TEMPLATES.map(t => ({ key: t.key, name: t.name, description: t.description, keywords: t.keywords, used: used.has(t.key) }))
    });
});
export const getChatbot = handle(async (req, res) => {
    const bot = await prisma.instagramChatbot.findFirst({ where: { id: req.params.id, organisationId: orgOf(req), isDeleted: false } });
    if (!bot) throw new HttpError(404, 'Chatbot not found');
    res.json(bot);
});
export const createChatbot = handle(async (req, res) => {
    const orgId = orgOf(req);
    const d = botData(req.body || {});
    const account = await InstagramAuthService.getAccount(orgId);
    res.status(201).json(await prisma.instagramChatbot.create({ data: { ...d, nodes: d.nodes ?? undefined, organisationId: orgId, accountId: account?.id || null, createdById: userOf(req).id, isActive: false } }));
});
export const updateChatbot = handle(async (req, res) => {
    const orgId = orgOf(req);
    const existing = await prisma.instagramChatbot.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!existing) throw new HttpError(404, 'Chatbot not found');
    const d = botData({ ...existing, ...req.body });
    const isActive = req.body?.isActive !== undefined ? !!req.body.isActive : existing.isActive;
    if (isActive) assertPublishable(d);
    res.json(await prisma.instagramChatbot.update({ where: { id: existing.id }, data: { ...d, nodes: d.nodes ?? undefined, isActive } }));
});
export const deleteChatbot = handle(async (req, res) => {
    const r = await prisma.instagramChatbot.updateMany({ where: { id: req.params.id, organisationId: orgOf(req) }, data: { isDeleted: true, isActive: false } });
    if (!r.count) throw new HttpError(404, 'Chatbot not found');
    res.json({ success: true });
});
export const useChatbotTemplate = handle(async (req, res) => {
    const orgId = orgOf(req);
    const t = getIgChatbotTemplate(req.params.key);
    if (!t) throw new HttpError(404, 'Template not found');
    const existing = await prisma.instagramChatbot.findFirst({ where: { organisationId: orgId, sourceTemplateKey: t.key, isDeleted: false } });
    if (existing) return res.json(existing);
    const account = await InstagramAuthService.getAccount(orgId);
    res.status(201).json(await prisma.instagramChatbot.create({
        data: { organisationId: orgId, accountId: account?.id || null, name: t.name, keywords: t.keywords, matchType: t.matchType, chatWindowMinutes: t.chatWindowMinutes, messages: t.messages, sourceTemplateKey: t.key, createdById: userOf(req).id, isActive: false }
    }));
});

// ===================== ask to follow (comment-gate bots) =====================
const requireAccount = async (orgId: string) => {
    const account = await InstagramAuthService.getAccount(orgId);
    if (!account || account.status !== 'active') throw new HttpError(412, 'Connect your Instagram account first.', 'NOT_CONNECTED');
    return account;
};

export const gateOverview = handle(async (req, res) => {
    const orgId = orgOf(req);
    const account = await InstagramAuthService.getAccount(orgId);
    const bots = await prisma.instagramGateBot.findMany({ where: { organisationId: orgId, isDeleted: false }, orderBy: { createdAt: 'desc' } });
    const events = bots.length ? await prisma.instagramGateEvent.groupBy({ by: ['botId', 'state'], where: { botId: { in: bots.map(b => b.id) } }, _count: true }) : [];
    const ev = (id: string, state: string) => events.find(e => e.botId === id && e.state === state)?._count || 0;
    res.json({
        connected: !!account && account.status === 'active',
        account: account ? { username: account.username, name: account.name, profilePicUrl: account.profilePicUrl, followersCount: account.followersCount } : null,
        stats: { total: bots.length, active: bots.filter(b => b.isActive).length, inactive: bots.filter(b => !b.isActive).length },
        bots: bots.map(b => ({ ...b, comments: ev(b.id, 'asked') + ev(b.id, 'rewarded') + ev(b.id, 'failed'), rewarded: ev(b.id, 'rewarded') }))
    });
});

export const gateMedia = handle(async (req, res) => {
    const orgId = orgOf(req);
    const account = await requireAccount(orgId);
    const data = await ig.get<{ data: any[] }>('me/media', InstagramAuthService.token(account), { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count', limit: 30 });
    const bots = await prisma.instagramGateBot.findMany({ where: { organisationId: orgId, isDeleted: false }, select: { id: true, mediaId: true, isActive: true } });
    res.json((data.data || []).map(m => ({
        id: m.id, caption: m.caption || '', mediaType: m.media_type, thumbnailUrl: m.thumbnail_url || m.media_url, permalink: m.permalink,
        timestamp: m.timestamp, commentsCount: m.comments_count, likeCount: m.like_count,
        bots: bots.filter(b => b.mediaId === m.id).length, activeBots: bots.filter(b => b.mediaId === m.id && b.isActive).length
    })));
});

const gateData = (b: any) => ({
    name: str(b.name, 120),
    keywords: cleanKeywords(b.keywords),
    publicReplies: (Array.isArray(b.publicReplies) ? b.publicReplies : []).map((r: any) => str(r, 300)).filter(Boolean).slice(0, 5) as string[],
    askMessage: str(b.askMessage, 900) || undefined,
    followButton: str(b.followButton, 20) || undefined,
    notFollowingMessage: str(b.notFollowingMessage, 900) || undefined,
    rewardMessage: str(b.rewardMessage, 900) || undefined,
    rewardLink: str(b.rewardLink, 500) || null
});

export const getGateBot = handle(async (req, res) => {
    const bot = await prisma.instagramGateBot.findFirst({ where: { id: req.params.id, organisationId: orgOf(req), isDeleted: false } });
    if (!bot) throw new HttpError(404, 'Bot not found');
    res.json(bot);
});
export const createGateBot = handle(async (req, res) => {
    const orgId = orgOf(req);
    const account = await requireAccount(orgId);
    const b = req.body || {};
    const d = gateData(b);
    if (!d.name) throw new HttpError(400, 'Give the bot a name');
    if (!b.mediaId) throw new HttpError(400, 'Choose the post this bot should watch');
    if (d.rewardLink && !/^https?:\/\//i.test(d.rewardLink)) throw new HttpError(400, 'The reward link must start with http:// or https://');

    // confirm the post really belongs to this account (and capture its preview)
    let media: any;
    try { media = await ig.get(String(b.mediaId), InstagramAuthService.token(account), { fields: 'id,caption,permalink,thumbnail_url,media_url' }); }
    catch { throw new HttpError(400, 'That post could not be found on your Instagram account.'); }

    res.status(201).json(await prisma.instagramGateBot.create({
        data: { ...d, organisationId: orgId, accountId: account.id, isActive: b.isActive !== false, mediaId: String(media.id), mediaPermalink: media.permalink, mediaThumbUrl: media.thumbnail_url || media.media_url, mediaCaption: (media.caption || '').slice(0, 300), createdById: userOf(req).id }
    }));
});
export const updateGateBot = handle(async (req, res) => {
    const orgId = orgOf(req);
    const existing = await prisma.instagramGateBot.findFirst({ where: { id: req.params.id, organisationId: orgId, isDeleted: false } });
    if (!existing) throw new HttpError(404, 'Bot not found');
    const b = req.body || {};
    const d = gateData({ ...existing, ...b });
    if (d.rewardLink && !/^https?:\/\//i.test(d.rewardLink)) throw new HttpError(400, 'The reward link must start with http:// or https://');
    res.json(await prisma.instagramGateBot.update({ where: { id: existing.id }, data: { ...d, ...(b.isActive !== undefined ? { isActive: !!b.isActive } : {}) } }));
});
export const deleteGateBot = handle(async (req, res) => {
    const r = await prisma.instagramGateBot.updateMany({ where: { id: req.params.id, organisationId: orgOf(req) }, data: { isDeleted: true, isActive: false } });
    if (!r.count) throw new HttpError(404, 'Bot not found');
    res.json({ success: true });
});
export const gateEvents = handle(async (req, res) => {
    const bot = await prisma.instagramGateBot.findFirst({ where: { id: req.params.id, organisationId: orgOf(req) } });
    if (!bot) throw new HttpError(404, 'Bot not found');
    res.json(await prisma.instagramGateEvent.findMany({ where: { botId: bot.id }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
