import axios from 'axios';
import prisma from '../config/prisma';
import { WHATSAPP_GRAPH_URL } from '../config/whatsapp';
import { listWabaCredentials, resolveWhatsAppCredentials } from './whatsAppCredentials';
import { WhatsAppService } from './whatsAppService';

type Components = Array<{ type: string; text?: string; format?: string; buttons?: any[] }>;

/** Replace {{1}}, {{2}}… in a template string with the given values (1-based). */
export const fillPlaceholders = (text: string, values: string[]): string =>
    text.replace(/\{\{(\d+)\}\}/g, (m, n) => values[Number(n) - 1] ?? m);

export const bodyVariableCount = (components: Components): number => {
    const body = components.find(c => c.type === 'BODY')?.text || '';
    const nums = (body.match(/\{\{(\d+)\}\}/g) || []).map(m => Number(m.replace(/\D/g, '')));
    return nums.length ? Math.max(...nums) : 0;
};

export const WhatsAppTemplateService = {
    /** Pull every template for every connected WABA into the local mirror. */
    async syncFromMeta(organisationId: string) {
        const wabas = await listWabaCredentials(organisationId);
        let upserted = 0;
        const seen: string[] = [];

        for (const cred of wabas) {
            let url: string | null = `${WHATSAPP_GRAPH_URL}/${cred.wabaId}/message_templates`;
            let params: any = { fields: 'id,name,status,category,language,components,rejected_reason', limit: 100 };
            while (url) {
                const { data }: { data: any } = await axios.get(url as string, { params, headers: { Authorization: `Bearer ${cred.accessToken}` }, timeout: 30000 });
                for (const t of data.data || []) {
                    seen.push(`${t.name}::${t.language}`);
                    await prisma.whatsAppTemplate.upsert({
                        where: { organisationId_name_language: { organisationId, name: t.name, language: t.language } },
                        create: {
                            organisationId, whatsappAccountId: cred.accountId, metaTemplateId: t.id, name: t.name, language: t.language,
                            category: t.category, status: t.status, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
                            components: t.components || []
                        },
                        update: {
                            metaTemplateId: t.id, category: t.category, status: t.status,
                            rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
                            components: t.components || [], syncedAt: new Date(), isDeleted: false
                        }
                    });
                    upserted++;
                }
                url = data.paging?.next || null;
                params = undefined; // `next` already carries the query string
            }
        }
        return { synced: upserted, wabas: wabas.length };
    },

    async list(organisationId: string, opts: { status?: string; refresh?: boolean } = {}) {
        const count = await prisma.whatsAppTemplate.count({ where: { organisationId, isDeleted: false } });
        if (opts.refresh || count === 0) {
            try { await this.syncFromMeta(organisationId); } catch (err: any) {
                console.error('[WhatsAppTemplates] sync failed:', err?.response?.data || err.message);
            }
        }
        return prisma.whatsAppTemplate.findMany({
            where: { organisationId, isDeleted: false, ...(opts.status ? { status: opts.status } : {}) },
            orderBy: [{ status: 'asc' }, { name: 'asc' }]
        });
    },

    async create(organisationId: string, payload: { name: string; category: string; language: string; components: any[] }, accountId?: string) {
        const cred = await resolveWhatsAppCredentials(organisationId, accountId);
        if (!cred?.wabaId) throw new Error('WhatsApp is not connected (no WhatsApp Business Account found).');
        const svc = new WhatsAppService({ accessToken: cred.accessToken, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId });
        const result = await svc.createTemplate(payload as any);
        const row = await prisma.whatsAppTemplate.upsert({
            where: { organisationId_name_language: { organisationId, name: payload.name, language: payload.language } },
            create: {
                organisationId, whatsappAccountId: cred.accountId, metaTemplateId: result.id, name: payload.name, language: payload.language,
                category: result.category || payload.category, status: result.status || 'PENDING', components: payload.components
            },
            update: { metaTemplateId: result.id, category: result.category || payload.category, status: result.status || 'PENDING', components: payload.components, rejectedReason: null, isDeleted: false }
        });
        return { meta: result, template: row };
    },

    async remove(organisationId: string, name: string) {
        const cred = await resolveWhatsAppCredentials(organisationId);
        if (!cred?.wabaId) throw new Error('WhatsApp is not connected.');
        const svc = new WhatsAppService({ accessToken: cred.accessToken, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId });
        await svc.deleteTemplate(name);
        await prisma.whatsAppTemplate.updateMany({ where: { organisationId, name }, data: { isDeleted: true } });
    },

    /** Webhook: message_template_status_update */
    async handleStatusWebhook(wabaId: string, value: any) {
        const name = value.message_template_name;
        const language = value.message_template_language;
        if (!name) return;
        const status = String(value.event || '').toUpperCase(); // APPROVED | REJECTED | PENDING | PAUSED | DISABLED | FLAGGED | REINSTATED
        const mapped = status === 'REINSTATED' ? 'APPROVED' : status === 'FLAGGED' ? 'PAUSED' : status;
        const accounts = await prisma.whatsAppAccount.findMany({ where: { wabaId, isDeleted: false }, select: { organisationId: true } });
        const orgIds = Array.from(new Set(accounts.map(a => a.organisationId)));
        for (const organisationId of orgIds) {
            await prisma.whatsAppTemplate.updateMany({
                where: { organisationId, name, ...(language ? { language } : {}) },
                data: { status: mapped, rejectedReason: value.reason && value.reason !== 'NONE' ? value.reason : null, syncedAt: new Date() }
            });
            const { emitToOrg } = await import('../socket');
            emitToOrg(organisationId, 'whatsapp_template_updated', { name, status: mapped });
        }
    },

    async findApproved(organisationId: string, name: string, language?: string) {
        return prisma.whatsAppTemplate.findFirst({
            where: { organisationId, name, status: 'APPROVED', isDeleted: false, ...(language ? { language } : {}) }
        });
    },

    /** Build Cloud API `components` for a body-only variable list. */
    buildSendComponents(values: string[]) {
        return values.length ? [{ type: 'body', parameters: values.map(v => ({ type: 'text', text: v })) }] : [];
    },

    /** Human-readable text of a template with the given body values (for the inbox thread). */
    async renderText(organisationId: string, name: string, language: string | undefined, values: string[]): Promise<string | undefined> {
        const t = await prisma.whatsAppTemplate.findFirst({ where: { organisationId, name, ...(language ? { language } : {}), isDeleted: false } });
        if (!t) return undefined;
        const comps = t.components as unknown as Components;
        const header = comps.find(c => c.type === 'HEADER' && c.format === 'TEXT')?.text;
        const body = comps.find(c => c.type === 'BODY')?.text || '';
        const footer = comps.find(c => c.type === 'FOOTER')?.text;
        return [header ? fillPlaceholders(header, values) : null, fillPlaceholders(body, values), footer].filter(Boolean).join('\n');
    }
};
