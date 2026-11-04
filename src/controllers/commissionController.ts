
import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { normalizeRole } from '../utils/roleUtils';
import { calculateHistoricalIncentives, DEFAULT_INCENTIVE_CONFIG, normalizeIncentiveConfig } from '../services/incentiveService';
import { Prisma } from '../generated/client';

const USER_SELECT = { id: true, firstName: true, lastName: true, email: true, profileImage: true };

const isAdminRequester = (user: any) => user?.isSuperAdmin || normalizeRole(user?.role) === 'admin';

export const getIncentiveConfig = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'No org' });
        const organisation = await prisma.organisation.findUnique({ where: { id: orgId }, select: { incentiveConfig: true } });
        res.json(organisation?.incentiveConfig ? normalizeIncentiveConfig(organisation.incentiveConfig) : DEFAULT_INCENTIVE_CONFIG);
    } catch (error) { res.status(500).json({ message: (error as Error).message }); }
};

export const updateIncentiveConfig = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'No org' });
        const config = normalizeIncentiveConfig(req.body);
        if (config.value <= 0) return res.status(400).json({ message: 'Incentive value must be greater than zero' });
        if (config.calculationType === 'percentage' && config.value > 100) return res.status(400).json({ message: 'Percentage cannot exceed 100' });
        await prisma.organisation.update({ where: { id: orgId }, data: { incentiveConfig: config as any } });
        res.json(config);
    } catch (error) { res.status(400).json({ message: (error as Error).message }); }
};

export const deleteIncentiveConfig = async (req: Request, res: Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'No org' });
        await prisma.organisation.update({ where: { id: orgId }, data: { incentiveConfig: Prisma.DbNull } });
        res.json({ message: 'Incentive rule deleted', config: DEFAULT_INCENTIVE_CONFIG });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const recalculateIncentives = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });
        const result = await calculateHistoricalIncentives(orgId, user.id);
        res.json(result);
    } catch (error) { res.status(500).json({ message: (error as Error).message }); }
};

export const getCommissions = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const where: any = { organisationId: orgId, isDeleted: false };
        // Non-admins only ever see their own commissions/incentives — this list
        // previously returned every commission in the org to anyone who could log in.
        if (!isAdminRequester(user)) {
            where.userId = user.id;
        }

        const commissions = await prisma.commission.findMany({
            where,
            include: { user: { select: USER_SELECT } },
            orderBy: { createdAt: 'desc' }
        });
        res.json(commissions);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createCommission = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const amount = Number(req.body.amount);
        if (!amount || amount <= 0) {
            return res.status(400).json({ message: 'Amount must be a positive number' });
        }
        if (!req.body.type) {
            return res.status(400).json({ message: 'Type is required' });
        }

        let targetUserId = req.body.userId;
        if (!targetUserId || targetUserId === 'self') {
            targetUserId = user.id;
        }

        // The target user must belong to the same organisation as the admin
        // creating this — without this check, a caller could point a commission
        // at any user ID on the platform, not just someone on their own team.
        const targetUser = await prisma.user.findFirst({
            where: { id: targetUserId, organisationId: orgId }
        });
        if (!targetUser) {
            return res.status(400).json({ message: 'Selected user was not found in your organisation' });
        }

        const commission = await prisma.commission.create({
            data: {
                userId: targetUserId,
                amount,
                currency: req.body.currency || 'INR',
                status: req.body.status || 'pending',
                type: req.body.type,
                description: req.body.description,
                dealId: req.body.dealId || undefined,
                source: 'manual',
                date: req.body.date ? new Date(req.body.date) : new Date(),
                organisationId: orgId,
                createdById: user.id
            },
            include: { user: { select: USER_SELECT } }
        });
        res.status(201).json(commission);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const updateCommission = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const existing = await prisma.commission.findFirst({
            where: { id: req.params.id, organisationId: orgId, isDeleted: false }
        });
        if (!existing) return res.status(404).json({ message: 'Commission not found' });

        // Whitelist editable fields — blindly spreading req.body would let a
        // caller overwrite organisationId/createdById/id on someone else's record.
        const data: any = {};
        if (req.body.amount !== undefined) {
            const amount = Number(req.body.amount);
            if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be a positive number' });
            data.amount = amount;
        }
        if (req.body.type !== undefined) data.type = req.body.type;
        if (req.body.status !== undefined) data.status = req.body.status;
        if (req.body.description !== undefined) data.description = req.body.description;
        if (req.body.date !== undefined) data.date = new Date(req.body.date);
        if (req.body.dealId !== undefined) data.dealId = req.body.dealId;

        if (req.body.userId !== undefined && req.body.userId !== existing.userId) {
            const targetUserId = req.body.userId === 'self' ? user.id : req.body.userId;
            const targetUser = await prisma.user.findFirst({
                where: { id: targetUserId, organisationId: orgId }
            });
            if (!targetUser) {
                return res.status(400).json({ message: 'Selected user was not found in your organisation' });
            }
            data.userId = targetUserId;
        }

        const commission = await prisma.commission.update({
            where: { id: req.params.id },
            data,
            include: { user: { select: USER_SELECT } }
        });
        res.json(commission);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteCommission = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const existing = await prisma.commission.findFirst({
            where: { id: req.params.id, organisationId: orgId, isDeleted: false }
        });
        if (!existing) return res.status(404).json({ message: 'Commission not found' });

        await prisma.commission.update({
            where: { id: req.params.id },
            data: { isDeleted: true }
        });
        res.json({ message: 'Commission deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
