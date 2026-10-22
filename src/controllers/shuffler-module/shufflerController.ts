import { forceShuffleOrg, getShuffleCountOrg } from "../../services/shuffler-module/shufflerService";
import { getOrgId } from "../../utils/hierarchyUtils";
import { Request, Response } from "express";

import prisma from "../../config/prisma";

export const triggerShuffleNow = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(404).json({ message: 'Organisation not found' });

        // Kick off the shuffle in the background without awaiting it. Pass
        // the triggering admin through so the resulting LeadHistory rows
        // record who actually fired this (previously `changedById: null`
        // even though a real person clicked the button).
        forceShuffleOrg(orgId, (req as any).user?.id).catch(err => {
            console.error('Background shuffle error:', err);
        });

        res.json({ message: "Shuffle started in background", status: "IN_PROGRESS" });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getShuffleStatus = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(404).json({ message: 'Organisation not found' });

        const org = await prisma.organisation.findUnique({
            where: { id: orgId },
            select: { shufflerConfig: true }
        });

        if (!org) return res.status(404).json({ message: 'Organisation not found' });

        const config = org.shufflerConfig as any || {};
        const activeJob = config.activeJob || null;

        res.json({ activeJob });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getShuffleCount = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(404).json({ message: 'Organisation not found' });

        const customConfig = req.body?.shufflerConfig;
        const result = await getShuffleCountOrg(orgId, customConfig);
        if (result.success) {
            res.json({ count: result.count, countsByStatus: result.countsByStatus, message: result.message });
        } else {
            res.status(400).json({ message: result.message });
        }
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};