import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';

export const getAssignmentRules = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        let orgId: string | undefined;

        if (user.role === 'super_admin') {
            orgId = (req.query.organisationId as string) || undefined;
        } else {
            orgId = getOrgId(user) || undefined;
            if (!orgId) return res.status(403).json({ message: 'User not associated with an organisation' });
        }

        const where: any = { isDeleted: false };
        if (orgId) where.organisationId = orgId;

        // If a specific branchId filter is provided via query param, use it
        const filterBranchId = req.query.branchId as string | undefined;
        if (filterBranchId) {
            if (filterBranchId === 'global') {
                where.branchId = null;
            } else {
                where.branchId = filterBranchId;
            }
        } else if (user.role !== 'super_admin' && user.role !== 'admin') {
            // For non-admins: show rules for their managed branches + global rules
            const managedBranches = await prisma.branch.findMany({
                where: { managerId: user.id, isDeleted: false },
                select: { id: true }
            });
            const managedBranchIds = managedBranches.map(b => b.id);

            if (managedBranchIds.length > 0 || user.branchId) {
                const branchIds = [...new Set([...managedBranchIds, ...(user.branchId ? [user.branchId] : [])])];
                where.OR = [
                    { branchId: { in: branchIds } },
                    { branchId: null } // Global rules
                ];
            }
        }

        const rules = await prisma.assignmentRule.findMany({
            where,
            include: {
                targetManager: { select: { id: true, firstName: true, lastName: true } },
                createdBy: { select: { id: true, firstName: true, lastName: true } },
                branch: { select: { id: true, name: true } }
            },
            orderBy: { priority: 'asc' }
        });

        res.json({ assignmentRules: rules });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createAssignmentRule = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation' });

        const isAdmin = user.role === 'admin' || user.role === 'super_admin';
        let branchIdToSet = req.body.branchId;

        if (!isAdmin) {
            // Force branch managers to their own branch
            branchIdToSet = user.branchId;
        } else if (branchIdToSet === 'global' || branchIdToSet === null) {
            branchIdToSet = null;
        } else if (!branchIdToSet && user.branchId) {
            // Default to user's branch if they have one and didn't specify global
            branchIdToSet = user.branchId;
        }

        const ruleData: any = {
            name: req.body.name,
            description: req.body.description,
            isActive: req.body.isActive ?? true,
            priority: Number(req.body.priority) || 0,
            entity: req.body.entity || 'Lead',
            distributionType: req.body.distributionType || 'specific_user',
            distributionScope: req.body.distributionScope || 'organisation',
            targetRole: req.body.targetRole,
            targetManagerId: req.body.targetManagerId,
            ruleType: req.body.ruleType || 'round_robin',
            criteria: req.body.criteria || [],
            assignTo: req.body.assignTo,
            companySize: req.body.companySize,
            // Hard-forced off platform-wide - caused a notification-spam
            // incident (see leadRotationService.ts). Re-enable only once
            // that's actually fixed; don't trust req.body here even though
            // the UI checkbox is also disabled, since this is a direct API
            // write path.
            enableRotation: false,
            timeLimitMinutes: Number(req.body.timeLimitMinutes) || 0,
            rotationType: req.body.rotationType || 'random',
            rotationPool: req.body.rotationPool || [],
            organisation: { connect: { id: orgId } },
            createdBy: { connect: { id: user.id } }
        };

        if (branchIdToSet) {
            ruleData.branch = { connect: { id: branchIdToSet } };
        }

        const rule = await prisma.assignmentRule.create({
            data: ruleData
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: orgId,
                actorId: user.id,
                action: 'CREATE_ASSIGNMENT_RULE',
                entity: 'AssignmentRule',
                entityId: rule.id,
                details: { name: rule.name, entity: rule.entity }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(rule);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const updateAssignmentRule = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        // Verify existence and ownership
        const existing = await prisma.assignmentRule.findFirst({
            where: {
                id: req.params.id,
                isDeleted: false,
                ...(user.role !== 'super_admin' ? { organisationId: orgId as string } : {})
            }
        });

        if (!existing) return res.status(404).json({ message: 'Assignment rule not found' });

        const isAdmin = user.role === 'admin' || user.role === 'super_admin';
        const updateData = { ...req.body };

        // Hard-forced off platform-wide - see createAssignmentRule's comment.
        updateData.enableRotation = false;

        // Remove raw branchId to handle it via connect/disconnect
        delete updateData.branchId;

        if (req.body.branchId !== undefined) {
            let branchIdToSet = req.body.branchId;
            if (!isAdmin) {
                branchIdToSet = user.branchId;
            } else if (branchIdToSet === 'global' || branchIdToSet === null) {
                branchIdToSet = null;
            }

            if (branchIdToSet) {
                updateData.branch = { connect: { id: branchIdToSet } };
            } else {
                updateData.branch = { disconnect: true };
            }
        }

        const rule = await prisma.assignmentRule.update({
            where: { id: req.params.id },
            data: updateData
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: rule.organisationId || (orgId as string),
                actorId: user.id,
                action: 'UPDATE_ASSIGNMENT_RULE',
                entity: 'AssignmentRule',
                entityId: rule.id,
                details: { name: rule.name, updatedFields: Object.keys(req.body) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json(rule);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteAssignmentRule = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        // Verify existence and ownership
        const existing = await prisma.assignmentRule.findFirst({
            where: {
                id: req.params.id,
                isDeleted: false,
                ...(user.role !== 'super_admin' ? { organisationId: orgId as string } : {})
            }
        });

        if (!existing) return res.status(404).json({ message: 'Assignment rule not found' });

        const rule = await prisma.assignmentRule.update({
            where: { id: req.params.id },
            data: { isDeleted: true }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: rule.organisationId || (orgId as string),
                actorId: user.id,
                action: 'DELETE_ASSIGNMENT_RULE',
                entity: 'AssignmentRule',
                entityId: req.params.id,
                details: { name: rule.name }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({ message: 'Assignment rule deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get available rule types for UI
export const getRuleTypes = async (req: Request, res: Response) => {
    res.json({
        ruleTypes: [
            { id: 'round_robin', name: 'Round Robin', description: 'Distribute evenly across team members' },
            { id: 'specific_user', name: 'Specific User', description: 'Assign to a specific user' },
            { id: 'top_performer', name: 'Top Performer', description: 'Assign to best performing sales rep' },
            { id: 'least_loaded', name: 'Least Loaded', description: 'Assign to user with fewest active leads' },
            { id: 'territory_based', name: 'Territory Based', description: 'Assign based on geographic territory' },
            { id: 'skill_based', name: 'Skill Based', description: 'Match lead type to user expertise' }
        ],
        distributionTypes: [
            { id: 'specific_user', name: 'Specific User' },
            { id: 'round_robin_role', name: 'Round Robin by Role' },
            { id: 'round_robin_team', name: 'Round Robin within Team' },
            { id: 'manager_team', name: 'Manager\'s Team' }
        ],
        operators: [
            { id: 'equals', name: 'Equals' },
            { id: 'not_equals', name: 'Not Equals' },
            { id: 'contains', name: 'Contains' },
            { id: 'starts_with', name: 'Starts With' },
            { id: 'ends_with', name: 'Ends With' },
            { id: 'gt', name: 'Greater Than' },
            { id: 'gte', name: 'Greater Than or Equal' },
            { id: 'lt', name: 'Less Than' },
            { id: 'lte', name: 'Less Than or Equal' },
            { id: 'in', name: 'In List' },
            { id: 'not_in', name: 'Not In List' }
        ],
        fields: [
            { id: 'source', name: 'Source', type: 'string' },
            { id: 'address.country', name: 'Country', type: 'string' },
            { id: 'address.state', name: 'State', type: 'string' },
            { id: 'address.city', name: 'City', type: 'string' },
            { id: 'industry', name: 'Industry', type: 'string' },
            { id: 'leadScore', name: 'Lead Score', type: 'number' },
            { id: 'companySize', name: 'Company Size', type: 'number' },
            { id: 'dealValue', name: 'Deal Value', type: 'number' },
            { id: 'tags', name: 'Tags', type: 'array' },
            { id: 'lifecycleStage', name: 'Lifecycle Stage', type: 'string' }
        ]
    });
};
