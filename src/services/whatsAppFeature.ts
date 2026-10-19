import { NextFunction, Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';

/**
 * Features are switched on per organisation by the platform Super Admin
 * (Super Admin > Feature Settings). The WhatsApp hub is the feature key 'whatsapp'.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { features: string[]; at: number }>();

export async function getEnabledFeatures(organisationId: string | null | undefined): Promise<string[]> {
    if (!organisationId) return [];
    const hit = cache.get(organisationId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.features;
    const org = await prisma.organisation.findUnique({ where: { id: organisationId }, select: { enabledFeatures: true, isDeleted: true } });
    const features = org && !org.isDeleted ? org.enabledFeatures : [];
    cache.set(organisationId, { features, at: Date.now() });
    return features;
}

export const hasFeature = async (organisationId: string | null | undefined, key: string) => (await getEnabledFeatures(organisationId)).includes(key);
export const isInstagramEnabled = (organisationId: string | null | undefined) => hasFeature(organisationId, 'instagram');
export const isWhatsAppEnabled = (organisationId: string | null | undefined) => hasFeature(organisationId, 'whatsapp');

/** Call after the Super Admin changes features so it applies immediately on this instance. */
export function invalidateFeatures(organisationId: string) {
    cache.delete(organisationId);
}

export const WHATSAPP_NOT_ENABLED_MESSAGE = 'WhatsApp is not enabled for your organisation. Contact Pype CRM support to get it switched on.';

/** Express guard for every authenticated WhatsApp route. */
export const requireWhatsAppFeature = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (await isWhatsAppEnabled(getOrgId((req as any).user))) return next();
        res.status(403).json({ message: WHATSAPP_NOT_ENABLED_MESSAGE, code: 'WHATSAPP_NOT_ENABLED' });
    } catch (err) {
        next(err);
    }
};

export const INSTAGRAM_NOT_ENABLED_MESSAGE = 'Instagram is not enabled for your organisation. Contact Pype CRM support to get it switched on.';

/** Express guard for every authenticated Instagram route. */
export const requireInstagramFeature = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (await isInstagramEnabled(getOrgId((req as any).user))) return next();
        res.status(403).json({ message: INSTAGRAM_NOT_ENABLED_MESSAGE, code: 'INSTAGRAM_NOT_ENABLED' });
    } catch (err) {
        next(err);
    }
};
