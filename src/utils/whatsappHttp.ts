import { Request, Response, NextFunction } from 'express';
import { getOrgId } from './hierarchyUtils';
import { isOrgAdmin } from './roleUtils';
import { WhatsAppSendError } from '../services/whatsAppSender';

export type Handler = (req: Request, res: Response) => Promise<any>;

export const orgOf = (req: Request): string => {
    const id = getOrgId((req as any).user);
    if (!id) throw new HttpError(400, 'No organisation found');
    return id;
};

export class HttpError extends Error {
    constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** Wrap an async handler: map known errors to HTTP statuses, never leak stack traces. */
export const handle = (fn: Handler) => async (req: Request, res: Response) => {
    try {
        await fn(req, res);
    } catch (err: any) {
        if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, code: err.code });
        if (err instanceof WhatsAppSendError) {
            const status = err.code === 'WINDOW_CLOSED' ? 409 : err.code === 'NOT_CONNECTED' ? 412 : err.code === 'API_ERROR' ? 502 : 400;
            return res.status(status).json({ message: err.message, code: err.code });
        }
        console.error('[WhatsApp API]', req.method, req.path, err);
        res.status(500).json({ message: err.message || 'Something went wrong' });
    }
};

/** Settings-type actions (templates, automations, AI, accounts) are for organisation admins. */
export const requireOrgAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (isOrgAdmin((req as any).user)) return next();
    res.status(403).json({ message: 'Only organisation admins can change WhatsApp settings.' });
};

export const str = (v: any, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
