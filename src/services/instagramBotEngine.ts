import prisma from '../config/prisma';
import { ig } from './instagramApi';
import { InstagramAuthService } from './instagramAuthService';
import { InstagramSender, InstagramSendError } from './instagramSender';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const GATE_PREFIX = 'GATE:';
const MAX_GATE_ATTEMPTS = 5;

type Account = { id: string; organisationId: string; igUserId: string; accessToken: string };

const matches = (text: string, keywords: string[], matchType: string) => {
    const t = text.trim().toLowerCase();
    return keywords.some(k => {
        const kw = k.trim().toLowerCase();
        return kw.length > 0 && (matchType === 'exact' ? t === kw : t.includes(kw));
    });
};

export const InstagramBotEngine = {
    // ---------------------------- keyword chatbots (DMs) ----------------------------
    async handleDirectMessage(ctx: { account: Account; igsid: string; text: string; username?: string | null; botPausedUntil?: Date | null }) {
        if (!ctx.text.trim()) return false;
        if (ctx.botPausedUntil && ctx.botPausedUntil > new Date()) return false; // a human is handling this chat

        const bots = await prisma.instagramChatbot.findMany({
            where: { organisationId: ctx.account.organisationId, isActive: true, isDeleted: false, OR: [{ accountId: null }, { accountId: ctx.account.id }] },
            orderBy: { createdAt: 'asc' }
        });
        const bot = bots.find(b => matches(ctx.text, b.keywords, b.matchType));
        if (!bot) return false;

        // Chat window: the same person is not re-triggered while their window for this bot is open.
        const session = await prisma.instagramChatbotSession.findUnique({ where: { botId_igsid: { botId: bot.id, igsid: ctx.igsid } } });
        if (session && session.expiresAt > new Date()) return true; // keep quiet but treat as handled
        await prisma.instagramChatbotSession.upsert({
            where: { botId_igsid: { botId: bot.id, igsid: ctx.igsid } },
            create: { botId: bot.id, accountId: ctx.account.id, igsid: ctx.igsid, expiresAt: new Date(Date.now() + bot.chatWindowMinutes * 60_000) },
            update: { startedAt: new Date(), expiresAt: new Date(Date.now() + bot.chatWindowMinutes * 60_000) }
        });

        const messages = (bot.messages as unknown as { text: string; buttons?: { title: string; url: string }[] }[]) || [];
        for (const m of messages.slice(0, 5)) {
            try {
                await InstagramSender.send({ organisationId: ctx.account.organisationId, to: ctx.igsid, text: m.text, buttons: m.buttons, source: 'chatbot', botId: bot.id, username: ctx.username });
            } catch (err) {
                if (!(err instanceof InstagramSendError)) console.error('[InstagramBot] send failed', err);
                break;
            }
            await sleep(700);
        }
        return true;
    },

    // ---------------------------- Ask-to-Follow (comment-gate) ----------------------------
    async handleComment(ctx: { account: Account; commentId: string; text: string; fromId: string; fromUsername?: string; mediaId?: string; parentId?: string }) {
        if (!ctx.mediaId || ctx.parentId || ctx.fromId === ctx.account.igUserId) return; // only top-level comments from other people

        const bots = await prisma.instagramGateBot.findMany({
            where: { organisationId: ctx.account.organisationId, accountId: ctx.account.id, mediaId: ctx.mediaId, isActive: true, isDeleted: false }
        });
        for (const bot of bots) {
            if (bot.keywords.length && !matches(ctx.text, bot.keywords, 'contains')) continue;

            try {
                await prisma.instagramGateEvent.create({ data: { botId: bot.id, commentId: ctx.commentId, igsid: ctx.fromId, username: ctx.fromUsername } });
            } catch (err: any) {
                if (err?.code === 'P2002') continue; // webhook retry: already handled
                throw err;
            }

            const token = InstagramAuthService.token(ctx.account);
            if (bot.publicReplies.length) {
                const reply = bot.publicReplies[Math.floor(Math.random() * bot.publicReplies.length)];
                try { await ig.post(`${ctx.commentId}/replies`, token, { message: reply.slice(0, 300) }); } catch (err: any) { console.error('[InstagramBot] public reply failed:', err.message); }
            }

            try {
                await InstagramSender.send({
                    organisationId: ctx.account.organisationId, to: ctx.fromId, commentId: ctx.commentId, text: bot.askMessage,
                    buttons: [{ title: bot.followButton, payload: `${GATE_PREFIX}${bot.id}:${ctx.commentId}` }], source: 'comment_bot', botId: bot.id, username: ctx.fromUsername
                });
            } catch (err: any) {
                await prisma.instagramGateEvent.update({ where: { botId_commentId: { botId: bot.id, commentId: ctx.commentId } }, data: { state: 'failed', error: String(err.message).slice(0, 300) } });
            }
        }
    },

    /** The person tapped the "I'm following" button: verify the follow, then deliver the reward. */
    async handleGateResponse(ctx: { account: Account; igsid: string; payload: string }) {
        if (!ctx.payload.startsWith(GATE_PREFIX)) return false;
        const [botId, commentId] = ctx.payload.slice(GATE_PREFIX.length).split(':');
        const event = await prisma.instagramGateEvent.findUnique({ where: { botId_commentId: { botId, commentId } }, include: { bot: true } });
        if (!event || event.bot.organisationId !== ctx.account.organisationId || event.bot.isDeleted) return true;
        if (event.igsid && event.igsid !== ctx.igsid) return true; // someone else's button
        if (event.state === 'rewarded') return true;

        const bot = event.bot;
        let follows = false;
        try {
            const profile = await ig.get<{ is_user_follow_business?: boolean }>(ctx.igsid, InstagramAuthService.token(ctx.account), { fields: 'is_user_follow_business' });
            follows = profile.is_user_follow_business === true;
        } catch (err: any) {
            console.error('[InstagramBot] follow check failed:', err.message);
        }

        try {
            if (follows) {
                await InstagramSender.send({
                    organisationId: ctx.account.organisationId, to: ctx.igsid, source: 'comment_bot', botId: bot.id,
                    text: bot.rewardLink ? `${bot.rewardMessage}\n${bot.rewardLink}` : bot.rewardMessage
                });
                await prisma.instagramGateEvent.update({ where: { id: event.id }, data: { state: 'rewarded', attempts: { increment: 1 } } });
            } else if (event.attempts < MAX_GATE_ATTEMPTS) {
                await prisma.instagramGateEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } });
                await InstagramSender.send({
                    organisationId: ctx.account.organisationId, to: ctx.igsid, source: 'comment_bot', botId: bot.id, text: bot.notFollowingMessage,
                    buttons: [{ title: bot.followButton, payload: ctx.payload }]
                });
            }
        } catch (err: any) {
            await prisma.instagramGateEvent.update({ where: { id: event.id }, data: { state: 'failed', error: String(err.message).slice(0, 300) } });
        }
        return true;
    }
};
