import { Request, Response } from 'express';
import { getOrgId } from '../utils/hierarchyUtils';
import {
    getPublicBonvoiceConfig,
    listBonvoiceAgentMappings,
    removeBonvoiceConfig,
    saveBonvoiceAgentMapping,
    saveBonvoiceConfig,
} from '../services/bonvoiceService';

const orgIdFor = (req: Request) => {
    const orgId = getOrgId((req as any).user);
    if (!orgId) throw new Error('No organisation found');
    return orgId;
};

export const getConfig = async (req: Request, res: Response) => {
    try { res.json(await getPublicBonvoiceConfig(orgIdFor(req))); }
    catch (error) { res.status(400).json({ message: (error as Error).message }); }
};

export const updateConfig = async (req: Request, res: Response) => {
    try { res.json(await saveBonvoiceConfig(orgIdFor(req), req.body)); }
    catch (error) { res.status(400).json({ message: (error as Error).message }); }
};

export const disconnect = async (req: Request, res: Response) => {
    try { await removeBonvoiceConfig(orgIdFor(req)); res.json({ message: 'Bonvoice disconnected' }); }
    catch (error) { res.status(400).json({ message: (error as Error).message }); }
};

export const getAgentMappings = async (req: Request, res: Response) => {
    try { res.json(await listBonvoiceAgentMappings(orgIdFor(req))); }
    catch (error) { res.status(400).json({ message: (error as Error).message }); }
};

export const updateAgentMapping = async (req: Request, res: Response) => {
    try { res.json(await saveBonvoiceAgentMapping(orgIdFor(req), req.params.userId, req.body)); }
    catch (error) { res.status(400).json({ message: (error as Error).message }); }
};

export const testConnection = async (_req: Request, res: Response) => {
    res.status(409).json({ message: 'Bonvoice credentials can be saved, but connection testing requires the official API endpoint contract from Bonvoice.' });
};
