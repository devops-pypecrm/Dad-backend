import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';

// GET /api/branches
export const getBranches = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) {
            if (user?.isSuperAdmin || user?.role === 'super_admin') {
                return res.json([]);
            }
            return res.status(403).json({ message: 'User has no organisation' });
        }

        const where: any = {
            organisationId: orgId,
            isDeleted: false
        };

        if (user.role !== 'super_admin' && user.role !== 'admin') {
            where.managerId = user.id;
        }

        const branches = await prisma.branch.findMany({
            where,
            include: {
                manager: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true
                    }
                },
                _count: {
                    select: { users: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(branches);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/branches
export const createBranch = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { name, location, contactEmail, contactPhone, managerId } = req.body;

        if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
        // Only admins can create branches
        if (user.role !== 'admin' && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only admins can create branches' });
        }

        const branch = await prisma.branch.create({
            data: {
                name,
                location,
                contactEmail,
                contactPhone,
                managerId,
                organisationId: orgId
            }
        });

        res.status(201).json(branch);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

// PUT /api/branches/:id
export const updateBranch = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { id } = req.params;
        const { name, location, contactEmail, contactPhone, managerId } = req.body;

        // Check if user has access to this branch
        const branch = await prisma.branch.findUnique({ where: { id } });
        if (!branch) return res.status(404).json({ message: 'Branch not found' });

        // Only admins can update branches
        if (user.role !== 'admin' && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only admins can update branches' });
        }

        // Ensure branch belongs to user's org
        const orgId = getOrgId(user);
        if (branch.organisationId !== orgId && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const updatedBranch = await prisma.branch.update({
            where: { id },
            data: {
                name,
                location,
                contactEmail,
                contactPhone,
                managerId
            }
        });

        res.json(updatedBranch);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

// DELETE /api/branches/:id
export const deleteBranch = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { id } = req.params;

        const branch = await prisma.branch.findUnique({ where: { id } });
        if (!branch) return res.status(404).json({ message: 'Branch not found' });

        if (user.role !== 'admin' && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only admins can delete branches' });
        }

        const orgId = getOrgId(user);
        if (branch.organisationId !== orgId && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        await prisma.branch.update({
            where: { id },
            data: { isDeleted: true, deletedAt: new Date() }
        });

        res.json({ message: 'Branch deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// PUT /api/branches/managed-by/:userId  { branchIds: string[] }
// Makes the user manager of exactly the given branches (a user can manage several), and
// stops managing any branch of theirs that is not in the list. A branch has one manager,
// so a selected branch that someone else managed is taken over by this user.
export const setManagedBranches = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (user.role !== 'admin' && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only admins can assign branch managers' });
        }
        const orgId = getOrgId(user);
        if (!orgId) return res.status(403).json({ message: 'User has no organisation' });

        const { userId } = req.params;
        const branchIds: string[] = Array.isArray(req.body.branchIds) ? req.body.branchIds.map(String) : [];

        const target = await prisma.user.findFirst({ where: { id: userId, organisationId: orgId }, select: { id: true } });
        if (!target) return res.status(404).json({ message: 'User not found' });

        const valid = await prisma.branch.findMany({
            where: { id: { in: branchIds }, organisationId: orgId, isDeleted: false },
            select: { id: true, managerId: true }
        });
        const validIds = valid.map(b => b.id);
        const takenOver = valid.filter(b => b.managerId && b.managerId !== userId).length;

        await prisma.$transaction([
            prisma.branch.updateMany({
                where: { organisationId: orgId, managerId: userId, isDeleted: false, id: { notIn: validIds } },
                data: { managerId: null }
            }),
            prisma.branch.updateMany({
                where: { id: { in: validIds } },
                data: { managerId: userId }
            })
        ]);

        res.json({ userId, branchIds: validIds, takenOver });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};
