import fs from 'fs';
import prisma from '../config/prisma';
import { igExtendedEnabled } from '../config/instagram';
import { ig, InstagramApiError } from './instagramApi';
import { InstagramAuthService } from './instagramAuthService';
import { HttpError } from '../utils/whatsappHttp';

/**
 * Instagram "Growth Tools": insights, comment manager, content publishing + scheduling, DM entry points
 * (ice breakers / persistent menu) and competitor lookup. Self-contained; reads the connected account only.
 */

const toHttp = (e: any): never => {
    if (e instanceof InstagramApiError) {
        const permission = e.code === 10 || e.code === 200 || /permission|scope/i.test(e.message);
        throw new HttpError(e.isAuthError ? 401 : permission ? 403 : 502, permission
            ? `Instagram has not granted this permission yet. Reconnect the account after the permission is enabled in the Meta app. (${e.message})`
            : e.message, permission ? 'MISSING_PERMISSION' : undefined);
    }
    throw e;
};
const wrapCall = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { return toHttp(e); } };
const soft = async <T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
    try { return { ok: true, data: await fn() }; } catch (e: any) { return { ok: false, error: e?.message || 'Unavailable' }; }
};

const ctx = async (organisationId: string) => {
    const account = await InstagramAuthService.getAccount(organisationId);
    if (!account || account.status !== 'active') throw new HttpError(412, 'Connect your Instagram account first.', 'NOT_CONNECTED');
    return { account, token: InstagramAuthService.token(account) };
};

const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';

export const InstagramToolsService = {
    async status(organisationId: string) {
        const account = await InstagramAuthService.getAccount(organisationId);
        const scopes: string[] = account?.scopes || [];
        const has = (s: string) => scopes.some(x => x.endsWith(s));
        return {
            connected: !!account && account.status === 'active',
            username: account?.username,
            extendedScopesEnabled: igExtendedEnabled(),
            permissions: { insights: has('manage_insights'), publishing: has('content_publish'), comments: has('manage_comments'), messages: has('manage_messages') }
        };
    },

    // ---------------- insights ----------------
    async insights(organisationId: string, days: number) {
        const { account, token } = await ctx(organisationId);
        const d = Math.min(Math.max(days, 1), 30); // Instagram allows at most a 30-day window
        const until = new Date(); const since = new Date(until.getTime() - d * 86_400_000);
        const win = { since: unix(since), until: unix(until) };
        const id = account.igUserId;

        const profile = await wrapCall(() => ig.get(id, token, { fields: 'username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url' }));
        const metrics = ['reach', 'views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'follows_and_unfollows'];
        const totalsRaw = await Promise.all(metrics.map(m => soft(async () => {
            const r = await ig.get(`${id}/insights`, token, { metric: m, period: 'day', metric_type: 'total_value', ...win });
            return { metric: m, value: r.data?.[0]?.total_value?.value ?? 0 };
        })));
        const totals: Record<string, number> = {};
        for (const t of totalsRaw) if (t.ok) totals[t.data.metric] = t.data.value;
        const series = await soft(async () => {
            const r = await ig.get(`${id}/insights`, token, { metric: 'reach', period: 'day', ...win });
            return (r.data?.[0]?.values || []).map((v: any) => ({ date: String(v.end_time).slice(0, 10), reach: v.value || 0 }));
        });
        const demo = async (breakdown: string) => soft(async () => {
            const r = await ig.get(`${id}/insights`, token, { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', timeframe: 'last_30_days', breakdown });
            const rows = r.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
            return rows.map((x: any) => ({ label: (x.dimension_values || []).join(' / '), value: x.value || 0 })).sort((a: any, b: any) => b.value - a.value).slice(0, 10);
        });
        const [age, gender, city, country] = await Promise.all([demo('age'), demo('gender'), demo('city'), demo('country')]);
        const anyOk = totalsRaw.some(t => t.ok);
        return {
            days: d, profile, totals, series,
            demographics: { age, gender, city, country },
            permissionHint: anyOk ? null : 'Insights are not available yet. Enable the instagram_business_manage_insights permission in the Meta app and reconnect the account.'
        };
    },

    async topMedia(organisationId: string, limit = 12) {
        const { account, token } = await ctx(organisationId);
        const list = await wrapCall(() => ig.get<{ data: any[] }>(`${account.igUserId}/media`, token, { fields: MEDIA_FIELDS, limit: Math.min(limit, 25) }));
        const rows = await Promise.all((list.data || []).map(async m => {
            const ins = await soft(async () => {
                const r = await ig.get(`${m.id}/insights`, token, { metric: 'reach,saved,shares,total_interactions' });
                const o: Record<string, number> = {};
                for (const x of r.data || []) o[x.name] = x.values?.[0]?.value ?? 0;
                return o;
            });
            return { ...m, insights: ins.ok ? ins.data : null };
        }));
        return rows.sort((a, b) => (b.insights?.total_interactions ?? b.like_count ?? 0) - (a.insights?.total_interactions ?? a.like_count ?? 0));
    },

    // ---------------- comment manager ----------------
    async recentMedia(organisationId: string) {
        const { account, token } = await ctx(organisationId);
        const r = await wrapCall(() => ig.get<{ data: any[] }>(`${account.igUserId}/media`, token, { fields: MEDIA_FIELDS, limit: 25 }));
        return r.data || [];
    },
    async comments(organisationId: string, mediaId: string) {
        const { token } = await ctx(organisationId);
        const r = await wrapCall(() => ig.get<{ data: any[] }>(`${mediaId}/comments`, token, { fields: 'id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp,hidden}', limit: 50 }));
        return r.data || [];
    },
    async replyToComment(organisationId: string, commentId: string, message: string) {
        const { token } = await ctx(organisationId);
        return wrapCall(() => ig.post(`${commentId}/replies`, token, {}, { message }));
    },
    async hideComment(organisationId: string, commentId: string, hide: boolean) {
        const { token } = await ctx(organisationId);
        return wrapCall(() => ig.post(commentId, token, {}, { hide }));
    },
    async deleteComment(organisationId: string, commentId: string) {
        const { token } = await ctx(organisationId);
        return wrapCall(() => ig.delete(commentId, token));
    },
    async setCommentsEnabled(organisationId: string, mediaId: string, enabled: boolean) {
        const { token } = await ctx(organisationId);
        return wrapCall(() => ig.post(mediaId, token, {}, { comment_enabled: enabled }));
    },

    // ---------------- DM entry points ----------------
    async getMessagingProfile(organisationId: string) {
        const { account, token } = await ctx(organisationId);
        const r = await wrapCall(() => ig.get(`${account.igUserId}/messenger_profile`, token, { fields: 'ice_breakers,persistent_menu', platform: 'instagram' }));
        const d = r.data?.[0] || {};
        const questions = (d.ice_breakers?.[0]?.call_to_actions || []).map((c: any) => c.question);
        const menu = (d.persistent_menu?.[0]?.call_to_actions || []).map((c: any) => ({ type: c.type, title: c.title, url: c.url }));
        return { iceBreakers: questions, persistentMenu: menu };
    },
    async saveMessagingProfile(organisationId: string, p: { iceBreakers?: string[]; persistentMenu?: { type: 'web_url' | 'postback'; title: string; url?: string }[] }) {
        const { account, token } = await ctx(organisationId);
        const body: any = { platform: 'instagram' };
        if (p.iceBreakers) {
            const q = p.iceBreakers.map(x => x.trim()).filter(Boolean).slice(0, 4);
            body.ice_breakers = [{ locale: 'default', call_to_actions: q.map(question => ({ question, payload: `IB:${question}` })) }];
        }
        if (p.persistentMenu) {
            const items = p.persistentMenu.filter(i => i.title?.trim()).slice(0, 5).map(i => i.type === 'web_url' ? { type: 'web_url', title: i.title.trim().slice(0, 30), url: i.url } : { type: 'postback', title: i.title.trim().slice(0, 30), payload: `IB:${i.title.trim()}` });
            body.persistent_menu = [{ locale: 'default', composer_input_disabled: false, call_to_actions: items }];
        }
        await wrapCall(() => ig.post(`${account.igUserId}/messenger_profile`, token, body));
        return this.getMessagingProfile(organisationId);
    },

    // ---------------- competitor lookup (business discovery) ----------------
    async discover(organisationId: string, username: string) {
        const { account, token } = await ctx(organisationId);
        const clean = username.replace(/^@/, '').trim().toLowerCase();
        if (!/^[a-z0-9._]{1,30}$/.test(clean)) throw new HttpError(400, 'Enter a valid Instagram username.');
        const r = await wrapCall(() => ig.get(account.igUserId, token, { fields: `business_discovery.username(${clean}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(12){id,caption,media_type,like_count,comments_count,permalink,timestamp,thumbnail_url,media_url}}` }));
        const b = r.business_discovery;
        if (!b) throw new HttpError(404, 'That account was not found, or it is not a business / creator account.');
        const posts = b.media?.data || [];
        const avg = posts.length ? Math.round(posts.reduce((s: number, p: any) => s + (p.like_count || 0) + (p.comments_count || 0), 0) / posts.length) : 0;
        return { ...b, media: posts, avgEngagementPerPost: avg, engagementRatePct: b.followers_count ? Number(((avg / b.followers_count) * 100).toFixed(2)) : null };
    },

    // ---------------- publishing + scheduling ----------------
    async listPosts(organisationId: string) {
        return prisma.instagramScheduledPost.findMany({ where: { organisationId }, orderBy: { scheduledFor: 'desc' }, take: 60 });
    },
    async schedulePost(organisationId: string, userId: string, input: { mediaType: 'IMAGE' | 'REELS' | 'STORIES'; mediaUrl: string; caption?: string; scheduledFor?: Date }) {
        const { account } = await ctx(organisationId);
        if (!/^https:\/\//i.test(input.mediaUrl)) throw new HttpError(400, 'The media must be a public https:// URL that Instagram can download.');
        if (!['IMAGE', 'REELS', 'STORIES'].includes(input.mediaType)) throw new HttpError(400, 'Choose Image, Reel or Story.');
        const when = input.scheduledFor && input.scheduledFor.getTime() > Date.now() ? input.scheduledFor : new Date();
        const post = await prisma.instagramScheduledPost.create({ data: { organisationId, accountId: account.id, mediaType: input.mediaType, mediaUrl: input.mediaUrl, caption: input.caption?.slice(0, 2200) || null, scheduledFor: when, createdById: userId } });
        if (when.getTime() <= Date.now() + 5000) void this.processDue().catch(e => console.error('[InstagramPublishing] immediate run failed:', e));
        return post;
    },
    async cancelPost(organisationId: string, id: string) {
        const r = await prisma.instagramScheduledPost.updateMany({ where: { id, organisationId, status: 'scheduled' }, data: { status: 'cancelled' } });
        if (!r.count) throw new HttpError(409, 'Only posts that have not started publishing can be cancelled.');
        return { ok: true };
    },

    /** Called every minute by the scheduler: start due posts, then finish ones whose media container is ready. */
    async processDue() {
        const due = await prisma.instagramScheduledPost.findMany({ where: { status: 'scheduled', scheduledFor: { lte: new Date() } }, take: 10, orderBy: { scheduledFor: 'asc' } });
        for (const post of due) {
            const claimed = await prisma.instagramScheduledPost.updateMany({ where: { id: post.id, status: 'scheduled' }, data: { status: 'publishing' } });
            if (!claimed.count) continue;
            try {
                const account = await prisma.instagramAccount.findUnique({ where: { id: post.accountId } });
                if (!account || account.isDeleted || account.status !== 'active') throw new Error('Instagram account is not connected');
                const token = InstagramAuthService.token(account);
                const body: any = { caption: post.caption || undefined };
                if (post.mediaType === 'IMAGE') body.image_url = post.mediaUrl;
                else if (post.mediaType === 'REELS') { body.media_type = 'REELS'; body.video_url = post.mediaUrl; body.share_to_feed = true; }
                else { body.media_type = 'STORIES'; if (/\.(mp4|mov)(\?|$)/i.test(post.mediaUrl)) body.video_url = post.mediaUrl; else body.image_url = post.mediaUrl; }
                const c = await ig.post<{ id: string }>(`${account.igUserId}/media`, token, body);
                await prisma.instagramScheduledPost.update({ where: { id: post.id }, data: { creationId: c.id } });
            } catch (e: any) {
                await prisma.instagramScheduledPost.update({ where: { id: post.id }, data: { status: 'failed', error: String(e?.message || e).slice(0, 400) } });
            }
        }

        const pending = await prisma.instagramScheduledPost.findMany({ where: { status: 'publishing', creationId: { not: null } }, take: 20 });
        for (const post of pending) {
            try {
                const account = await prisma.instagramAccount.findUnique({ where: { id: post.accountId } });
                if (!account) throw new Error('Instagram account missing');
                const token = InstagramAuthService.token(account);
                const st = await ig.get<{ status_code?: string; status?: string }>(post.creationId!, token, { fields: 'status_code,status' });
                if (st.status_code === 'FINISHED') {
                    const pub = await ig.post<{ id: string }>(`${account.igUserId}/media_publish`, token, { creation_id: post.creationId });
                    const info = await soft(() => ig.get<{ permalink?: string }>(pub.id, token, { fields: 'permalink' }));
                    await prisma.instagramScheduledPost.update({ where: { id: post.id }, data: { status: 'published', igMediaId: pub.id, permalink: info.ok ? info.data.permalink : null, publishedAt: new Date(), error: null } });
                } else if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
                    await prisma.instagramScheduledPost.update({ where: { id: post.id }, data: { status: 'failed', error: `Instagram could not process the media (${st.status || st.status_code}).` } });
                } else if (Date.now() - post.updatedAt.getTime() > 30 * 60_000) {
                    await prisma.instagramScheduledPost.update({ where: { id: post.id }, data: { status: 'failed', error: 'Timed out waiting for Instagram to process the media.' } });
                }
            } catch (e: any) {
                await prisma.instagramScheduledPost.update({ where: { id: post.id }, data: { status: 'failed', error: String(e?.message || e).slice(0, 400) } });
            }
        }
    },

    removeLocalFile(url: string) {
        const m = url.match(/\/uploads\/instagram-publishing\/([\w.-]+)$/);
        if (m) fs.promises.unlink(`${__dirname}/../../uploads/instagram-publishing/${m[1]}`).catch(() => undefined);
    }
};
