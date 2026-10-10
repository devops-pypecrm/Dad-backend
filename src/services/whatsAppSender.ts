import prisma from '../config/prisma';
import { WhatsAppService } from './whatsAppService';
import { resolveWhatsAppCredentials } from './whatsAppCredentials';
import { WhatsAppConversationService, previewFor, windowState } from './whatsAppConversationService';
import { WhatsAppComplianceService } from './whatsAppComplianceService';
import { WhatsAppTemplateService } from './whatsAppTemplateService';
import { digitsOnly, isValidWhatsAppNumber } from '../utils/whatsappPhone';
import { emitToOrg } from '../socket';

export type SendSource = 'agent' | 'flow' | 'ai' | 'auto_responder' | 'nurture' | 'campaign' | 'workflow';

export class WhatsAppSendError extends Error {
    constructor(public code: 'NOT_CONNECTED' | 'INVALID_NUMBER' | 'WINDOW_CLOSED' | 'OPTED_OUT' | 'TEMPLATE_NOT_APPROVED' | 'API_ERROR', message: string) {
        super(message);
    }
}

export interface SendParams {
    organisationId: string;
    to: string;
    accountId?: string | null;
    source?: SendSource;
    agentId?: string | null;
    leadId?: string | null;
    contactId?: string | null;
    campaignId?: string | null;
    // exactly one payload
    text?: string;
    template?: { name: string; language: string; values?: string[] };
    media?: { type: 'image' | 'document' | 'audio' | 'video'; mediaId: string; caption?: string; filename?: string };
    interactive?:
        | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
        | { kind: 'list'; body: string; buttonText: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] };
}

const BUSINESS_INITIATED: SendSource[] = ['campaign', 'nurture', 'auto_responder', 'workflow'];

/**
 * The only place that talks to the Cloud API to send. It enforces, in one spot:
 *   - number validity
 *   - opt-out (business-initiated messages are never sent to people who said STOP)
 *   - the 24h customer-service window (outside it, only approved templates are allowed)
 *   - approved-template check
 * and records every message so the inbox, analytics and delivery webhooks line up.
 */
export const WhatsAppSender = {
    async send(p: SendParams) {
        const source: SendSource = p.source || 'agent';
        const phone = digitsOnly(p.to);
        if (!isValidWhatsAppNumber(phone)) throw new WhatsAppSendError('INVALID_NUMBER', 'Enter a valid number with country code.');

        const cred = await resolveWhatsAppCredentials(p.organisationId, p.accountId);
        if (!cred) throw new WhatsAppSendError('NOT_CONNECTED', 'WhatsApp is not connected. Connect a number first.');

        const isTemplate = !!p.template;
        if (BUSINESS_INITIATED.includes(source) && (await WhatsAppComplianceService.isOptedOut(p.organisationId, phone))) {
            throw new WhatsAppSendError('OPTED_OUT', 'This contact has opted out of WhatsApp messages.');
        }

        const accountKey = cred.accountId || 'default';
        const existing = await prisma.whatsAppConversation.findUnique({
            where: { organisationId_accountKey_phoneNumber: { organisationId: p.organisationId, accountKey, phoneNumber: phone } }
        });
        if (!isTemplate && !windowState(existing?.lastInboundAt).open) {
            throw new WhatsAppSendError('WINDOW_CLOSED', 'The 24-hour reply window is closed. Send an approved template to re-open the conversation.');
        }

        let renderedText: string | undefined = p.text;
        let components: any[] = [];
        if (p.template) {
            const approved = await WhatsAppTemplateService.findApproved(p.organisationId, p.template.name, p.template.language);
            // Only enforce when we have a mirror; an un-synced template is still sent and Meta is the final judge.
            const anyMirror = await prisma.whatsAppTemplate.findFirst({ where: { organisationId: p.organisationId, name: p.template.name, language: p.template.language } });
            if (anyMirror && !approved) throw new WhatsAppSendError('TEMPLATE_NOT_APPROVED', `Template "${p.template.name}" is ${anyMirror.status.toLowerCase()} and cannot be sent yet.`);
            components = WhatsAppTemplateService.buildSendComponents(p.template.values || []);
            renderedText = await WhatsAppTemplateService.renderText(p.organisationId, p.template.name, p.template.language, p.template.values || []);
        }

        const svc = new WhatsAppService({ accessToken: cred.accessToken, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId });
        const messageType = p.template ? 'template' : p.media ? p.media.type : p.interactive ? 'interactive' : 'text';
        const content: any = p.template
            ? { templateName: p.template.name, language: p.template.language, values: p.template.values || [], text: renderedText }
            : p.media
                ? { mediaUrl: p.media.mediaId, caption: p.media.caption, fileName: p.media.filename }
                : p.interactive
                    ? { text: p.interactive.body, ...(p.interactive.kind === 'buttons' ? { buttons: p.interactive.buttons } : { sections: p.interactive.sections }) }
                    : { text: p.text };

        const convo = await WhatsAppConversationService.touch({
            organisationId: p.organisationId, whatsappAccountId: cred.accountId, phoneNumber: phone, direction: 'outgoing',
            preview: previewFor(messageType, content), leadId: p.leadId, contactId: p.contactId
        });

        const base = {
            conversationId: convo.id,
            phoneNumber: phone,
            direction: 'outgoing',
            messageType,
            content,
            organisationId: p.organisationId,
            leadId: p.leadId || convo.leadId || undefined,
            contactId: p.contactId || convo.contactId || undefined,
            agentId: p.agentId || undefined,
            campaignId: p.campaignId || undefined,
            whatsappAccountId: cred.accountId || undefined,
            source
        };

        try {
            const result = p.template
                ? await svc.sendTemplateMessage(phone, p.template.name, p.template.language, components)
                : p.media
                    ? await svc.sendMediaMessage(phone, p.media.type, p.media.mediaId, p.media.caption, p.media.filename)
                    : p.interactive
                        ? (p.interactive.kind === 'buttons'
                            ? await svc.sendInteractiveButtonsMessage(phone, p.interactive.body, p.interactive.buttons)
                            : await svc.sendInteractiveListMessage(phone, p.interactive.body, p.interactive.buttonText, p.interactive.sections))
                        : await svc.sendTextMessage(phone, p.text!);

            const message = await prisma.whatsAppMessage.create({
                data: { ...base, status: 'sent', waMessageId: result.messages?.[0]?.id, sentAt: new Date() }
            });
            emitToOrg(p.organisationId, 'whatsapp_message_received', { message, phoneNumber: phone, conversationId: convo.id });
            if (source === 'agent') await WhatsAppConversationService.pauseBots(convo.id);
            return { message, conversationId: convo.id };
        } catch (err: any) {
            const failed = await prisma.whatsAppMessage.create({
                data: { ...base, status: 'failed', errorMessage: err.message }
            }).catch(() => null);
            if (failed) emitToOrg(p.organisationId, 'whatsapp_message_received', { message: failed, phoneNumber: phone, conversationId: convo.id });
            throw new WhatsAppSendError('API_ERROR', err.message || 'WhatsApp rejected the message.');
        }
    }
};
