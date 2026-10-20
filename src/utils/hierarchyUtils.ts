import prisma from '../config/prisma';
import { isManager } from './roleUtils';

/**
 * Recursively fetches all subordinate user IDs for a given user.
 * @param userId The ID of the manager/user.
 * @returns Array of user IDs including the manager themselves.
 */
export const getSubordinateIds = async (userId: string): Promise<string[]> => {
    // 1. Start with the user themselves
    const subordinateIds: string[] = [userId.toString()];

    // 2. Queue for BFS/DFS traversing
    const queue: string[] = [userId.toString()];

    while (queue.length > 0) {
        const currentManagerId = queue.shift();

        // Find direct reports using Prisma
        const directReports = await prisma.user.findMany({
            where: { reportsToId: currentManagerId },
            select: { id: true }
        });

        for (const report of directReports) {
            const reportId = report.id;
            // Avoid infinite loops if circular dependency exists
            if (!subordinateIds.includes(reportId)) {
                subordinateIds.push(reportId);
                queue.push(reportId);
            }
        }
    }

    return subordinateIds;
};

/**
 * Checks whether setting `userId`'s manager to `newManagerId` would create a circular
 * reporting chain (e.g. A -> B -> A, or any longer loop) — not just the trivial
 * "reports to themselves" case. Walks upward from the proposed new manager through
 * reportsToId; if that walk ever reaches `userId`, connecting them would close a loop.
 *
 * This matters beyond just data hygiene: a cycle leaves every member in it with no
 * "top" — buildHierarchyTree on the frontend (settings/team) only roots a member when
 * they have no manager or their manager isn't in the loaded list, so a cyclic pair
 * never qualifies as a root and silently vanishes from the org chart instead of
 * erroring, which is what was reported as "hierarchy shows blank for some users."
 */
export const wouldCreateReportingCycle = async (userId: string, newManagerId: string): Promise<boolean> => {
    if (userId === newManagerId) return true;

    const visited = new Set<string>();
    let currentId: string | null = newManagerId;

    while (currentId) {
        if (currentId === userId) return true;
        if (visited.has(currentId)) return false; // pre-existing loop upstream, not one we're creating
        visited.add(currentId);

        const current: { reportsToId: string | null } | null = await prisma.user.findUnique({
            where: { id: currentId },
            select: { reportsToId: true }
        });
        currentId = current?.reportsToId ?? null;
    }

    return false;
};

/**
 * Safely extracts the Organisation ID as a string from a user object.
 * Handles both Prisma objects (flat or included) and potential legacy inputs.
 */
/**
 * Returns all user IDs that _userId_ is allowed to see.
 * Combines:
 *  1. The user themselves + all subordinates (reportsTo chain via BFS)
 *  2. All users in branches the user manages (BranchManager relation)
 */
/**
 * Returns all user IDs that _userId_ is allowed to see.
 * Combines:
 *  1. The user themselves + all subordinates (reportsTo chain via BFS)
 *  2. All users in teams the user manages (TeamManager relation)
 *  3. All users in branches the user manages (BranchManager relation) - Restricted to high-level roles
 */
export const getVisibleUserIds = async (userId: string, subordinatesOnly: boolean = false): Promise<string[]> => {
    // 1. Fetch user to check role and branch
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, branchId: true }
    });

    if (!user) return [userId];

    // Initialize with self + subordinates via reporting chain
    // getSubordinateIds is recursive and includes userId itself.
    const subordinateIds = await getSubordinateIds(userId);

    if (subordinatesOnly) {
        return subordinateIds;
    }

    // 2. Users in managed teams (Explicitly assigned manager)
    // This handles team isolation if reporting lines don't perfectly match team membership
    const managedTeams = await prisma.team.findMany({
        where: { managerId: userId, isDeleted: false },
        select: { id: true }
    });

    if (managedTeams.length > 0) {
        const teamUsers = await prisma.user.findMany({
            where: { teamId: { in: managedTeams.map(t => t.id) } },
            select: { id: true }
        });
        for (const u of teamUsers) {
            if (!subordinateIds.includes(u.id)) {
                subordinateIds.push(u.id);
            }
        }
    }

    // 3. Users in managed branches (Explicitly assigned branch manager)
    // IMPORTANT: Branch Managers see everything in the branch. 
    // To prevent "leads from other teams" leakage for lower-level managers, 
    // we only apply this if the user has an administrative role or is specifically a Branch Manager.
    // We'll check if the role includes 'admin' or 'branch'.
    const isHighLevelManager = user.role.toLowerCase().includes('admin') || 
                               user.role.toLowerCase().includes('branch') || 
                               user.role.toLowerCase().includes('country') ||
                               user.role.toLowerCase().includes('regional');

    if (isHighLevelManager) {
        const managedBranches = await prisma.branch.findMany({
            where: { managerId: userId, isDeleted: false },
            select: { id: true }
        });

        const managementBranchIds = managedBranches.map(b => b.id);

        if (managementBranchIds.length > 0) {
            const branchUsers = await prisma.user.findMany({
                where: { branchId: { in: managementBranchIds } },
                select: { id: true }
            });
            for (const u of branchUsers) {
                if (!subordinateIds.includes(u.id)) {
                    subordinateIds.push(u.id);
                }
            }
        }
    }

    return subordinateIds;
};

export const getOrgId = (user: any): string | null => {
    if (!user) return null;

    // Prisma style: user.organisationId (if flat) or user.organisation.id (if included)
    if (user.organisationId) return user.organisationId;
    if (user.organisation && user.organisation.id) return user.organisation.id;

    // Legacy Mongoose fallback (just in case)
    if (user.organisation && user.organisation._id) return user.organisation._id.toString();
    if (user.organisation) return user.organisation.toString();

    return null;
};

export const getLeadVisibilityFilter = async (user: any, isSuperAdmin: boolean = false) => {
    // Operation Executive is an org-wide role by design (not reporting-chain
    // scoped like manager/sales_rep) — it needs the same full-visibility
    // bypass as admin here, but does NOT get admin's settings/user-management
    // permissions (that's governed separately by the Role.permissions array,
    // see roleController.ts's SYSTEM_ROLES).
    if (isSuperAdmin || user.role === 'super_admin' || user.role === 'admin' || user.role === 'operation_executive') {
        return {};
    }

    const visibleUserIds = await getVisibleUserIds(user.id);
    const orConditions: any[] = [
        { assignedToId: { in: visibleUserIds } },
        { createdById: user.id },
        {
            AND: [
                { createdById: { in: visibleUserIds } },
                { assignedToId: null }
            ]
        }
    ];

    if (user.role === 'admin') {
        orConditions.push({ assignedToId: null });
    } else if (isManager(user)) {
        orConditions.push({
            AND: [
                { assignedToId: null },
                {
                    OR: [
                        { branchId: null },
                        { branchId: user.branchId || undefined }
                    ]
                }
            ]
        });
    }

    return { OR: orConditions };
};

export const getOppVisibilityFilter = async (user: any, isSuperAdmin: boolean = false) => {
    if (isSuperAdmin || user.role === 'super_admin' || user.role === 'admin' || user.role === 'operation_executive') {
        return {};
    }

    const visibleUserIds = await getVisibleUserIds(user.id);

    return { ownerId: { in: visibleUserIds } };
};
