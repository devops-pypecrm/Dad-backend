import prisma from '../config/prisma';
import { emitToOrg } from '../socket';
import { ig } from './instagramApi';
import { InstagramAuthService } from './instagramAuthService';
import { InstagramInboxService, igPreview } from './instagramInboxService';
import { InstagramBotEngine } from './instagramBotEngine';
import { isInstagramEnabled } from './whatsAppFeature';

type Account = NonNullable<Awaited<ReturnType<typeof InstagramAuthService.getAccount>>>;

const attachmentType = (a: any): string => {
    const t = a?.type;
    if (t === 'image' || t === 'video' || t === 'audio') return t;
    if (t === 'share' || t === 'ig_reel' || t === 'reel') return 'share';
    if (t === 'story_mention') return 'story_mention';
    return 'unsupported';
};

export const InstagramWebhookService = {
    async handle(payload: any) {
        if (payload?.object !== 'instagram') return;
        for (const entry of payload.entry || []) {
            try {
                const account = await prisma.instagramAccount.findUnique({ where: { igUserId: String(entry.id) } });
                if (!account || account.isDeleted) continue;
                if (!(await isInstagramEnabled(account.organisationId))) continue; // feature switched off for this organisation

                prisma.instagramAccount.update({ where: { id: account.id }, data: { lastWebhookAt: new Date() } }).catch(() => undefined);

                for (const ev of entry.messaging || []) await this.handleMessaging(account, ev).catch(e => console.error('[InstagramWebhook] messaging error:', e));
                for (const ch of entry.changes || []) {
                    if (ch.field === 'comments') {
                        const v = ch.value || {};
                        await InstagramBotEngine.handleComment({
                            account, commentId: String(v.id), text: String(v.text || ''), fromId: String(v.from?.id || ''), fromUsername: v.from?.username,
                            mediaId: v.media?.id ? String(v.media.id) : undefined, parentId: v.parent_id
                        }).catch(e => console.error('[InstagramWebhook] comment error:', e));
                    }
                }
            } catch (err) {
                console.error('[InstagramWebhook] entry error:', err);
            }
        }
    },

    async handleMessaging(account: Account, ev: any) {
        const self = account.igUserId;

        if (ev.read) {
            const igsid = String(ev.sender?.id);
            const convo = await prisma.instagramConversation.findUnique({ where: { accountId_igsid: { accountId: account.id, igsid } } });
            if (convo) {
                await prisma.instagramMessage.updateMany({ where: { conversationId: convo.id, direction: 'outgoing', status: 'sent' }, data: { status: 'read' } });
                emitToOrg(account.organisationId, 'instagram_message_status', { conversationId: convo.id });
            }
            return;
        }

        if (ev.postback) {
            const igsid = String(ev.sender?.id);
            if (igsid === self) return;
            await InstagramBotEngine.handleGateResponse({ account, igsid, payload: String(ev.postback.payload || '') });
            return;
        }

        const m = ev.message;
        if (!m || m.is_deleted) return;

        const echo = m.is_echo === true || String(ev.sender?.id) === self;
        const igsid = String(echo ? ev.recipient?.id : ev.sender?.id);
        if (!igsid || igsid === self) return;
        const mid: string | undefined = m.mid;

        if (mid) {
            const dup = await prisma.instagramMessage.findFirst({ where: { organisationId: account.organisationId, igMessageId: mid }, select: { id: true } });
            if (dup) return; // already logged (our own send, or a webhook retry)
        }

        let messageType = 'text';
        const content: any = { text: m.text || '' };
        const att = (m.attachments || [])[0];
        if (m.reply_to?.story) { messageType = 'story_reply'; content.mediaUrl = m.reply_to.story.url; }
        else if (att) { messageType = attachmentType(att); content.mediaUrl = att.payload?.url; }

        // Profile for new conversations (name / username / avatar), best effort.
        const existing = await prisma.instagramConversation.findUnique({ where: { accountId_igsid: { accountId: account.id, igsid } } });
        let profile: { name?: string; username?: string; profile_pic?: string } = {};
        if (!echo && (!existing || !existing.username)) {
            try { profile = await ig.get(igsid, InstagramAuthService.token(account), { fields: 'name,username,profile_pic' }); } catch { /* optional */ }
        }

        const convo = await InstagramInboxService.touch({
            organisationId: account.organisationId, accountId: account.id, igsid, direction: echo ? 'outgoing' : 'incoming',
            preview: igPreview(messageType, content), username: profile.username, displayName: profile.name, profilePicUrl: profile.profile_pic,
            at: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date()
        });

        let saved;
        try {
            saved = await prisma.instagramMessage.create({
                data: {
                    organisationId: account.organisationId, accountId: account.id, conversationId: convo.id, igMessageId: mid,
                    direction: echo ? 'outgoing' : 'incoming', messageType, content, status: echo ? 'sent' : 'received', source: echo ? 'app' : 'customer'
                }
            });
        } catch (err: any) {
            if (err?.code === 'P2002') return;
            throw err;
        }
        emitToOrg(account.organisationId, 'instagram_message_received', { message: saved, conversationId: convo.id });
        if (echo) return;

        // quick-reply taps carry a payload (e.g. the Ask-to-Follow button)
        if (m.quick_reply?.payload && (await InstagramBotEngine.handleGateResponse({ account, igsid, payload: String(m.quick_reply.payload) }))) return;
        if (messageType === 'text') {
            await InstagramBotEngine.handleDirectMessage({ account, igsid, text: content.text, username: convo.username, botPausedUntil: convo.botPausedUntil });
        }
    }
};
