import { Request } from 'express';
import { HttpError, handle, orgOf, str } from '../utils/whatsappHttp';
import { InstagramToolsService as S } from '../services/instagramToolsService';

const uid = (req: Request) => (req as any).user.id as string;

export const status = handle(async (req, res) => { res.json(await S.status(orgOf(req))); });
export const insights = handle(async (req, res) => { res.json(await S.insights(orgOf(req), Number(req.query.days) || 30)); });
export const topMedia = handle(async (req, res) => { res.json(await S.topMedia(orgOf(req), Number(req.query.limit) || 12)); });

export const recentMedia = handle(async (req, res) => { res.json(await S.recentMedia(orgOf(req))); });
export const comments = handle(async (req, res) => { res.json(await S.comments(orgOf(req), req.params.mediaId)); });
export const replyComment = handle(async (req, res) => {
    const m = str(req.body?.message, 2200); if (!m) throw new HttpError(400, 'Write a reply first.');
    res.json(await S.replyToComment(orgOf(req), req.params.id, m));
});
export const hideComment = handle(async (req, res) => { res.json(await S.hideComment(orgOf(req), req.params.id, req.body?.hide !== false)); });
export const deleteComment = handle(async (req, res) => { res.json(await S.deleteComment(orgOf(req), req.params.id)); });
export const toggleComments = handle(async (req, res) => { res.json(await S.setCommentsEnabled(orgOf(req), req.params.mediaId, !!req.body?.enabled)); });

export const getMessagingProfile = handle(async (req, res) => { res.json(await S.getMessagingProfile(orgOf(req))); });
export const saveMessagingProfile = handle(async (req, res) => {
    const b = req.body || {};
    const menu = Array.isArray(b.persistentMenu) ? b.persistentMenu.map((i: any) => ({ type: i?.type === 'web_url' ? 'web_url' as const : 'postback' as const, title: str(i?.title, 30), url: str(i?.url, 300) })) : undefined;
    if (menu?.some((i: any) => i.type === 'web_url' && !/^https:\/\//i.test(i.url || ''))) throw new HttpError(400, 'Menu links must start with https://');
    res.json(await S.saveMessagingProfile(orgOf(req), { iceBreakers: Array.isArray(b.iceBreakers) ? b.iceBreakers.map((x: any) => str(x, 80)) : undefined, persistentMenu: menu }));
});

export const discover = handle(async (req, res) => { res.json(await S.discover(orgOf(req), str(req.query.username as string, 40))); });

export const listPosts = handle(async (req, res) => { res.json(await S.listPosts(orgOf(req))); });
export const createPost = handle(async (req, res) => {
    const b = req.body || {};
    const when = b.scheduledFor ? new Date(b.scheduledFor) : undefined;
    if (when && isNaN(when.getTime())) throw new HttpError(400, 'Invalid schedule time.');
    res.status(201).json(await S.schedulePost(orgOf(req), uid(req), { mediaType: b.mediaType, mediaUrl: str(b.mediaUrl, 1000), caption: str(b.caption, 2200), scheduledFor: when }));
});
export const cancelPost = handle(async (req, res) => { res.json(await S.cancelPost(orgOf(req), req.params.id)); });
export const uploadMedia = handle(async (req, res) => {
    const f = (req as any).file as { filename: string } | undefined;
    if (!f) throw new HttpError(400, 'Choose an image or video file.');
    const base = (process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.json({ url: `${base}/uploads/instagram-publishing/${f.filename}` });
});
