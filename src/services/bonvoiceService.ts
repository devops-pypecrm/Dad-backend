import prisma from '../config/prisma';
import { decrypt, encrypt } from '../utils/encryption';

export interface BonvoiceConfigInput {
    apiBaseUrl: string;
    accountId: string;
    apiKey?: string;
    defaultDid?: string;
    defaultDepartmentId?: string;
    webhookSecret?: string;
    recordingEnabled?: boolean;
    createUnknownLeads?: boolean;
    missedCallFollowUp?: boolean;
}

export interface BonvoiceAgentMappingInput {
    agentId?: string;
    extension?: string;
    departmentId?: string;
    isActive?: boolean;
}

const encrypted = (value?: string) => !!value && value.split(':').length === 3;

const validateBaseUrl = (value: string) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Enter a valid Bonvoice API URL'); }
    if (url.protocol !== 'https:') throw new Error('Bonvoice API URL must use HTTPS');
    if (url.username || url.password) throw new Error('Credentials must not be included in the API URL');
    return url.origin + url.pathname.replace(/\/$/, '');
};

export const getBonvoiceConfig = async (organisationId: string) => {
    const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { integrations: true } });
    return ((org?.integrations as any)?.bonvoice || null) as any;
};

export const getPublicBonvoiceConfig = async (organisationId: string) => {
    const config = await getBonvoiceConfig(organisationId);
    if (!config) return { configured: false, connected: false };
    return {
        configured: !!(config.apiBaseUrl && config.accountId && config.apiKey),
        connected: config.connected === true,
        apiBaseUrl: config.apiBaseUrl || '',
        accountId: config.accountId || '',
        hasApiKey: !!config.apiKey,
        defaultDid: config.defaultDid || '',
        defaultDepartmentId: config.defaultDepartmentId || '',
        hasWebhookSecret: !!config.webhookSecret,
        recordingEnabled: config.recordingEnabled !== false,
        createUnknownLeads: config.createUnknownLeads === true,
        missedCallFollowUp: config.missedCallFollowUp === true,
        connectedAt: config.connectedAt || null,
        apiContractReady: false,
    };
};

export const saveBonvoiceConfig = async (organisationId: string, input: BonvoiceConfigInput) => {
    const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { integrations: true } });
    if (!org) throw new Error('Organisation not found');
    const integrations = { ...((org.integrations as any) || {}) };
    const current = integrations.bonvoice || {};
    if (!input.accountId?.trim()) throw new Error('Bonvoice account ID is required');
    if (!input.apiKey?.trim() && !current.apiKey) throw new Error('Bonvoice API key is required');

    integrations.bonvoice = {
        ...current,
        apiBaseUrl: validateBaseUrl(input.apiBaseUrl),
        accountId: input.accountId.trim(),
        apiKey: input.apiKey?.trim()
            ? (encrypted(input.apiKey.trim()) ? input.apiKey.trim() : encrypt(input.apiKey.trim()))
            : current.apiKey,
        defaultDid: input.defaultDid?.trim() || null,
        defaultDepartmentId: input.defaultDepartmentId?.trim() || null,
        webhookSecret: input.webhookSecret?.trim()
            ? (encrypted(input.webhookSecret.trim()) ? input.webhookSecret.trim() : encrypt(input.webhookSecret.trim()))
            : current.webhookSecret,
        recordingEnabled: input.recordingEnabled !== false,
        createUnknownLeads: input.createUnknownLeads === true,
        missedCallFollowUp: input.missedCallFollowUp === true,
        connected: false,
        updatedAt: new Date().toISOString(),
    };
    await prisma.organisation.update({ where: { id: organisationId }, data: { integrations } });
    return getPublicBonvoiceConfig(organisationId);
};

export const removeBonvoiceConfig = async (organisationId: string) => {
    const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { integrations: true } });
    if (!org) throw new Error('Organisation not found');
    const integrations = { ...((org.integrations as any) || {}) };
    delete integrations.bonvoice;
    await prisma.$transaction([
        prisma.organisation.update({ where: { id: organisationId }, data: { integrations } }),
        ...((await prisma.user.findMany({ where: { organisationId }, select: { id: true, integrations: true } })).map(user => {
            const userIntegrations = { ...((user.integrations as any) || {}) };
            delete userIntegrations.bonvoice;
            return prisma.user.update({ where: { id: user.id }, data: { integrations: userIntegrations } });
        })),
    ]);
};

export const listBonvoiceAgentMappings = async (organisationId: string) => {
    const users = await prisma.user.findMany({
        where: { organisationId, isDeleted: false },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, isActive: true, integrations: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return users.map(({ integrations, ...user }) => ({ ...user, mapping: (integrations as any)?.bonvoice || null }));
};

export const saveBonvoiceAgentMapping = async (organisationId: string, userId: string, input: BonvoiceAgentMappingInput) => {
    const user = await prisma.user.findFirst({ where: { id: userId, organisationId, isDeleted: false }, select: { id: true, integrations: true } });
    if (!user) throw new Error('User was not found in this organisation');
    const integrations = { ...((user.integrations as any) || {}) };
    if (!input.agentId?.trim() && !input.extension?.trim()) {
        delete integrations.bonvoice;
    } else {
        integrations.bonvoice = {
            agentId: input.agentId?.trim() || null,
            extension: input.extension?.trim() || null,
            departmentId: input.departmentId?.trim() || null,
            isActive: input.isActive !== false,
            updatedAt: new Date().toISOString(),
        };
    }
    await prisma.user.update({ where: { id: user.id }, data: { integrations } });
    return integrations.bonvoice || null;
};

export const getBonvoiceCredentials = async (organisationId: string) => {
    const config = await getBonvoiceConfig(organisationId);
    if (!config?.apiBaseUrl || !config?.accountId || !config?.apiKey) return null;
    return {
        apiBaseUrl: config.apiBaseUrl as string,
        accountId: config.accountId as string,
        apiKey: decrypt(config.apiKey),
        webhookSecret: config.webhookSecret ? decrypt(config.webhookSecret) : null,
    };
};
