import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { normalizeRole, isSuperAdmin as checkSuperAdmin, isOrgAdmin as checkIsOrgAdmin, isManager as checkIsManager } from '../utils/roleUtils';

export const getAuditLogs = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { entity, action, userId, startDate, endDate, page = 1, limit = 20, branchId } = req.query;

        const userIsSuperAdmin = checkSuperAdmin(user);
        const isOrgAdmin = checkIsOrgAdmin(user);
        const isManager = checkIsManager(user);

        if (!userIsSuperAdmin && !isOrgAdmin && !isManager) {
            return res.status(403).json({ message: 'Access denied: Audit logs are only available to admins and managers.' });
        }

        const where: any = {};

        // 1. ORGANISATION ISOLATION
        if (!userIsSuperAdmin) {
            if (!user.organisationId) {
                return res.status(400).json({ message: 'Organisation not found' });
            }
            where.organisationId = user.organisationId;
        } else {
            // Super Admin can view specific org if requested, otherwise defaults to all or their own
            const targetOrgId = req.query.organisationId || user.organisationId;
            if (targetOrgId) {
                where.organisationId = String(targetOrgId);
            }
        }

        // 2. HIERARCHY FILTERING - Users should not see activities from people above them
        if (!userIsSuperAdmin) {
            const { getVisibleUserIds } = await import('../utils/hierarchyUtils');
            const visibleUserIds = await getVisibleUserIds(user.id);

            // Limit actor to self or subordinates (not superiors)
            where.actorId = { in: visibleUserIds };
        }

        // 3. BRANCH ISOLATION (Optional but enforced for non-admins)
        if (user.branchId && !isOrgAdmin && !userIsSuperAdmin) {
            // Ensure they only see activities from their own branch
            where.actor = {
                ...where.actor,
                branchId: user.branchId
            };
        } else if (req.query.branchId && (isOrgAdmin || userIsSuperAdmin)) {
            // Admins can explicitly filter by branch
            where.actor = {
                ...where.actor,
                branchId: String(req.query.branchId)
            };
        }

        // 4. EXPLICIT FILTERS
        if (entity) where.entity = String(entity);
        if (action) {
            const actionStr = String(action).toUpperCase();
            if (actionStr === 'CREATED' || actionStr === 'CREATE') {
                where.action = { startsWith: 'CREATE' };
            } else if (actionStr === 'UPDATED' || actionStr === 'UPDATE') {
                where.action = { startsWith: 'UPDATE' };
            } else if (actionStr === 'DELETED' || actionStr === 'DELETE') {
                where.action = { startsWith: 'DELETE' };
            } else if (actionStr === 'LOGGED IN' || actionStr === 'LOGIN') {
                where.action = 'LOGIN';
            } else if (actionStr === 'LOGGED OUT' || actionStr === 'LOGOUT') {
                where.action = 'LOGOUT';
            } else {
                where.action = String(action);
            }
        }
        if (userId) {
            const targetUserId = String(userId);
            // Security Check: If requesting a specific user, ensure they are in the allowed hierarchy
            if (where.actorId && where.actorId.in && !where.actorId.in.includes(targetUserId)) {
                return res.status(403).json({ message: 'Not authorized to view logs for this user' });
            }
            where.actorId = targetUserId;
        }
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(String(startDate));
            if (endDate) where.createdAt.lte = new Date(String(endDate));
        }

        const skip = (Number(page) - 1) * Number(limit);

        const logs = await prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: Number(limit),
            skip,
            include: {
                actor: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        role: true,
                        branch: { select: { name: true } }
                    }
                }
            }
        });

        const total = await prisma.auditLog.count({ where });

        // Summary counts for the same filtered `where` (ignoring pagination) -
        // powers the stat tiles row. Cheap: each is an indexed count, not a
        // full scan (organisationId/action/createdAt are all indexed).
        const [creates, updates, deletes, logins] = await Promise.all([
            prisma.auditLog.count({ where: { ...where, action: { startsWith: 'CREATE' } } }),
            prisma.auditLog.count({ where: { ...where, action: { startsWith: 'UPDATE' } } }),
            prisma.auditLog.count({ where: { ...where, action: { startsWith: 'DELETE' } } }),
            prisma.auditLog.count({ where: { ...where, action: 'LOGIN' } }),
        ]);

        res.json({
            summary: { total, creates, updates, deletes, logins },
            logs,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit))
            }
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
