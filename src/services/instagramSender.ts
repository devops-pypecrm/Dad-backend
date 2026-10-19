import prisma from '../config/prisma';
import { ig, InstagramApiError } from './instagramApi';
import { InstagramAuthService } from './instagramAuthService';
import { InstagramInboxService, igPreview, igWindowState } from './instagramInboxService';
import { isInstagramEnabled, INSTAGRAM_NOT_ENABLED_MESSAGE } from './whatsAppFeature';
import { emitToOrg } from '../socket';

export type IgSource = 'agent' | 'chatbot' | 'comment_bot';

export class InstagramSendError extends Error {
    constructor(public code: 'NOT_ENABLED' | 'NOT_CONNECTED' | 'WINDOW_CLOSED' | 'API_ERROR' | 'EMPTY', message: string) { super(message); }
}

export interface IgButton { title: string; url?: string; payload?: string }

export interface IgSendParams {
    organisationId: string;
    to: string; // IGSID of the recipient
    text?: string;
    buttons?: IgButton[]; // up to 3: url buttons, or postback buttons (payload)
    commentId?: string; // private reply to a comment (allowed up to 7 days after the comment, before any DM)
    source?: IgSource;
    botId?: string | null;
    agentId?: string | null;
    username?: string | null;
}

/**
 * The only place that sends Instagram DMs. Enforces: feature on, account connected, and
 * Instagram's 24-hour window (free-form replies only within 24h of the person's last message;
 * a private reply to a comment is the one allowed way to start a conversation).
 */
export const InstagramSender = {
    async send(p: IgSendParams) {
        if (!(await isInstagramEnabled(p.organisationId))) throw new InstagramSendError('NOT_ENABLED', INSTAGRAM_NOT_ENABLED_MESSAGE);
        if (!p.text?.trim()) throw new InstagramSendError('EMPTY', 'Nothing to send');

        const account = await InstagramAuthService.getAccount(p.organisationId);
        if (!account || account.status !== 'active') throw new InstagramSendError('NOT_CONNECTED', 'Instagram is not connected, or needs to be reconnected.');

        const convo = await prisma.instagramConversation.findUnique({ where: { accountId_igsid: { accountId: account.id, igsid: p.to } } });
        if (!p.commentId && !igWindowState(convo?.lastInboundAt).open) {
            throw new InstagramSendError('WINDOW_CLOSED', 'The 24-hour reply window is closed. You can reply again when this person messages you.');
        }

        const text = p.text.trim().slice(0, 1000);
        const buttons = (p.buttons || []).slice(0, 3);
        const message = buttons.length
            ? {
                attachment: {
                    type: 'template',
                    payload: {
                        template_type: 'button', text: text.slice(0, 640),
                        buttons: buttons.map(b => b.url
                            ? { type: 'web_url', url: b.url, title: b.title.slice(0, 20) }
                            : { type: 'postback', title: b.title.slice(0, 20), payload: b.payload || b.title })
                    }
                }
            }
            : { text };

        const base = {
            organisationId: p.organisationId, accountId: account.id, direction: 'outgoing', messageType: 'text',
            content: { text, ...(buttons.length ? { buttons: buttons.map(b => ({ title: b.title, url: b.url })) } : {}) },
            source: p.source || 'agent', botId: p.botId || undefined, agentId: p.agentId || undefined
        };
        const conversation = await InstagramInboxService.touch({
            organisationId: p.organisationId, accountId: account.id, igsid: p.to, direction: 'outgoing', preview: igPreview('text', { text }), username: p.username
        });

        try {
            const res = await ig.post<{ message_id?: string }>('me/messages', InstagramAuthService.token(account), {
                recipient: p.commentId ? { comment_id: p.commentId } : { id: p.to }, message
            });
            const saved = await prisma.instagramMessage.create({
                data: { ...base, conversationId: conversation.id, status: 'sent', igMessageId: res.message_id }
            }).catch(async (e: any) => {
                if (e?.code === 'P2002') return prisma.instagramMessage.findFirst({ where: { organisationId: p.organisationId, igMessageId: res.message_id } }); // echo webhook got there first
                throw e;
            });
            emitToOrg(p.organisationId, 'instagram_message_received', { message: saved, conversationId: conversation.id });
            if ((p.source || 'agent') === 'agent') await InstagramInboxService.pauseBots(conversation.id);
            return { message: saved, conversationId: conversation.id };
        } catch (err: any) {
            if (err instanceof InstagramApiError && err.isAuthError) {
                await prisma.instagramAccount.update({ where: { id: account.id }, data: { status: 'needs_reauth', lastError: err.message.slice(0, 300) } }).catch(() => undefined);
            }
            const failed = await prisma.instagramMessage.create({ data: { ...base, conversationId: conversation.id, status: 'failed', errorMessage: String(err.message).slice(0, 300) } }).catch(() => null);
            if (failed) emitToOrg(p.organisationId, 'instagram_message_received', { message: failed, conversationId: conversation.id });
            throw new InstagramSendError('API_ERROR', err.message || 'Instagram rejected the message.');
        }
    }
};
