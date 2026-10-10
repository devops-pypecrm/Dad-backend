import prisma from '../config/prisma';
import { decrypt } from '../utils/encryption';

export interface WhatsAppCredentials {
    accountId: string | null;
    provider: string;
    phoneNumberId: string;
    wabaId?: string;
    accessToken: string;
    displayPhoneNumber?: string;
}

/**
 * Resolve the Cloud API credentials to use for an organisation.
 * Order: explicit account -> default account -> first active Meta account ->
 * legacy single-number config stored on Organisation.integrations.
 */
export async function resolveWhatsAppCredentials(
    organisationId: string,
    accountId?: string | null
): Promise<WhatsAppCredentials | null> {
    let account = null;

    if (accountId) {
        account = await prisma.whatsAppAccount.findFirst({
            where: { id: accountId, organisationId, isDeleted: false, status: 'active' }
        });
    }
    if (!account) {
        account = await prisma.whatsAppAccount.findFirst({
            where: { organisationId, isDeleted: false, status: 'active', provider: 'meta', accessToken: { not: null }, phoneNumberId: { not: null } },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
        });
    }

    if (account?.accessToken && account.phoneNumberId) {
        try {
            return {
                accountId: account.id,
                provider: account.provider,
                phoneNumberId: account.phoneNumberId,
                wabaId: account.wabaId || undefined,
                accessToken: decrypt(account.accessToken),
                displayPhoneNumber: account.phoneNumber
            };
        } catch (err) {
            console.error('[WhatsApp] Could not decrypt account token', account.id, err);
        }
    }

    const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { integrations: true } });
    const integrations = (org?.integrations as any) || {};
    const legacy = integrations.whatsapp?.connected ? integrations.whatsapp : (integrations.meta?.phoneNumberId ? integrations.meta : null);
    if (legacy?.accessToken && legacy.phoneNumberId) {
        return {
            accountId: null,
            provider: 'meta',
            phoneNumberId: legacy.phoneNumberId,
            wabaId: legacy.wabaId,
            accessToken: decrypt(legacy.accessToken),
            displayPhoneNumber: legacy.displayPhoneNumber
        };
    }
    return null;
}

/** All WABA ids an org has connected (for template sync across numbers). */
export async function listWabaCredentials(organisationId: string): Promise<WhatsAppCredentials[]> {
    const accounts = await prisma.whatsAppAccount.findMany({
        where: { organisationId, isDeleted: false, status: 'active', provider: 'meta', accessToken: { not: null }, wabaId: { not: null } }
    });
    const seen = new Set<string>();
    const out: WhatsAppCredentials[] = [];
    for (const a of accounts) {
        if (!a.wabaId || seen.has(a.wabaId) || !a.phoneNumberId) continue;
        seen.add(a.wabaId);
        try {
            out.push({ accountId: a.id, provider: a.provider, phoneNumberId: a.phoneNumberId, wabaId: a.wabaId, accessToken: decrypt(a.accessToken!), displayPhoneNumber: a.phoneNumber });
        } catch { /* skip undecryptable */ }
    }
    if (out.length === 0) {
        const c = await resolveWhatsAppCredentials(organisationId);
        if (c?.wabaId) out.push(c);
    }
    return out;
}
