import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { logAudit } from '../utils/auditLogger';
import { SalesTargetService } from '../services/salesTargetService';

// Helper: Get direct reports of a user
const getDirectReports = async (userId: string): Promise<any[]> => {
    return await prisma.user.findMany({
        where: { reportsToId: userId, isActive: true },
        select: { id: true, firstName: true, lastName: true }
    });
};

// Helper: split a total across n people so the shares always add back up to the total.
// Whole units are spread one at a time (10 across 3 -> 4,3,3) instead of dumping the remainder on the first person;
// any fractional part of a revenue amount goes to the first person.
const splitEvenly = (total: number, n: number): number[] => {
    const base = Math.floor(total / n);
    const rest = total - base * n;
    const whole = Math.floor(rest);
    const frac = rest - whole;
    return Array.from({ length: n }, (_, i) => base + (i < whole ? 1 : 0) + (i === 0 ? frac : 0));
};

const ADMIN_ROLES = ['super_admin', 'admin'];
const PERIODS = ['monthly', 'quarterly', 'yearly'];
const METRICS = ['revenue', 'units'];
const SCOPES = ['INDIVIDUAL', 'HIERARCHY'];

// Helper: Calculate period dates
const calculatePeriodDates = (period: string): { startDate: Date; endDate: Date } => {
    const now = new Date();
    let startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    let endDate = new Date();

    switch (period) {
        case 'monthly':
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            break;
        case 'quarterly': {
            const quarter = Math.floor(now.getMonth() / 3);
            startDate = new Date(now.getFullYear(), quarter * 3, 1);
            endDate = new Date(now.getFullYear(), quarter * 3 + 3, 0);
            break;
        }
        case 'yearly':
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(now.getFullYear(), 11, 31);
            break;
    }

    return { startDate, endDate };
};

// Assign target to a subordinate or team (with auto-distribution)
export const assignTarget = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { assignToUserId, teamId, targetValue, period, metric = 'revenue', productId, scope = 'HIERARCHY', opportunityType } = req.body; // Default to revenue & hierarchy (legacy support)
        const userOrgId = getOrgId(user);

        if ((!assignToUserId && !teamId) || !targetValue || !period) {
            return res.status(400).json({ message: 'Either assignToUserId or teamId, plus targetValue and period are required' });
        }

        if (!userOrgId) return res.status(400).json({ message: 'Organisation not found' });

        // Validate inputs: the UI checks these too, but the API must not trust it
        if (typeof targetValue !== 'number' || !Number.isFinite(targetValue) || targetValue <= 0) {
            return res.status(400).json({ message: 'Target value must be a number greater than 0' });
        }
        if (!PERIODS.includes(period)) return res.status(400).json({ message: 'Period must be monthly, quarterly or yearly' });
        if (!METRICS.includes(metric)) return res.status(400).json({ message: 'Metric must be revenue or units' });
        if (!SCOPES.includes(scope)) return res.status(400).json({ message: 'Scope must be INDIVIDUAL or HIERARCHY' });
        if (metric === 'units' && !Number.isInteger(targetValue)) {
            return res.status(400).json({ message: 'A units target must be a whole number' });
        }
        const isAdminUser = user.isSuperAdmin || ADMIN_ROLES.includes(user.role);

        // Validate Product if provided
        if (productId) {
            const product = await prisma.product.findFirst({ where: { id: productId, organisationId: userOrgId } });
            if (!product) return res.status(400).json({ message: 'Product not found' });
        }

        const { startDate, endDate } = calculatePeriodDates(period);

        let mainTarget;
        const childTargets = [];
        const skipped: string[] = []; // people who already had a matching target and so got no share

        // --- TEAM ASSIGNMENT ---
        if (teamId) {
            // Verify team existence
            const team = await prisma.team.findFirst({
                where: { id: teamId, organisationId: userOrgId },
                include: { members: true }
            });

            if (!team) return res.status(404).json({ message: 'Team not found' });
            if (!isAdminUser && team.managerId !== user.id) {
                return res.status(403).json({ message: 'Only an admin or the team manager can assign a team target' });
            }

            // Check for existing team target
            const existingTeamTarget = await prisma.salesTarget.findFirst({
                where: {
                    teamId,
                    period,
                    metric,
                    productId: productId || null,
                    startDate,
                    endDate,
                    isDeleted: false,
                    opportunityType: opportunityType || null
                }
            });

            if (existingTeamTarget) {
                return res.status(400).json({ message: `Team already has an active ${metric} target for this period` });
            }

            // Create valid team target (assignedToId is null)
            mainTarget = await prisma.salesTarget.create({
                data: {
                    targetValue,
                    period,
                    metric,
                    startDate,
                    endDate,
                    teamId,
                    assignedById: user.id,
                    organisationId: userOrgId,
                    autoDistributed: true,
                    productId: productId || null,
                    opportunityType: opportunityType || null
                }
            });

            // Distribute to team members
            if (team.members.length > 0) {
                const totalMembers = team.members.length;
                const shares = splitEvenly(targetValue, totalMembers);

                for (let i = 0; i < team.members.length; i++) {
                    const member = team.members[i];
                    const memberValue = shares[i];

                    // Check if member already has a target
                    const existingMemberTarget = await prisma.salesTarget.findFirst({
                        where: {
                            assignedToId: member.id,
                            period,
                            metric,
                            productId: productId || null,
                            startDate,
                            endDate,
                            isDeleted: false,
                            opportunityType: opportunityType || null,
                            scope: 'INDIVIDUAL'
                        }
                    });

                    if (!existingMemberTarget) {
                        const childTarget = await prisma.salesTarget.create({
                            data: {
                                targetValue: memberValue,
                                period,
                                metric,
                                startDate,
                                endDate,
                                assignedToId: member.id,
                                assignedById: user.id,
                                parentTargetId: mainTarget.id,
                                organisationId: userOrgId,
                                autoDistributed: true,
                                productId: productId || null,
                                opportunityType: opportunityType || null,
                                scope: 'INDIVIDUAL'
                            }
                        });
                        childTargets.push(childTarget);

                        // Notify member
                        await prisma.notification.create({
                            data: {
                                recipientId: member.id,
                                title: 'New Team Sales Target Assigned',
                                message: `Your team "${team.name}" has been assigned a ${metric} target${opportunityType ? ` (${opportunityType})` : ''}. Your individual share is ${memberValue.toLocaleString()}`,
                                type: 'info',
                                relatedResource: 'SalesTarget',
                                relatedId: childTarget.id
                            }
                        });
                    }
                }
            }

        }
        // --- INDIVIDUAL ASSIGNMENT ---
        else if (assignToUserId) {
            // Verify the assignee is a subordinate or user is admin
            const assignee = await prisma.user.findUnique({
                where: { id: assignToUserId }
            });

            if (!assignee) return res.status(404).json({ message: 'User not found' });
            if (assignee.organisationId !== userOrgId) return res.status(403).json({ message: 'Cannot assign target to crossover user' });
            if (assignee.id === user.id) return res.status(403).json({ message: 'You cannot assign a target to yourself' });
            if (!isAdminUser) {
                const downline = await getSubordinateIdsRecursive(user.id);
                if (!downline.includes(assignee.id)) {
                    return res.status(403).json({ message: 'You can only assign targets to people who report to you' });
                }
            }

            // Check existing
            const existingTarget = await prisma.salesTarget.findFirst({
                where: {
                    assignedToId: assignToUserId,
                    period,
                    metric,
                    productId: productId || null,
                    startDate,
                    endDate,
                    isDeleted: false,
                    opportunityType: opportunityType || null
                    // scope is deliberately not part of the match: a rollup and an individual target for the same
                    // person, period, product and type would count the same sales twice
                }
            });

            if (existingTarget) return res.status(400).json({ message: `User already has an active ${metric} target for this period` });

            // Determine if distribution is needed
            const directReports = await getDirectReports(assignToUserId);
            const shouldDistribute = scope === 'HIERARCHY' && directReports.length > 0;

            // Create main target
            mainTarget = await prisma.salesTarget.create({
                data: {
                    targetValue,
                    period,
                    metric,
                    startDate,
                    endDate,
                    assignedToId: assignToUserId,
                    assignedById: user.id,
                    organisationId: userOrgId,
                    autoDistributed: shouldDistribute, // True only if Hierarchy AND has reports
                    productId: productId || null,
                    scope: scope,
                    opportunityType: opportunityType || null
                }
            });

            if (shouldDistribute) {
                // Distribute strictly to Reports (no personal slice for manager)
                const totalMembers = directReports.length;
                const shares = splitEvenly(targetValue, totalMembers);

                for (let i = 0; i < directReports.length; i++) {
                    const report = directReports[i];
                    const reportValue = shares[i];

                    const existingSubTarget = await prisma.salesTarget.findFirst({
                        where: {
                            assignedToId: report.id,
                            period,
                            metric,
                            productId: productId || null,
                            startDate,
                            endDate,
                            isDeleted: false,
                            opportunityType: opportunityType || null,
                            scope: (await getDirectReports(report.id)).length > 0 ? 'HIERARCHY' : 'INDIVIDUAL'
                        }
                    });

                    if (existingSubTarget) {
                        skipped.push(`${report.firstName} ${report.lastName}`);
                    } else {
                        // Recursively create targets
                        // distributeToSubordinates will handle creating the report's target and ITS children
                        await distributeToSubordinates(
                            report.id,
                            reportValue,
                            period,
                            startDate,
                            endDate,
                            mainTarget.id,
                            user.id,
                            userOrgId,
                            metric,
                            productId,
                            opportunityType
                        );
                    }
                }
            }

            // Notification for Individual
            await prisma.notification.create({
                data: {
                    recipientId: assignToUserId,
                    title: 'New Sales Target Assigned',
                    message: `You have been assigned a ${period} sales target of ${targetValue.toLocaleString()}${opportunityType ? ` for ${opportunityType}` : ''}`,
                    type: 'info',
                    relatedResource: 'SalesTarget',
                    relatedId: mainTarget.id
                }
            });
        }

        await logAudit({
            organisationId: userOrgId,
            actorId: user.id,
            action: 'CREATE_SALES_TARGET',
            entity: 'SalesTarget',
            entityId: mainTarget!.id,
            details: { period, targetValue, teamId, assignToUserId, opportunityType }
        });

        res.status(201).json({
            message: 'Target assigned successfully',
            target: mainTarget,
            childTargets,
            skipped
        });
    } catch (error) {
        console.error('assignTarget Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// Recursive helper to distribute targets down the hierarchy
const distributeToSubordinates = async (
    userId: string,
    targetValue: number,
    period: string,
    startDate: Date,
    endDate: Date,
    parentTargetId: string,
    assignerId: string,
    organisationId: string,
    metric: string,
    productId?: string,
    opportunityType?: any
) => {
    // 1. Check if we should distribute further
    const directReports = await getDirectReports(userId);

    // 2. Create target for THIS user (userId) linked to parentTargetId
    // If they have reports, they get a CONTAINER target (auto=true) AND a SELF target
    // If they have no reports, they get a LEAF target (auto=false)

    const hasReports = directReports.length > 0;

    // Check existing (skip duplicate check for simplicity in helper, relying on caller logic usually, but here we must Create)
    // Actually this function was previously creating One child. Now we need to create the child for 'userId' first? 
    // Wait, the previous logic passed 'childTarget.id' as parentTargetId to the next level.
    // The previous logic created the child OUTSIDE, then called this to distribute FURTHER.
    // My new call signature in assignTarget simply calls this with mainTarget.id as parent.

    // Let's align:
    // This function receives `userId` (a subordinate). It should create a target for them under `parentTargetId`.
    // THEN, if they have reports, it should distribute further.

    const totalMembers = directReports.length + 1;
    // const distributedValueForThisUser = targetValue; // Removed unused variable
    // Wait, previous logic distributed the value BEFORE passing it.
    // Let's stick to: "Assign targetValue to userId, child of parentTargetId".

    const isContainer = hasReports;

    const myTarget = await prisma.salesTarget.create({
        data: {
            targetValue: targetValue,
            period,
            metric,
            startDate,
            endDate,
            assignedToId: userId,
            assignedById: assignerId,
            parentTargetId: parentTargetId,
            organisationId,
            autoDistributed: isContainer,
            productId: productId || null,
            scope: isContainer ? 'HIERARCHY' : 'INDIVIDUAL',
            opportunityType: opportunityType || null
        }
    });

    // Notify
    await prisma.notification.create({
        data: {
            recipientId: userId,
            title: 'New Sales Target Assigned',
            message: `You have been assigned a ${period} sales target of ${targetValue.toLocaleString()}`,
            type: 'info',
            relatedResource: 'SalesTarget',
            relatedId: myTarget.id
        }
    });

    if (hasReports) {
        // Distribute strictly to children
        const totalMembers = directReports.length;
        const shares = splitEvenly(targetValue, totalMembers);

        // Distribute to reports
        for (let i = 0; i < directReports.length; i++) {
            const report = directReports[i];
            const reportValue = shares[i];

            await distributeToSubordinates(
                report.id,
                reportValue,
                period,
                startDate,
                endDate,
                myTarget.id,
                assignerId,
                organisationId,
                metric,
                productId,
                opportunityType
            );
        }
    }
};

// Get current user's targets
export const getMyTargets = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;

        const targets = await prisma.salesTarget.findMany({
            where: {
                assignedToId: user.id,
                isDeleted: false
            },
            include: {
                assignedBy: { select: { firstName: true, lastName: true } },
                product: true
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json({ targets });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get team targets (hierarchical view)
export const getTeamTargets = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;

        // Get all subordinate IDs recursively
        const subordinateIds = await getSubordinateIdsRecursive(user.id);

        const targets = await prisma.salesTarget.findMany({
            where: {
                OR: [
                    { assignedToId: { in: [...subordinateIds, user.id] } },
                    { teamId: { not: null }, assignedById: user.id } // Include team targets created by user
                ],
                isDeleted: false
            },
            include: {
                assignedTo: { select: { firstName: true, lastName: true, email: true, position: true } },
                assignedBy: { select: { firstName: true, lastName: true } },
                team: { select: { name: true } },
                parentTarget: true,
                product: true
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json({ targets });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Helper: Get all subordinate IDs recursively
const getSubordinateIdsRecursive = async (userId: string): Promise<string[]> => {
    const subordinateIds: string[] = [];
    const queue: string[] = [userId];

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        const directReports = await prisma.user.findMany({
            where: { reportsToId: currentId, isActive: true },
            select: { id: true }
        });

        for (const report of directReports) {
            const reportId = report.id;
            if (!subordinateIds.includes(reportId)) {
                subordinateIds.push(reportId);
                queue.push(reportId);
            }
        }
    }

    return subordinateIds;
};

// Get daily achievement summary for notification
export const getDailyAchievement = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Get active targets for the user
        const activeTargets = await prisma.salesTarget.findMany({
            where: {
                assignedToId: user.id,
                status: 'active',
                isDeleted: false,
                startDate: { lte: new Date() },
                endDate: { gte: new Date() }
            }
        });

        if (activeTargets.length === 0) {
            return res.json({ hasTarget: false });
        }

        const target = activeTargets[0]; // Primary active target

        // Check if already notified today
        const alreadyNotified = target.lastNotifiedDate &&
            new Date(target.lastNotifiedDate).toDateString() === today.toDateString();

        // Calculate days remaining
        const daysRemaining = Math.ceil((new Date(target.endDate).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));

        // Calculate achievement percentage
        const achievementPercent = target.targetValue > 0
            ? Math.round((target.achievedValue / target.targetValue) * 100)
            : 0;

        res.json({
            hasTarget: true,
            showNotification: !alreadyNotified,
            target: {
                _id: target.id,
                targetValue: target.targetValue,
                achievedValue: target.achievedValue,
                achievementPercent,
                period: target.period,
                daysRemaining,
                amountRemaining: Math.max(0, target.targetValue - target.achievedValue)
            }
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Acknowledge daily notification
export const acknowledgeDailyNotification = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;

        // Find active activeTargets
        const activeTargets = await prisma.salesTarget.findMany({
            where: {
                assignedToId: user.id,
                status: 'active',
                isDeleted: false,
                startDate: { lte: new Date() },
                endDate: { gte: new Date() }
            }
        });

        if (activeTargets.length > 0) {
            await prisma.salesTarget.update({
                where: { id: activeTargets[0].id },
                data: { lastNotifiedDate: new Date() }
            });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Recalculate progress from closed_won opportunities
export const recalculateProgress = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) return res.status(400).json({ message: 'Organisation not found' });

        // Get all users in the organisation
        const users = await prisma.user.findMany({
            where: { organisationId: orgId, isActive: true },
            select: { id: true }
        });

        console.log(`[Recalculate] Triggered by ${user.id} for ${users.length} users.`);

        for (const u of users) {
            await SalesTargetService.updateProgressForUser(u.id);
        }

        res.json({ message: 'Progress recalculated successfully' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Update target
export const updateTarget = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { id } = req.params;
        const { targetValue, period, metric, productId, opportunityType } = req.body;

        if (!orgId) return res.status(400).json({ message: 'Organisation not found' });

        const target = await prisma.salesTarget.findFirst({
            where: { id, organisationId: orgId, isDeleted: false }
        });

        if (!target) return res.status(404).json({ message: 'Target not found' });

        // Update fields
        const updateData: any = {};
        if (targetValue) updateData.targetValue = targetValue;

        // If period changes, recalculate dates
        if (period) {
            const { startDate, endDate } = calculatePeriodDates(period);
            updateData.period = period;
            updateData.startDate = startDate;
            updateData.endDate = endDate;
        }

        if (metric) updateData.metric = metric;
        if (productId !== undefined) updateData.productId = productId || null;
        if (opportunityType !== undefined) updateData.opportunityType = opportunityType || null;

        const updatedTarget = await prisma.salesTarget.update({
            where: { id },
            data: updateData
        });

        await logAudit({
            organisationId: orgId,
            actorId: user.id,
            action: 'UPDATE_SALES_TARGET',
            entity: 'SalesTarget',
            entityId: id,
            details: { targetValue, period, metric, productId, opportunityType }
        });

        res.json({ message: 'Target updated successfully', target: updatedTarget });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Delete target
export const deleteTarget = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Organisation not found' });
        }

        const target = await prisma.salesTarget.update({
            where: {
                id: req.params.id,
                ...(orgId ? { organisationId: orgId } : {})
            },
            data: { isDeleted: true }
        });

        await logAudit({
            organisationId: orgId || target.organisationId,
            actorId: user.id,
            action: 'DELETE_SALES_TARGET',
            entity: 'SalesTarget',
            entityId: req.params.id
        });

        // Also delete child targets
        await prisma.salesTarget.updateMany({
            where: {
                parentTargetId: req.params.id,
                ...(orgId ? { organisationId: orgId } : {})
            },
            data: { isDeleted: true }
        });

        res.json({ message: 'Target deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get subordinates for assignment dropdown
export const getSubordinates = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const isAdminUser = user.isSuperAdmin || user.role === 'super_admin' || user.role === 'admin';

        let subordinates;
        if (isAdminUser) {
            // Admins can assign targets to anyone in the organisation, not just their direct reports.
            subordinates = await prisma.user.findMany({
                where: { organisationId: orgId, isActive: true, id: { not: user.id } },
                select: { id: true, firstName: true, lastName: true }
            });
        } else {
            // Everyone else gets their full reporting downline (recursive), not just direct reports.
            const subordinateIds = await getSubordinateIdsRecursive(user.id);
            subordinates = await prisma.user.findMany({
                where: { id: { in: subordinateIds }, isActive: true },
                select: { id: true, firstName: true, lastName: true }
            });
        }

        res.json({ subordinates });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
