import { Request, Response } from 'express';
import { HttpError, handle, orgOf, str } from '../utils/whatsappHttp';
import { WhatsAppToolsService as S } from '../services/whatsAppToolsService';

const acct = (req: Request) => str(req.query.accountId as string, 60) || str(req.body?.accountId, 60) || undefined;
const days = (req: Request, d = 30) => Number(req.query.days) || d;

export const accounts = handle(async (req, res) => { res.json(await S.accounts(orgOf(req))); });
export const analytics = handle(async (req, res) => { res.json(await S.analytics(orgOf(req), acct(req), days(req))); });
export const numberStatus = handle(async (req, res) => { res.json(await S.numberStatus(orgOf(req), acct(req))); });

export const getProfile = handle(async (req, res) => { res.json(await S.getProfile(orgOf(req), acct(req))); });
export const updateProfile = handle(async (req, res) => {
    const b = req.body || {};
    const websites = Array.isArray(b.websites) ? b.websites.map((w: any) => str(w, 200)).filter(Boolean) : undefined;
    if (websites?.some((w: string) => !/^https?:\/\//i.test(w))) throw new HttpError(400, 'Websites must start with http:// or https://');
    res.json(await S.updateProfile(orgOf(req), acct(req), { about: b.about !== undefined ? str(b.about, 139) : undefined, address: b.address !== undefined ? str(b.address, 256) : undefined, description: b.description !== undefined ? str(b.description, 512) : undefined, email: b.email !== undefined ? str(b.email, 128) : undefined, vertical: b.vertical !== undefined ? str(b.vertical, 40) : undefined, websites }));
});

export const listQr = handle(async (req, res) => { res.json(await S.listQr(orgOf(req), acct(req))); });
export const createQr = handle(async (req, res) => {
    const m = str(req.body?.message, 140); if (!m) throw new HttpError(400, 'Enter the pre-filled message (max 140 characters).');
    res.json(await S.createQr(orgOf(req), acct(req), m));
});
export const updateQr = handle(async (req, res) => {
    const m = str(req.body?.message, 140); if (!m) throw new HttpError(400, 'Enter the pre-filled message.');
    res.json(await S.updateQr(orgOf(req), acct(req), req.params.code, m));
});
export const deleteQr = handle(async (req, res) => { res.json(await S.deleteQr(orgOf(req), acct(req), req.params.code)); });

export const getStarters = handle(async (req, res) => { res.json(await S.getStarters(orgOf(req), acct(req))); });
export const saveStarters = handle(async (req, res) => {
    const b = req.body || {};
    res.json(await S.saveStarters(orgOf(req), acct(req), {
        enableWelcomeMessage: typeof b.enableWelcomeMessage === 'boolean' ? b.enableWelcomeMessage : undefined,
        prompts: Array.isArray(b.prompts) ? b.prompts.map((p: any) => str(p, 80)) : undefined,
        commands: Array.isArray(b.commands) ? b.commands.map((c: any) => ({ command_name: str(c?.command_name, 32), command_description: str(c?.command_description, 256) })) : undefined
    }));
});

export const listBlocked = handle(async (req, res) => { res.json(await S.listBlocked(orgOf(req), acct(req))); });
export const blockUser = handle(async (req, res) => { res.json(await S.setBlocked(orgOf(req), acct(req), str(req.body?.phone, 30), true)); });
export const unblockUser = handle(async (req, res) => { res.json(await S.setBlocked(orgOf(req), acct(req), str(req.body?.phone, 30), false)); });

export const referrals = handle(async (req, res) => { res.json(await S.referralSummary(orgOf(req), days(req, 30))); });
