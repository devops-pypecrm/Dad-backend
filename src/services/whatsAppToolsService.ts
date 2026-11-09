import axios from 'axios';
import prisma from '../config/prisma';
import { WHATSAPP_GRAPH_URL } from '../config/whatsapp';
import { resolveWhatsAppCredentials, WhatsAppCredentials } from './whatsAppCredentials';
import { metaErrorMessage } from './whatsAppService';
import { HttpError } from '../utils/whatsappHttp';

/**
 * WhatsApp "Growth Tools": Meta-side analytics, business profile, QR codes & links, conversation starters
 * and blocked users. Self-contained: it only reads credentials and never touches sending, inbox or CRM data.
 */

const call = async <T = any>(method: 'get' | 'post' | 'delete', path: string, token: string, opts: { params?: any; body?: any } = {}): Promise<T> => {
    try {
        const { data } = await axios.request({
            method, url: `${WHATSAPP_GRAPH_URL}/${path}`, params: opts.params, data: opts.body,
            headers: { Authorization: `Bearer ${token}` }, timeout: 25000
        });
        return data;
    } catch (err: any) {
        throw new HttpError(err?.response?.status === 401 ? 401 : 502, metaErrorMessage(err, 'WhatsApp request failed'));
    }
};

/** Run one Meta request and turn a failure into `{ available: false, error }` so one missing permission never breaks a whole page. */
const soft = async <T>(fn: () => Promise<T>): Promise<{ available: true; data: T } | { available: false; error: string }> => {
    try { return { available: true, data: await fn() }; } catch (e: any) { return { available: false, error: e?.message || 'Unavailable' }; }
};

const needCreds = async (organisationId: string, accountId?: string, needWaba = false): Promise<WhatsAppCredentials> => {
    const c = await resolveWhatsAppCredentials(organisationId, accountId || null);
    if (!c || c.provider !== 'meta' || !c.phoneNumberId) throw new HttpError(412, 'Connect a WhatsApp number (Meta Cloud API) first.', 'NOT_CONNECTED');
    if (needWaba && !c.wabaId) throw new HttpError(412, 'This number has no WhatsApp Business Account ID saved. Add it in WhatsApp Settings.', 'NO_WABA');
    return c;
};

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const range = (days: number) => { const end = new Date(); const start = new Date(end.getTime() - Math.min(Math.max(days, 1), 90) * 86_400_000); return { start: unix(start), end: unix(end) }; };

export const WhatsAppToolsService = {
    async accounts(organisationId: string) {
        const rows = await prisma.whatsAppAccount.findMany({
            where: { organisationId, isDeleted: false, status: 'active', provider: 'meta' },
            select: { id: true, phoneNumber: true, displayName: true, phoneNumberId: true, wabaId: true, isDefault: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
        });
        return rows;
    },

    // ---------------- analytics (Meta) ----------------
    async analytics(organisationId: string, accountId: string | undefined, days: number) {
        const c = await needCreds(organisationId, accountId, true);
        const { start, end } = range(days);
        const waba = c.wabaId!;
        const phones = JSON.stringify([c.displayPhoneNumber?.replace(/\D/g, '')].filter(Boolean));

        const messaging = await soft(async () => {
            const r = await call(`get`, waba, c.accessToken, { params: { fields: `analytics.start(${start}).end(${end}).granularity(DAY)` } });
            return (r.analytics?.data_points || []).map((p: any) => ({ date: new Date(p.start * 1000).toISOString().slice(0, 10), sent: p.sent || 0, delivered: p.delivered || 0 }));
        });
        const conversations = await soft(async () => {
            const r = await call(`get`, waba, c.accessToken, { params: { fields: `conversation_analytics.start(${start}).end(${end}).granularity(DAILY).phone_numbers(${phones}).dimensions(["CONVERSATION_CATEGORY","CONVERSATION_TYPE"])` } });
            const points = r.conversation_analytics?.data?.[0]?.data_points || [];
            return points.map((p: any) => ({ date: new Date(p.start * 1000).toISOString().slice(0, 10), category: p.conversation_category || 'UNKNOWN', type: p.conversation_type || 'UNKNOWN', conversations: p.conversation || 0, cost: p.cost || 0 }));
        });
        const templates = await soft(async () => {
            const list = await call(`get`, `${waba}/message_templates`, c.accessToken, { params: { fields: 'id,name,category', status: 'APPROVED', limit: 10 } });
            const ids: string[] = (list.data || []).map((t: any) => t.id);
            if (!ids.length) return [];
            const r = await call(`get`, `${waba}/template_analytics`, c.accessToken, { params: { start, end, granularity: 'DAILY', metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ', 'CLICKED']), template_ids: JSON.stringify(ids) } });
            const names = new Map<string, string>((list.data || []).map((t: any) => [String(t.id), t.name]));
            const out: Record<string, { name: string; sent: number; delivered: number; read: number; clicked: number }> = {};
            for (const block of r.data || []) for (const p of block.data_points || []) {
                const id = String(p.template_id);
                const row = (out[id] ||= { name: names.get(id) || id, sent: 0, delivered: 0, read: 0, clicked: 0 });
                row.sent += p.sent || 0; row.delivered += p.delivered || 0; row.read += p.read || 0;
                row.clicked += (p.clicked || []).reduce((s: number, x: any) => s + (x.count || 0), 0);
            }
            return Object.values(out);
        });
        return { days, messaging, conversations, templates };
    },

    async numberStatus(organisationId: string, accountId?: string) {
        const c = await needCreds(organisationId, accountId);
        return call('get', c.phoneNumberId, c.accessToken, { params: { fields: 'verified_name,display_phone_number,quality_rating,messaging_limit_tier,name_status,status,platform_type,throughput,is_pin_enabled,code_verification_status' } });
    },

    // ---------------- business profile ----------------
    async getProfile(organisationId: string, accountId?: string) {
        const c = await needCreds(organisationId, accountId);
        const r = await call('get', `${c.phoneNumberId}/whatsapp_business_profile`, c.accessToken, { params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' } });
        return r.data?.[0] || {};
    },
    async updateProfile(organisationId: string, accountId: string | undefined, p: { about?: string; address?: string; description?: string; email?: string; websites?: string[]; vertical?: string }) {
        const c = await needCreds(organisationId, accountId);
        const body: any = { messaging_product: 'whatsapp' };
        for (const k of ['about', 'address', 'description', 'email', 'vertical'] as const) if (typeof p[k] === 'string') body[k] = p[k];
        if (Array.isArray(p.websites)) body.websites = p.websites.filter(Boolean).slice(0, 2);
        await call('post', `${c.phoneNumberId}/whatsapp_business_profile`, c.accessToken, { body });
        return this.getProfile(organisationId, accountId);
    },

    // ---------------- QR codes & short links ----------------
    async listQr(organisationId: string, accountId?: string) {
        const c = await needCreds(organisationId, accountId);
        const r = await call('get', `${c.phoneNumberId}/message_qrdls`, c.accessToken, { params: { fields: 'code,prefilled_message,deep_link_url,qr_image_url.format(PNG)' } });
        return r.data || [];
    },
    async createQr(organisationId: string, accountId: string | undefined, message: string) {
        const c = await needCreds(organisationId, accountId);
        return call('post', `${c.phoneNumberId}/message_qrdls`, c.accessToken, { params: { prefilled_message: message, generate_qr_image: 'PNG' } });
    },
    async updateQr(organisationId: string, accountId: string | undefined, code: string, message: string) {
        const c = await needCreds(organisationId, accountId);
        return call('post', `${c.phoneNumberId}/message_qrdls`, c.accessToken, { params: { code, prefilled_message: message } });
    },
    async deleteQr(organisationId: string, accountId: string | undefined, code: string) {
        const c = await needCreds(organisationId, accountId);
        return call('delete', `${c.phoneNumberId}/message_qrdls/${encodeURIComponent(code)}`, c.accessToken);
    },

    // ---------------- conversation starters (welcome message, ice breakers, commands) ----------------
    async getStarters(organisationId: string, accountId?: string) {
        const c = await needCreds(organisationId, accountId);
        const r = await call('get', c.phoneNumberId, c.accessToken, { params: { fields: 'conversational_automation' } });
        const a = r.conversational_automation || {};
        return { enableWelcomeMessage: !!a.enable_welcome_message, prompts: a.prompts || [], commands: a.commands || [] };
    },
    async saveStarters(organisationId: string, accountId: string | undefined, s: { enableWelcomeMessage?: boolean; prompts?: string[]; commands?: { command_name: string; command_description: string }[] }) {
        const c = await needCreds(organisationId, accountId);
        const params: any = {};
        if (typeof s.enableWelcomeMessage === 'boolean') params.enable_welcome_message = s.enableWelcomeMessage;
        if (Array.isArray(s.prompts)) params.prompts = JSON.stringify(s.prompts.map(p => p.trim()).filter(Boolean).slice(0, 4));
        if (Array.isArray(s.commands)) params.commands = JSON.stringify(s.commands.filter(x => x.command_name?.trim() && x.command_description?.trim()).slice(0, 30));
        await call('post', `${c.phoneNumberId}/conversational_automation`, c.accessToken, { params });
        return this.getStarters(organisationId, accountId);
    },

    // ---------------- blocked users ----------------
    async listBlocked(organisationId: string, accountId?: string) {
        const c = await needCreds(organisationId, accountId);
        const r = await call('get', `${c.phoneNumberId}/block_users`, c.accessToken);
        return (r.data || []).map((x: any) => x.wa_id || x.input).filter(Boolean);
    },
    async setBlocked(organisationId: string, accountId: string | undefined, phone: string, block: boolean) {
        const c = await needCreds(organisationId, accountId);
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 8) throw new HttpError(400, 'Enter the phone number with country code.');
        await call(block ? 'post' : 'delete', `${c.phoneNumberId}/block_users`, c.accessToken, { body: { messaging_product: 'whatsapp', block_users: [{ user: digits }] } });
        return { ok: true };
    },

    // ---------------- Click-to-WhatsApp ad attribution (local) ----------------
    async recordReferral(organisationId: string, phone: string, leadId: string | null | undefined, referral: any) {
        if (!referral || typeof referral !== 'object') return;
        await prisma.whatsAppAdReferral.create({
            data: {
                organisationId, phone, leadId: leadId || null,
                sourceType: referral.source_type || null, sourceId: referral.source_id ? String(referral.source_id) : null,
                sourceUrl: referral.source_url || null, headline: referral.headline || null, body: referral.body || null,
                mediaType: referral.media_type || null, ctwaClid: referral.ctwa_clid || null
            }
        });
    },
    async referralSummary(organisationId: string, days: number) {
        const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 86_400_000);
        const rows = await prisma.whatsAppAdReferral.findMany({ where: { organisationId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 2000 });
        const by = new Map<string, { sourceId: string; sourceType: string | null; headline: string | null; sourceUrl: string | null; chats: number; phones: Set<string> }>();
        for (const r of rows) {
            const k = r.sourceId || r.headline || 'unknown';
            const e = by.get(k) || { sourceId: r.sourceId || '', sourceType: r.sourceType, headline: r.headline, sourceUrl: r.sourceUrl, chats: 0, phones: new Set<string>() };
            e.chats++; e.phones.add(r.phone); by.set(k, e);
        }
        return {
            total: rows.length,
            uniqueContacts: new Set(rows.map(r => r.phone)).size,
            sources: [...by.values()].map(({ phones, ...s }) => ({ ...s, contacts: phones.size })).sort((a, b) => b.chats - a.chats),
            recent: rows.slice(0, 25).map(r => ({ id: r.id, phone: r.phone, leadId: r.leadId, sourceType: r.sourceType, headline: r.headline, createdAt: r.createdAt }))
        };
    }
};
