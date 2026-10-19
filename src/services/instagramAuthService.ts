import axios from 'axios';
import jwt from 'jsonwebtoken';
import prisma from '../config/prisma';
import { encrypt, decrypt } from '../utils/encryption';
import { IG_OAUTH_AUTHORIZE, IG_OAUTH_TOKEN, IG_SCOPES, instagramConfig, isInstagramConfigured } from '../config/instagram';
import { ig, InstagramApiError } from './instagramApi';

const STATE_SECRET = () => process.env.JWT_SECRET || instagramConfig().appSecret;

export const InstagramAuthService = {
    /** Login URL the user is sent to. State is a short-lived signed token so the callback can't be forged. */
    buildAuthUrl(params: { organisationId: string; userId: string; returnPath: string }) {
        if (!isInstagramConfigured()) throw new Error('Instagram is not configured on this platform yet (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_VERIFY_TOKEN).');
        const c = instagramConfig();
        const state = jwt.sign({ o: params.organisationId, u: params.userId, r: params.returnPath }, STATE_SECRET(), { expiresIn: '15m' });
        const q = new URLSearchParams({
            enable_fb_login: '0', force_authentication: '1', client_id: c.appId, redirect_uri: c.redirectUri,
            response_type: 'code', scope: IG_SCOPES.join(','), state
        });
        return `${IG_OAUTH_AUTHORIZE}?${q.toString()}`;
    },

    verifyState(state: string): { organisationId: string; userId: string; returnPath: string } {
        const d = jwt.verify(state, STATE_SECRET()) as { o: string; u: string; r: string };
        return { organisationId: d.o, userId: d.u, returnPath: d.r };
    },

    /** code -> short-lived token -> long-lived token (60 days) */
    async exchangeCode(code: string) {
        const c = instagramConfig();
        const form = new URLSearchParams({ client_id: c.appId, client_secret: c.appSecret, grant_type: 'authorization_code', redirect_uri: c.redirectUri, code });
        let short: { access_token: string; user_id?: string | number; permissions?: string[] };
        try {
            short = (await axios.post(IG_OAUTH_TOKEN, form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000 })).data;
        } catch (err: any) {
            throw new InstagramApiError(err.response?.data?.error_message || err.response?.data?.error?.message || 'Instagram login failed', err.response?.data?.code, err.response?.status);
        }
        let long: { access_token: string; expires_in: number };
        try {
            long = (await axios.get('https://graph.instagram.com/access_token', { params: { grant_type: 'ig_exchange_token', client_secret: c.appSecret, access_token: short.access_token }, timeout: 20000 })).data;
        } catch (err: any) {
            throw new InstagramApiError(err.response?.data?.error?.message || 'Could not get a long-lived Instagram token', err.response?.data?.error?.code, err.response?.status);
        }
        return { token: long.access_token, expiresAt: new Date(Date.now() + long.expires_in * 1000), scopes: short.permissions || IG_SCOPES };
    },

    async fetchProfile(token: string) {
        return ig.get<{ user_id: string; username: string; name?: string; account_type?: string; profile_picture_url?: string; followers_count?: number; media_count?: number }>(
            'me', token, { fields: 'user_id,username,name,account_type,profile_picture_url,followers_count,media_count' }
        );
    },

    /** Tell Instagram to send this account's messages/comments to our webhook. */
    async subscribeWebhooks(token: string) {
        await ig.post('me/subscribed_apps', token, {}, { subscribed_fields: 'messages,messaging_postbacks,messaging_seen,comments' });
    },

    /** Complete a connect: store (encrypted) token, profile, webhook subscription. */
    async connect(organisationId: string, userId: string, code: string) {
        const { token, expiresAt, scopes } = await this.exchangeCode(code);
        const profile = await this.fetchProfile(token);
        if (!profile.user_id) throw new Error('Instagram did not return an account id.');

        // One Instagram account can belong to one organisation only (webhooks are routed by account id).
        const existing = await prisma.instagramAccount.findUnique({ where: { igUserId: String(profile.user_id) } });
        if (existing && existing.organisationId !== organisationId && !existing.isDeleted) {
            throw new Error('This Instagram account is already connected to another organisation.');
        }

        let subscribed: Date | null = null;
        try { await this.subscribeWebhooks(token); subscribed = new Date(); } catch (err: any) { console.error('[Instagram] webhook subscribe failed:', err.message); }

        const data = {
            organisationId, username: profile.username, name: profile.name || null, profilePicUrl: profile.profile_picture_url || null,
            accountType: profile.account_type || null, followersCount: profile.followers_count ?? null, mediaCount: profile.media_count ?? null,
            accessToken: encrypt(token), tokenExpiresAt: expiresAt, scopes, status: 'active', lastError: null,
            webhookSubscribedAt: subscribed, connectedById: userId, connectedAt: new Date(), isDeleted: false
        };
        return prisma.instagramAccount.upsert({
            where: { igUserId: String(profile.user_id) },
            create: { igUserId: String(profile.user_id), ...data },
            update: data
        });
    },

    async disconnect(organisationId: string) {
        const accounts = await prisma.instagramAccount.findMany({ where: { organisationId, isDeleted: false } });
        for (const a of accounts) {
            try { await ig.delete('me/subscribed_apps', decrypt(a.accessToken)); } catch { /* best effort */ }
        }
        await prisma.instagramAccount.updateMany({ where: { organisationId, isDeleted: false }, data: { isDeleted: true, status: 'inactive' } });
        // stop automations tied to the account
        await prisma.instagramChatbot.updateMany({ where: { organisationId }, data: { isActive: false } });
        await prisma.instagramGateBot.updateMany({ where: { organisationId }, data: { isActive: false } });
    },

    /** Long-lived tokens last 60 days; refresh any that expire within 10 days. */
    async refreshExpiring() {
        const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
        const accounts = await prisma.instagramAccount.findMany({
            where: { isDeleted: false, status: { in: ['active', 'needs_reauth'] }, tokenExpiresAt: { lte: soon }, organisation: { enabledFeatures: { has: 'instagram' }, isDeleted: false } }
        });
        for (const a of accounts) {
            try {
                const { data } = await axios.get('https://graph.instagram.com/refresh_access_token', { params: { grant_type: 'ig_refresh_token', access_token: decrypt(a.accessToken) }, timeout: 20000 });
                await prisma.instagramAccount.update({ where: { id: a.id }, data: { accessToken: encrypt(data.access_token), tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000), status: 'active', lastError: null } });
            } catch (err: any) {
                await prisma.instagramAccount.update({ where: { id: a.id }, data: { status: 'needs_reauth', lastError: String(err.response?.data?.error?.message || err.message).slice(0, 300) } });
            }
        }
    },

    async getAccount(organisationId: string) {
        return prisma.instagramAccount.findFirst({ where: { organisationId, isDeleted: false } });
    },

    token(account: { accessToken: string }) { return decrypt(account.accessToken); }
};
