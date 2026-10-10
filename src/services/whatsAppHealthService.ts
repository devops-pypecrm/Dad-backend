import axios from 'axios';
import prisma from '../config/prisma';
import { WHATSAPP_GRAPH_URL, TIER_LIMITS } from '../config/whatsapp';
import { decrypt } from '../utils/encryption';

/** Refreshes quality rating, messaging tier and token validity for each connected number. */
export const WhatsAppHealthService = {
    async checkAccount(accountId: string) {
        const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
        if (!account || account.provider !== 'meta' || !account.accessToken || !account.phoneNumberId) return null;

        try {
            const token = decrypt(account.accessToken);
            const { data } = await axios.get(`${WHATSAPP_GRAPH_URL}/${account.phoneNumberId}`, {
                params: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status', access_token: token },
                timeout: 20000
            });
            return prisma.whatsAppAccount.update({
                where: { id: accountId },
                data: {
                    qualityRating: data.quality_rating || account.qualityRating,
                    messagingTier: data.messaging_limit_tier || account.messagingTier,
                    displayName: data.verified_name || account.displayName,
                    phoneNumber: data.display_phone_number || account.phoneNumber,
                    healthCheckedAt: new Date(),
                    lastError: null
                }
            });
        } catch (err: any) {
            const message = err.response?.data?.error?.message || err.message;
            return prisma.whatsAppAccount.update({ where: { id: accountId }, data: { healthCheckedAt: new Date(), lastError: String(message).slice(0, 300) } });
        }
    },

    async checkOrg(organisationId: string) {
        const accounts = await prisma.whatsAppAccount.findMany({ where: { organisationId, isDeleted: false, provider: 'meta' }, select: { id: true } });
        const out = [];
        for (const a of accounts) out.push(await this.checkAccount(a.id));
        return out.filter(Boolean);
    },

    async checkAll() {
        const accounts = await prisma.whatsAppAccount.findMany({ where: { isDeleted: false, provider: 'meta', status: 'active' }, select: { id: true } });
        for (const a of accounts) await this.checkAccount(a.id);
    },

    /** Unique recipients we may still message today under the number's tier. */
    async remainingDailyCapacity(accountId: string | null | undefined, organisationId: string): Promise<number> {
        if (!accountId) return Number.MAX_SAFE_INTEGER;
        const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { messagingTier: true } });
        const limit = TIER_LIMITS[account?.messagingTier || 'TIER_250'] ?? 250;
        if (limit === Number.MAX_SAFE_INTEGER) return limit;
        const since = new Date(Date.now() - 24 * 60 * 60_000);
        const used = await prisma.whatsAppMessage.findMany({
            where: { organisationId, whatsappAccountId: accountId, direction: 'outgoing', messageType: 'template', createdAt: { gte: since } },
            distinct: ['phoneNumber'], select: { phoneNumber: true }
        });
        return Math.max(0, limit - used.length);
    }
};
