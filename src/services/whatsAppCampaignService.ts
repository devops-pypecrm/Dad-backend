import prisma from '../config/prisma';
import { WhatsAppSender, WhatsAppSendError } from './whatsAppSender';
import { WhatsAppComplianceService } from './whatsAppComplianceService';
import { WhatsAppTemplateService } from './whatsAppTemplateService';
import { WhatsAppHealthService } from './whatsAppHealthService';
import { resolveParams, ParamSpec } from '../utils/whatsappAutomation';
import { toWhatsAppNumber } from '../utils/whatsappPhone';
import { logger } from '../utils/logger';

const MAX_AUDIENCE = 5000;
const BATCH = 5;
const BATCH_DELAY_MS = 400;

export interface AudienceFilter {
    sources?: string[];
    statuses?: string[];
    tags?: string[];
    assignedToIds?: string[];
    branchId?: string;
    createdFrom?: string;
    createdTo?: string;
}

interface Recipient { phone: string; name: string; leadId?: string; contactId?: string; lead?: any }

export interface AudienceResult {
    recipients: Recipient[];
    total: number;
    skipped: { noNumber: number; optedOut: number; duplicates: number };
}

const leadWhere = (organisationId: string, f: AudienceFilter) => ({
    organisationId,
    isDeleted: false,
    ...(f.sources?.length ? { source: { in: f.sources as any } } : {}),
    ...(f.statuses?.length ? { status: { in: f.statuses } } : {}),
    ...(f.tags?.length ? { tags: { hasSome: f.tags } } : {}),
    ...(f.assignedToIds?.length ? { assignedToId: { in: f.assignedToIds } } : {}),
    ...(f.branchId ? { branchId: f.branchId } : {}),
    ...((f.createdFrom || f.createdTo) ? { createdAt: { ...(f.createdFrom ? { gte: new Date(f.createdFrom) } : {}), ...(f.createdTo ? { lte: new Date(f.createdTo) } : {}) } } : {})
});

const contactPhone = (phones: any): string | null => {
    if (!phones) return null;
    if (Array.isArray(phones)) return phones[0] || null;
    if (typeof phones === 'string') return phones;
    if (typeof phones === 'object' && phones.primary) return phones.primary;
    return null;
};

export const WhatsAppCampaignService = {
    /** Resolve explicit recipients + saved lead filter into a de-duplicated, consent-checked list. */
    async buildAudience(organisationId: string, input: { recipients?: any[]; audienceFilter?: AudienceFilter | null; testNumber?: string | null }): Promise<AudienceResult> {
        const raw: Recipient[] = [];
        let noNumber = 0;

        for (const r of input.recipients || []) {
            if (r.type === 'phone') {
                const phone = toWhatsAppNumber(r.phone);
                phone ? raw.push({ phone, name: r.name || r.phone }) : noNumber++;
            } else if (r.type === 'lead') {
                const lead = await prisma.lead.findFirst({ where: { id: r.id, organisationId, isDeleted: false } });
                const phone = lead && toWhatsAppNumber(lead.phone, { phoneCountryCode: lead.phoneCountryCode, countryCode: lead.countryCode });
                phone ? raw.push({ phone, name: `${lead!.firstName} ${lead!.lastName || ''}`.trim(), leadId: lead!.id, lead }) : noNumber++;
            } else if (r.type === 'contact') {
                const c = await prisma.contact.findFirst({ where: { id: r.id, organisationId } });
                const phone = c && toWhatsAppNumber(contactPhone(c.phones));
                phone ? raw.push({ phone, name: `${c!.firstName} ${c!.lastName || ''}`.trim(), contactId: c!.id }) : noNumber++;
            }
        }

        if (input.audienceFilter && Object.keys(input.audienceFilter).length) {
            const leads = await prisma.lead.findMany({ where: leadWhere(organisationId, input.audienceFilter), take: MAX_AUDIENCE, orderBy: { createdAt: 'desc' } });
            for (const lead of leads) {
                const phone = toWhatsAppNumber(lead.phone, { phoneCountryCode: lead.phoneCountryCode, countryCode: lead.countryCode });
                phone ? raw.push({ phone, name: `${lead.firstName} ${lead.lastName || ''}`.trim(), leadId: lead.id, lead }) : noNumber++;
            }
        }

        if (!raw.length && input.testNumber) {
            const phone = toWhatsAppNumber(input.testNumber);
            if (phone) raw.push({ phone, name: 'Test Recipient' });
        }

        const seen = new Set<string>();
        const unique: Recipient[] = [];
        let duplicates = 0;
        for (const r of raw) {
            if (seen.has(r.phone)) { duplicates++; continue; }
            seen.add(r.phone);
            unique.push(r);
        }

        const optedOut = await WhatsAppComplianceService.optedOutSet(organisationId, unique.map(r => r.phone));
        const eligible = unique.filter(r => !optedOut.has(r.phone)).slice(0, MAX_AUDIENCE);

        return { recipients: eligible, total: eligible.length, skipped: { noNumber, optedOut: optedOut.size, duplicates } };
    },

    async preview(organisationId: string, input: { recipients?: any[]; audienceFilter?: AudienceFilter | null; whatsappAccountId?: string | null }) {
        const a = await this.buildAudience(organisationId, input);
        const capacity = await WhatsAppHealthService.remainingDailyCapacity(input.whatsappAccountId, organisationId);
        return {
            count: a.total,
            skipped: a.skipped,
            sample: a.recipients.slice(0, 5).map(r => ({ name: r.name, phone: `+${r.phone.slice(0, -4).replace(/\d/g, '•')}${r.phone.slice(-4)}` })),
            dailyCapacity: capacity === Number.MAX_SAFE_INTEGER ? null : capacity,
            exceedsCapacity: capacity !== Number.MAX_SAFE_INTEGER && a.total > capacity
        };
    },

    async refreshStats(campaignId: string) {
        const [byStatus, sentRows] = await Promise.all([
            prisma.whatsAppMessage.groupBy({ by: ['status'], where: { campaignId }, _count: true }),
            prisma.whatsAppMessage.findMany({ where: { campaignId, status: { not: 'failed' } }, select: { phoneNumber: true, createdAt: true, organisationId: true }, orderBy: { createdAt: 'asc' } })
        ]);
        const n = (s: string) => byStatus.find(b => b.status === s)?._count || 0;
        const read = n('read');
        const delivered = n('delivered') + read;
        const failed = n('failed');
        const sent = n('sent') + delivered;

        // replied = distinct recipients who messaged back after the broadcast started
        let replied = 0;
        if (sentRows.length) {
            const first = sentRows[0].createdAt;
            const phones = Array.from(new Set(sentRows.map(r => r.phoneNumber)));
            const inbound = await prisma.whatsAppMessage.findMany({
                where: { organisationId: sentRows[0].organisationId, direction: 'incoming', phoneNumber: { in: phones }, createdAt: { gt: first } },
                distinct: ['phoneNumber'], select: { phoneNumber: true }
            });
            replied = inbound.length;
        }
        const existing = await prisma.whatsAppCampaign.findUnique({ where: { id: campaignId }, select: { stats: true } });
        const stats = { ...((existing?.stats as any) || {}), sent, delivered, read, failed, replied };
        await prisma.whatsAppCampaign.update({ where: { id: campaignId }, data: { stats } });
        return stats;
    },

    async process(campaignId: string, opts: { retryFailedOnly?: boolean } = {}) {
        // claim atomically so a manual send and the scheduler can't both run it
        const claim = await prisma.whatsAppCampaign.updateMany({
            where: { id: campaignId, isDeleted: false, status: { in: opts.retryFailedOnly ? ['sent', 'failed'] : ['draft', 'scheduled'] } },
            data: { status: 'sending' }
        });
        if (claim.count !== 1) return;

        const fail = async (message: string) => {
            const cur = await prisma.whatsAppCampaign.findUnique({ where: { id: campaignId }, select: { stats: true } });
            await prisma.whatsAppCampaign.update({ where: { id: campaignId }, data: { status: 'failed', stats: { ...((cur?.stats as any) || {}), error: message } } });
        };

        try {
            const campaign = await prisma.whatsAppCampaign.findUnique({ where: { id: campaignId } });
            if (!campaign) return;
            const orgId = campaign.organisationId;

            if (!campaign.templateId) return fail('Broadcasts must use an approved WhatsApp template. Free-text broadcasts are not allowed by WhatsApp.');
            const language = campaign.templateLanguage || 'en_US';

            let tpl = await WhatsAppTemplateService.findApproved(orgId, campaign.templateId, language);
            if (!tpl) {
                await WhatsAppTemplateService.syncFromMeta(orgId).catch(() => undefined);
                tpl = await WhatsAppTemplateService.findApproved(orgId, campaign.templateId, language);
            }
            if (!tpl) return fail(`Template "${campaign.templateId}" (${language}) is not approved yet.`);

            let audience = await this.buildAudience(orgId, { recipients: campaign.recipients as any[], audienceFilter: campaign.audienceFilter as any, testNumber: campaign.testNumber });
            if (opts.retryFailedOnly) {
                const failedPhones = new Set((await prisma.whatsAppMessage.findMany({ where: { campaignId, status: 'failed' }, select: { phoneNumber: true } })).map(m => m.phoneNumber));
                const okPhones = new Set((await prisma.whatsAppMessage.findMany({ where: { campaignId, status: { not: 'failed' } }, select: { phoneNumber: true } })).map(m => m.phoneNumber));
                audience = { ...audience, recipients: audience.recipients.filter(r => failedPhones.has(r.phone) && !okPhones.has(r.phone)) };
            }
            if (!audience.recipients.length) return fail('No eligible recipients (missing numbers or all opted out).');

            if (campaign.whatsappAccountId) {
                const acct = await prisma.whatsAppAccount.findUnique({ where: { id: campaign.whatsappAccountId }, select: { messagingTier: true } });
                if (!acct?.messagingTier) await WhatsAppHealthService.checkAccount(campaign.whatsappAccountId).catch(() => undefined);
            }
            const capacity = await WhatsAppHealthService.remainingDailyCapacity(campaign.whatsappAccountId, orgId);
            if (audience.recipients.length > capacity) {
                return fail(`This audience (${audience.recipients.length}) exceeds today's remaining limit for this number (${capacity}). Narrow the audience or schedule it for tomorrow.`);
            }

            await prisma.whatsAppCampaign.update({ where: { id: campaignId }, data: { sentAt: campaign.sentAt || new Date(), audienceCount: audience.total } });
            const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { name: true } });
            const specs = (campaign.templateParams as unknown as ParamSpec[]) || [];

            for (let i = 0; i < audience.recipients.length; i += BATCH) {
                const batch = audience.recipients.slice(i, i + BATCH);
                await Promise.all(batch.map(async r => {
                    try {
                        await WhatsAppSender.send({
                            organisationId: orgId, to: r.phone, accountId: campaign.whatsappAccountId, source: 'campaign',
                            agentId: campaign.createdById, leadId: r.leadId, contactId: r.contactId, campaignId,
                            template: { name: campaign.templateId!, language, values: resolveParams(specs, r.lead || { firstName: r.name.split(' ')[0] }, org?.name) }
                        });
                        if (r.leadId) {
                            await prisma.interaction.create({
                                data: { organisationId: orgId, type: 'other', subject: `WhatsApp campaign: ${campaign.name}`, description: `Sent template ${campaign.templateId}`, direction: 'outbound', leadId: r.leadId, createdById: campaign.createdById, phoneNumber: r.phone }
                            }).catch(() => undefined);
                        }
                    } catch (err) {
                        if (!(err instanceof WhatsAppSendError)) logger.error(`Campaign send failed for ${r.phone}`, err, 'WhatsAppCampaign');
                    }
                }));
                if (i % 50 === 0) await this.refreshStats(campaignId);
                await new Promise(res => setTimeout(res, BATCH_DELAY_MS));
            }

            const stats = await this.refreshStats(campaignId);
            const allFailed = stats.sent === 0 && stats.failed > 0;
            await prisma.whatsAppCampaign.update({ where: { id: campaignId }, data: { status: allFailed ? 'failed' : 'sent', sentAt: new Date() } });
        } catch (err: any) {
            logger.error(`Campaign ${campaignId} crashed`, err, 'WhatsAppCampaign');
            await fail(err.message || 'Unexpected error');
        }
    },

    /** Scheduler hook: start campaigns whose scheduled time has arrived. */
    async tickScheduled() {
        const due = await prisma.whatsAppCampaign.findMany({ where: { status: 'scheduled', isDeleted: false, scheduledAt: { lte: new Date() } }, select: { id: true }, take: 5 });
        for (const c of due) this.process(c.id).catch(err => logger.error('Scheduled campaign failed', err, 'WhatsAppCampaign'));
    },

    async detail(organisationId: string, id: string, opts: { status?: string; page?: number } = {}) {
        const campaign = await prisma.whatsAppCampaign.findFirst({ where: { id, organisationId, isDeleted: false } });
        if (!campaign) return null;
        const take = 50;
        const where: any = { campaignId: id, organisationId, ...(opts.status ? { status: opts.status } : {}) };
        const [messages, total] = await Promise.all([
            prisma.whatsAppMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: ((opts.page || 1) - 1) * take, include: { lead: { select: { id: true, firstName: true, lastName: true } } } }),
            prisma.whatsAppMessage.count({ where })
        ]);
        const stats = ['sending'].includes(campaign.status) ? await this.refreshStats(id) : (campaign.stats as any);
        return { campaign: { ...campaign, stats }, recipients: messages, total, page: opts.page || 1, pageSize: take };
    }
};
