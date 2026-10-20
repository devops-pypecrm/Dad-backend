import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger';
import prisma from '../config/prisma';
import { getOrgId, getVisibleUserIds, wouldCreateReportingCycle } from '../utils/hierarchyUtils';
// UserRole import removed
import { logAudit } from '../utils/auditLogger';
import { isAdmin } from '../utils/roleUtils';

// POST /api/users/device-token - Register/refresh the caller's mobile push (FCM) token
export const registerDeviceToken = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const { fcmToken } = req.body;

        if (!fcmToken || typeof fcmToken !== 'string') {
            return res.status(400).json({ message: 'fcmToken is required' });
        }

        // An FCM token identifies a physical device install, not a user — if
        // someone logs out and a different person logs into the same app on
        // the same device, the mobile app re-registers the SAME token under
        // the new account, but nothing previously cleared it from the old
        // one. Both users' `fcmToken` then held the identical value, so a
        // push meant for either account landed on this one device
        // regardless of who was actually logged in. Clearing it from every
        // other user first makes a token exclusive to whoever most recently
        // registered it — exactly one account per device at a time.
        await prisma.user.updateMany({
            where: { fcmToken, id: { not: currentUser.id } },
            data: { fcmToken: null, fcmTokenUpdatedAt: null }
        });

        await prisma.user.update({
            where: { id: currentUser.id },
            data: { fcmToken, fcmTokenUpdatedAt: new Date() }
        });

        res.json({ message: 'Device token registered' });
    } catch (error) {
        logger.error('registerDeviceToken Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/users/device-token/clear - Called on logout so this device stops
// receiving push for the account that just signed out, rather than leaving
// it registered until whoever logs in next on this device re-registers the
// same token (see registerDeviceToken's cross-user cleanup for that half).
export const clearDeviceToken = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        await prisma.user.update({
            where: { id: currentUser.id },
            data: { fcmToken: null, fcmTokenUpdatedAt: null }
        });
        res.json({ message: 'Device token cleared' });
    } catch (error) {
        logger.error('clearDeviceToken Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/users/:id/stats - Get user performance stats
export const getUserStats = async (req: Request, res: Response) => {
    try {
        const userId = req.params.id;
        const currentUser = (req as any).user;

        // Security: Verify existence and org match
        const targetUser = await prisma.user.findUnique({ where: { id: userId } });
        if (!targetUser) return res.status(404).json({ message: 'User not found' });

        if (currentUser.role !== 'super_admin') {
            const currentOrgId = getOrgId(currentUser);
            if (targetUser.organisationId !== currentOrgId) {
                return res.status(403).json({ message: 'Not authorized to view stats for this user' });
            }

            // Further role checks (if not admin/super_access, must be self or a manager
            // anywhere up the reporting chain - not just a *direct* manager. This only
            // checked targetUser.reportsToId === currentUser.id before, which meant a
            // manager could see stats for their direct reports but not their reports'
            // reports, even though getVisibleUserIds (used by the leads list on this
            // same profile page) already walks the full chain - so the page's leads
            // table would populate while its stats cards silently 403'd.
            if (currentUser.role !== 'admin' && currentUser.id !== userId) {
                const visibleIds = await getVisibleUserIds(currentUser.id);
                if (!visibleIds.includes(userId)) {
                    return res.status(403).json({ message: 'Not authorized to view stats' });
                }
            }
        }

        // 1. Total Leads Owned
        const totalLeads = await prisma.lead.count({
            where: { assignedToId: userId, isDeleted: false }
        });

        // 2. Leads Won — Lead.status only ever reaches 'converted' (never 'won'/'lost'); the real
        // outcome lives on the linked Opportunity's stage.
        const convertedLeads = await prisma.lead.count({
            where: {
                assignedToId: userId,
                isDeleted: false,
                convertedOpportunities: { some: { stage: 'closed_won' } }
            }
        });

        // 3. Leads Lost
        const lostLeads = await prisma.lead.count({
            where: {
                assignedToId: userId,
                isDeleted: false,
                convertedOpportunities: { some: { stage: 'closed_lost' } }
            }
        });

        // 4. Sales Value (from Opportunities won or Orders?) 
        // For now, let's assume Opportunity 'closed_won' linked to User
        const totalSalesValue = await prisma.opportunity.aggregate({
            where: { ownerId: userId, stage: 'closed_won' },
            _sum: { amount: true }
        });

        // 5. Recent Activity (History of actions) - optional, maybe fetch via activity log later

        res.json({
            stats: {
                totalLeads,
                convertedLeads,
                lostLeads,
                conversionRate: totalLeads > 0 ? ((convertedLeads / totalLeads) * 100).toFixed(1) : 0,
                totalSalesValue: totalSalesValue._sum.amount || 0
            }
        });

    } catch (error) {
        logger.error('getUserStats Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getUsers = async (req: Request, res: Response) => {
    try {
        logger.info('getUsers called', 'UserController', undefined, (req as any).user?.organisationId);
        const currentUser = (req as any).user;
        const where: any = { isDeleted: false };
        // Wait, Mongoose schema had isDeleted check?
        // Original: const query: any = { isDeleted: { $ne: true } };
        // Prisma schema: isPlaceholder (default false). 
        // Lead has isDeleted, User has isActive.
        // Let's assume we want all existing users? 
        // Or if we want to filter logically deleted users? 
        // User model in Prisma doesn't have isDeleted, only isActive.
        // Let's stick to showing all users for now or check if soft delete is intended.
        // Original Mongoose find({ isDeleted: { $ne: true } }) implies a soft delete field exists.
        // In my Prisma schema for User I missed isDeleted. I have isActive.
        // I'll use isActive for now as a proxy or just show all for this phase.

        // 1. Organisation Scoping
        if (currentUser.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = req.query.organisationId as string;
            }
        } else {
            const orgId = getOrgId(currentUser);
            if (!orgId) {
                return res.status(403).json({ message: 'User has no organisation' });
            }
            where.organisationId = orgId;
            const subordinatesOnly = req.query.subordinatesOnly === 'true';

            // Hierarchy filtering: non-admin users only see subordinates + branch members
            // OR if subordinatesOnly is explicitly requested (even for admins)
            if (currentUser.role !== 'admin' || subordinatesOnly) {
                const visibleIds = await getVisibleUserIds(currentUser.id, subordinatesOnly);
                where.id = { in: visibleIds };
            }
        }

        const users = await prisma.user.findMany({
            where,
            include: {
                _count: {
                    select: { assignedLeads: true }
                },
                organisation: { select: { name: true } },
                reportsTo: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        position: true
                    }
                },
                branch: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        // logger.debug(`Query where: ${JSON.stringify(where)}`, 'UserController');
        logger.info(`Users found: ${users.length}`, 'UserController');

        // Build role lookup for UUID → name resolution
        const allRoles = await prisma.role.findMany({
            select: { id: true, roleKey: true, name: true }
        });
        const roleKeyToInfo = new Map(allRoles.map(r => [r.roleKey, { key: r.roleKey, name: r.name }]));

        // Transform results to match frontend expectations and ensure security
        const transformedUsers = users.map(u => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { password, ...userWithoutPassword } = u;

            // Include related branch/parent info for UI
            const branch = u.branch ? { id: u.branch.id, name: u.branch.name } : undefined;
            const parent = u.reportsTo ? { id: u.reportsTo.id, name: `${u.reportsTo.firstName} ${u.reportsTo.lastName}` } : undefined;

            // Resolve role: u.role stores the roleKey
            const roleInfo = roleKeyToInfo.get(u.role);
            const roleKey = roleInfo ? roleInfo.key : u.role;
            const roleName = roleInfo ? roleInfo.name : u.role.replace(/_/g, ' ');

            return {
                ...userWithoutPassword,
                _id: u.id,
                id: u.id,
                role: { id: roleKey, name: roleName },
                reportsTo: u.reportsTo ? {
                    ...u.reportsTo,
                    id: u.reportsTo.id,
                    _id: u.reportsTo.id
                } : null,
                branch: u.branch ? {
                    id: u.branch.id,
                    name: u.branch.name
                } : null
            };
        });

        res.json({ users: transformedUsers });
    } catch (error) {
        logger.error('getUsers Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/users/my-team — lightweight endpoint for sidebar hierarchy
export const getMyTeam = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const targetParentId = req.query.parentId as string || currentUser.id;

        // Security check: If parentId is provided and not the current user,
        // we must verify that the targetParentId is actually a subordinate (descendant) of the current user.
        // For simplicity in the sidebar, we'll allow fetching if the targetParentId is either the currentUser
        // or someone who reports directly or indirectly to them.
        if (targetParentId !== currentUser.id && !isAdmin(currentUser)) {
            // Check if target is a descendant
            const targetUser = await prisma.user.findUnique({
                where: { id: targetParentId },
                select: { reportsToId: true }
            });

            if (!targetUser) {
                return res.status(404).json({ message: 'User not found' });
            }

            // Path-based check or recursive check (simpler: check if reportsToId is currentUser or if they are in the hierarchy)
            // For now, let's verify if they are at least in the same organisation
            const targetFullUser = await prisma.user.findFirst({
                where: { id: targetParentId, organisationId: currentUser.organisationId }
            });

            if (!targetFullUser) {
                return res.status(403).json({ message: 'Access denied to this team' });
            }
        }

        // Fetch direct reports (one level)
        const directReports = await prisma.user.findMany({
            where: { reportsToId: targetParentId, isActive: true },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                role: true,
                profileImage: true,
            },
            orderBy: { firstName: 'asc' }
        });

        // Check which reports have subordinates
        const reportIds = directReports.map(r => r.id);
        const subCounts = await prisma.user.groupBy({
            by: ['reportsToId'],
            where: { reportsToId: { in: reportIds }, isActive: true },
            _count: { id: true }
        });
        const subCountMap = new Map(subCounts.map(s => [s.reportsToId!, s._count.id]));

        // Fetch managed branches (only for the root fetch)
        let managedBranches: any[] = [];
        if (targetParentId === currentUser.id) {
            managedBranches = await prisma.branch.findMany({
                where: { managerId: currentUser.id, isDeleted: false },
                select: { id: true, name: true }
            });
        }

        // Role lookup
        const allRoles = await prisma.role.findMany({ select: { id: true, roleKey: true, name: true } });
        const roleKeyToInfo = new Map(allRoles.map(r => [r.roleKey, { key: r.roleKey, name: r.name }]));

        const team = directReports.map(u => {
            const roleInfo = roleKeyToInfo.get(u.role);
            return {
                id: u.id,
                firstName: u.firstName,
                lastName: u.lastName,
                role: roleInfo ? roleInfo.name : u.role.replace(/_/g, ' '),
                profileImage: u.profileImage,
                hasSubordinates: (subCountMap.get(u.id) || 0) > 0
            };
        });

        res.json({ team, managedBranches });
    } catch (error) {
        logger.error('getMyTeam Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getUserById = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            include: { organisation: true }
        });

        if (!user) return res.status(404).json({ message: 'User not found' });

        // Security check
        if (currentUser.role !== 'super_admin') {
            const currentOrgId = getOrgId(currentUser);
            const targetOrgId = getOrgId(user);

            if (currentOrgId !== targetOrgId) {
                return res.status(403).json({ message: 'Not authorized to view this user' });
            }
        }

        // Exclude password
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password, ...userWithoutPassword } = user;

        let roleRecord = null;
        if (user.role) {
            roleRecord = await prisma.role.findFirst({
                where: {
                    OR: [
                        { roleKey: user.role, organisationId: user.organisationId },
                        { roleKey: user.role, organisationId: null },
                        { id: user.role }
                    ]
                }
            });
        }
        const roleName = roleRecord?.name || (user.role === 'custom_1774677200913' ? 'ASM' : user.role);

        res.json({
            ...userWithoutPassword,
            roleName,
            roleRecord
        });
    } catch (error) {
        logger.error('getUserById Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateUser = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const { password, ...updateData } = req.body;
        const userId = req.params.id;

        // Security Check
        if (currentUser.role !== 'super_admin') {
            const tempUser = await prisma.user.findUnique({ where: { id: userId }, include: { organisation: true } });
            if (!tempUser) return res.status(404).json({ message: 'User not found' });

            const isSelfUpdate = userId === currentUser.id;
            const currentOrgId = getOrgId(currentUser);
            const targetOrgId = getOrgId(tempUser);
            const orgMatch = currentOrgId && targetOrgId && currentOrgId === targetOrgId;

            if (!isSelfUpdate && !orgMatch) {
                return res.status(403).json({ message: 'Not authorized to update this user' });
            }
        }

        // Process Update Data
        const dataToUpdate: any = {};
        Object.keys(updateData).forEach(key => {
            if (updateData[key] !== null && updateData[key] !== undefined) {
                dataToUpdate[key] = updateData[key];
            }
        });

        // Specific handling for dailyLeadQuota to ensure it's an integer
        if (updateData.dailyLeadQuota !== undefined) {
            dataToUpdate.dailyLeadQuota = updateData.dailyLeadQuota === null ? null : parseInt(updateData.dailyLeadQuota);
        }

        // Security: Prevent organisationId or role changes for non-super-admins
        if (currentUser.role !== 'super_admin') {
            delete dataToUpdate.organisationId;
            // Only allow role change if admin is updating someone in their own org
            // But we should also prevent admin from making themselves or others super_admin
            if (dataToUpdate.role === 'super_admin') {
                delete dataToUpdate.role;
            }
            // Only allow permissions configuration if current user is admin
            if (!isAdmin(currentUser)) {
                delete dataToUpdate.permissions;
            }
        }

        // Strict super_admin scoping and limit checks
        if (dataToUpdate.role === 'super_admin') {
            const targetUser = await prisma.user.findUnique({ where: { id: userId } });
            if (!targetUser) return res.status(404).json({ message: 'User not found' });

            const orgIdToCheck = dataToUpdate.organisationId !== undefined ? dataToUpdate.organisationId : targetUser.organisationId;
            if (orgIdToCheck) {
                return res.status(400).json({ message: 'Organisation users cannot be super_admin' });
            }

            const superAdminExists = await prisma.user.findFirst({
                where: { role: 'super_admin', id: { not: userId } }
            });
            if (superAdminExists) {
                return res.status(400).json({ message: 'Only one superadmin is allowed in the system' });
            }
        }

        // Handle reportsTo mapping
        if (updateData.reportsTo) {
            if (updateData.reportsTo === userId) {
                return res.status(400).json({ message: 'User cannot report to themselves' });
            }
            // Beyond the direct self-report case above: walk the proposed manager's own
            // chain upward to make sure it doesn't loop back to this user (e.g. A -> B,
            // then later reassigning B -> A). A cycle leaves everyone in it invisible in
            // the org chart (see wouldCreateReportingCycle's doc comment).
            if (await wouldCreateReportingCycle(userId, updateData.reportsTo as string)) {
                return res.status(400).json({ message: 'This would create a circular reporting structure' });
            }
            const manager = await prisma.user.findUnique({ where: { id: updateData.reportsTo as string } });
            if (!manager) return res.status(400).json({ message: 'Manager not found' });

            // Check Org
            const managerOrgId = getOrgId(manager);
            const targetUser = await prisma.user.findUnique({ where: { id: userId } });
            const targetOrgId = getOrgId(targetUser) || getOrgId(currentUser);

            if (targetOrgId !== managerOrgId) {
                return res.status(400).json({ message: 'Manager must belong to same organisation' });
            }

            dataToUpdate.reportsTo = { connect: { id: updateData.reportsTo } };
        }

        // Handle Branch assignment
        if (updateData.branchId) {
            const branch = await prisma.branch.findUnique({ where: { id: updateData.branchId } });
            if (!branch) return res.status(400).json({ message: 'Branch not found' });

            // Check Org
            if (branch.organisationId !== (getOrgId(currentUser) || getOrgId(await prisma.user.findUnique({ where: { id: userId } })))) {
                return res.status(400).json({ message: 'Branch must belong to same organisation' });
            }
            dataToUpdate.branch = { connect: { id: updateData.branchId } };
            delete dataToUpdate.branchId;
        } else if (updateData.branchId === null) {
            dataToUpdate.branch = { disconnect: true };
            delete dataToUpdate.branchId;
        }

        if (password && password.trim() !== '') {
            const salt = await bcrypt.genSalt(10);
            dataToUpdate.password = await bcrypt.hash(password, salt);
            dataToUpdate.plainPassword = password;
            dataToUpdate.tokenVersion = { increment: 1 };
        }

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: dataToUpdate
        });

        // Audit Log
        logAudit({
            action: 'UPDATE_USER',
            entity: 'User',
            entityId: userId,
            actorId: currentUser.id,
            organisationId: getOrgId(updatedUser) || currentUser.organisationId,
            details: { updatedFields: Object.keys(dataToUpdate).filter(k => k !== 'password') }
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _password, ...userNoPass } = updatedUser;
        res.json(userNoPass);
    } catch (error) {
        logger.error('UpdateUser Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/users
export const createUser = async (req: Request, res: Response) => {
    try {
        const { email, password, role, firstName, lastName, organisationId, branchId, phone, dailyLeadQuota } = req.body;
        const currentUser = (req as any).user;

        // Determine Org ID
        let targetOrgId = organisationId;
        if (currentUser.role !== 'super_admin') {
            targetOrgId = getOrgId(currentUser);
        }

        // Strict super_admin scoping and limit checks
        if (role === 'super_admin') {
            if (targetOrgId || organisationId) {
                return res.status(400).json({ message: 'Organisation users cannot be super_admin' });
            }
            const superAdminExists = await prisma.user.findFirst({
                where: { role: 'super_admin' }
            });
            if (superAdminExists) {
                return res.status(400).json({ message: 'Only one superadmin is allowed in the system' });
            }
        }

        if (!targetOrgId) {
            return res.status(400).json({ message: 'Organisation ID is required' });
        }

        // Check permissions: admins, super_admins, or anyone with 'users:create:subordinates'
        const { hasUserPermission } = await import('../utils/roleUtils');
        const hasCreationPermission = await hasUserPermission(currentUser.id, 'users:create:subordinates');

        if (currentUser.role !== 'super_admin' && currentUser.role !== 'admin') {
            if (!hasCreationPermission) {
                return res.status(403).json({ message: 'You do not have permission to create users.' });
            }

            const targetReportsTo = req.body.reportsTo;
            if (!targetReportsTo) {
                return res.status(400).json({ message: 'You must assign a manager for the new user.' });
            }

            const { getSubordinateIds } = await import('../utils/hierarchyUtils');
            const subordinateIds = await getSubordinateIds(currentUser.id);
            if (!subordinateIds.includes(targetReportsTo)) {
                return res.status(403).json({ message: 'You can only assign a manager who is under your reporting hierarchy.' });
            }
        }

        // 1. License Check (User Limit)
        if (currentUser.role !== 'super_admin') {
            const { LicenseEnforcementService } = await import('../services/licenseEnforcementService');
            await LicenseEnforcementService.checkLimits(targetOrgId, 'users');
        }

        // 2. Email duplication check
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            if (existingUser.isActive) {
                return res.status(409).json({ message: 'User with this email already exists and is active' });
            } else {
                // Suspended user: rename to free up email/userId and proceed
                const renameSuffix = `_suspended_${Date.now()}`;
                await prisma.user.update({
                    where: { id: existingUser.id },
                    data: { 
                        email: `${existingUser.email}${renameSuffix}`,
                        userId: existingUser.userId ? `${existingUser.userId}${renameSuffix}` : undefined
                    }
                });
                logger.info(`Renamed suspended user ${existingUser.id} to free up email ${email}`, 'UserController');
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate UserID with collision protection
        let generatedUserId: string | undefined;
        let isUnique = false;
        let attempts = 0;

        const org = await prisma.organisation.findUnique({ where: { id: targetOrgId } });

        while (!isUnique && attempts < 20) {
            attempts++;
            if (org) {
                // Atomic update of the counter
                const updatedOrg = await prisma.organisation.update({
                    where: { id: targetOrgId },
                    data: { userIdCounter: { increment: 1 } }
                });
                
                // Use Org Name prefix (3 chars) + part of Org ID (4 chars) + counter
                const namePrefix = updatedOrg.name.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
                const orgSuffix = targetOrgId.slice(0, 4).toUpperCase();
                const counter = updatedOrg.userIdCounter;
                generatedUserId = `${namePrefix}${orgSuffix}${counter.toString().padStart(3, '0')}`;

                const collision = await prisma.user.findUnique({ where: { userId: generatedUserId } });
                if (!collision) {
                    isUnique = true;
                }
            } else {
                isUnique = true;
            }
        }

        const newUser = await prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                plainPassword: password,
                role: role || 'sales_rep',
                firstName,
                lastName,
                phone,
                organisationId: targetOrgId,
                userId: generatedUserId,
                isActive: true, // Default to active
                dailyLeadQuota: dailyLeadQuota ? parseInt(dailyLeadQuota) : undefined,
                // If currentUser is non-admin creating a user, maybe set reportsTo?
                reportsToId: req.body.reportsTo || (currentUser.role !== 'super_admin' ? currentUser.id : undefined),
                branchId: branchId || undefined,
                permissions: req.body.permissions || []
            }
        });

        // Audit Log
        logAudit({
            action: 'CREATE_USER',
            entity: 'User',
            entityId: newUser.id,
            actorId: currentUser.id,
            organisationId: targetOrgId,
            details: { email: newUser.email, role: newUser.role }
        });

        // 3. Update Organisation Counter (Optional, if using userIdCounter)
        // await prisma.organisation.update({ where: { id: targetOrgId }, data: { userIdCounter: { increment: 1 } } });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _, ...userWithoutPassword } = newUser;
        res.status(201).json(userWithoutPassword);

    } catch (error) {
        logger.error('createUser Error', error, 'UserController');
        res.status(400).json({ message: (error as Error).message });
    }
};

export const inviteUser = async (req: Request, res: Response) => {
    try {
        const { email, firstName, lastName, role, organisationId, position, reportsTo, password, branchId, phone, dailyLeadQuota } = req.body;
        const currentUser = (req as any).user;
        const orgId = getOrgId(currentUser) || organisationId;
        logger.info('inviteUser called', 'UserController', undefined, orgId, { body: req.body });

        // 1. License Check
        const { LicenseEnforcementService } = await import('../services/licenseEnforcementService');
        await LicenseEnforcementService.checkLimits(orgId, 'users');

        // Check permissions: admins, super_admins, or anyone with 'users:create:subordinates'
        const { hasUserPermission } = await import('../utils/roleUtils');
        const hasCreationPermission = await hasUserPermission(currentUser.id, 'users:create:subordinates');

        if (currentUser.role !== 'super_admin' && currentUser.role !== 'admin') {
            if (!hasCreationPermission) {
                return res.status(403).json({ message: 'You do not have permission to invite users.' });
            }

            // Non-admins with users:create:subordinates must specify reportsTo manager, which must report to them
            if (!reportsTo) {
                return res.status(400).json({ message: 'You must assign a manager for the new user.' });
            }

            const { getSubordinateIds } = await import('../utils/hierarchyUtils');
            const subordinateIds = await getSubordinateIds(currentUser.id);
            if (!subordinateIds.includes(reportsTo)) {
                return res.status(403).json({ message: 'You can only assign a manager who is under your reporting hierarchy.' });
            }
        }

        if (!email) {
            logger.warn('Invite failed: Email is missing', 'UserController');
            return res.status(400).json({ message: 'Email is required' });
        }

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            if (existingUser.isActive) {
                return res.status(400).json({ message: 'User with this email already exists and is active' });
            } else {
                // Suspended user: rename to free up email/userId and proceed
                const renameSuffix = `_suspended_${Date.now()}`;
                await prisma.user.update({
                    where: { id: existingUser.id },
                    data: { 
                        email: `${existingUser.email}${renameSuffix}`,
                        userId: existingUser.userId ? `${existingUser.userId}${renameSuffix}` : undefined
                    }
                });
                logger.info(`Renamed suspended user ${existingUser.id} to free up email ${email}`, 'UserController');
            }
        }

        let targetOrgId = getOrgId(currentUser);
        if (currentUser.role === 'super_admin' && organisationId) {
            targetOrgId = organisationId;
        }

        // Strict super_admin scoping and limit checks
        if (role === 'super_admin') {
            if (targetOrgId || organisationId) {
                return res.status(400).json({ message: 'Organisation users cannot be super_admin' });
            }
            const superAdminExists = await prisma.user.findFirst({
                where: { role: 'super_admin' }
            });
            if (superAdminExists) {
                return res.status(400).json({ message: 'Only one superadmin is allowed in the system' });
            }
        }

        if (!targetOrgId) {
            logger.warn('Invite failed: Organisation ID missing', 'UserController');
            return res.status(400).json({ message: 'Organisation is required' });
        }

        // Check limits and increment counter
        const org = await prisma.organisation.findUnique({ where: { id: targetOrgId } });
        /*
        if (org) {
            const userCount = await prisma.user.count({ where: { organisationId: targetOrgId, isActive: true } });
            if (userCount >= org.userLimit) {
                return res.status(403).json({ message: 'User limit reached' });
            }
        }
        */

        // Generate UserID with collision protection
        let generatedUserId: string | undefined;
        let isUnique = false;
        let attempts = 0;

        while (!isUnique && attempts < 20) {
            attempts++;
            if (org) {
                // Atomic update of the counter
                const updatedOrg = await prisma.organisation.update({
                    where: { id: targetOrgId },
                    data: { userIdCounter: { increment: 1 } }
                });
                
                // Use Org Name prefix (3 chars) + part of Org ID (4 chars) + counter
                // This ensures uniqueness across organisations even if names are similar
                const namePrefix = updatedOrg.name.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
                const orgSuffix = targetOrgId.slice(0, 4).toUpperCase();
                const counter = updatedOrg.userIdCounter;
                generatedUserId = `${namePrefix}${orgSuffix}${counter.toString().padStart(3, '0')}`;

                // Verify this ID isn't already in use globally
                const collision = await prisma.user.findUnique({ where: { userId: generatedUserId } });
                if (!collision) {
                    isUnique = true;
                } else {
                    logger.warn(`UserId collision detected for ${generatedUserId}, retrying with next counter...`, 'UserController');
                }
            } else {
                isUnique = true; // No org prefix logic
            }
        }

        const tempPassword = password || Math.random().toString(36).slice(-8);
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(tempPassword, salt);

        const newUser = await prisma.$transaction(async (prisma) => {
            return await prisma.user.create({
                data: {
                    email,
                    firstName,
                    lastName,
                    password: hashedPassword,
                    plainPassword: tempPassword,
                    role: role || 'sales_rep',
                    organisation: { connect: { id: targetOrgId } },
                    position,
                    phone,
                    userId: generatedUserId,
                    reportsTo: reportsTo ? { connect: { id: reportsTo } } : undefined,
                    branch: branchId ? { connect: { id: branchId } } : undefined,
                    isActive: true,
                    dailyLeadQuota: dailyLeadQuota ? parseInt(dailyLeadQuota) : undefined,
                    permissions: req.body.permissions || []
                }
            });
        });

        // Audit Log
        logAudit({
            action: 'INVITE_USER',
            entity: 'User',
            entityId: newUser.id,
            actorId: currentUser.id,
            organisationId: targetOrgId,
            details: { email: newUser.email, role: newUser.role }
        });

        res.status(201).json({
            user: { id: newUser.id, email: newUser.email, firstName: newUser.firstName },
            message: 'User invited successfully'
        });

    } catch (error) {
        logger.error('inviteUser Error', error, 'UserController');
        res.status(400).json({ message: (error as Error).message });
    }
};

export const deactivateUser = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const orgId = getOrgId(currentUser);
        const userId = req.params.id;

        const where: any = { id: userId };
        if (currentUser.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
        }

        // Also ensure target exists first? Update throws if not found? 
        // findFirst/updateMany or catch error. 
        // Using update directly requires ID validation implicitly or it throws "Record to update not found."
        // We can just add organisationId to the where clause of update, but prisma update `where` only accepts unique identifiers.
        // So we need to use updateMany or findFirst then update.
        // Using findFirst then update for safety.

        const existing = await prisma.user.findFirst({ where });
        if (!existing) return res.status(404).json({ message: 'User not found or access denied' });

        if (!existing.isActive) return res.status(400).json({ message: 'User is already inactive' });

        // 1. Determine transfer target
        let transferTargetId = existing.reportsToId;
        if (!transferTargetId) {
            // Find an admin in the same organisation
            const adminUser = await prisma.user.findFirst({
                where: {
                    organisationId: existing.organisationId,
                    role: 'admin',
                    isActive: true,
                    id: { not: userId }
                }
            });
            transferTargetId = adminUser ? adminUser.id : currentUser.id;
        }

        // 2. Perform bulk transfers
        const entitiesToTransfer = [
            { model: 'lead', ownerField: 'assignedToId' },
            { model: 'account', ownerField: 'ownerId' },
            { model: 'contact', ownerField: 'ownerId' },
            { model: 'opportunity', ownerField: 'ownerId' },
            { model: 'task', ownerField: 'assignedToId' },
            { model: 'case', ownerField: 'assignedToId' },
            { model: 'quote', ownerField: 'assignedToId' },
            { model: 'goal', ownerField: 'assignedToId' },
            { model: 'salesTarget', ownerField: 'assignedToId' }
        ];

        const transferResults: any = {};

        for (const entity of entitiesToTransfer) {
            const result = await (prisma as any)[entity.model].updateMany({
                where: {
                    [entity.ownerField]: userId,
                    isDeleted: false
                },
                data: {
                    [entity.ownerField]: transferTargetId,
                    previousOwnerId: userId
                }
            });
            transferResults[entity.model] = result.count;
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: { isActive: false }
        });

        // Audit Log
        logAudit({
            action: 'DEACTIVATE_USER',
            entity: 'User',
            entityId: user.id,
            actorId: currentUser.id,
            organisationId: user.organisationId || currentUser.organisationId,
            details: { 
                email: user.email,
                transferredTo: transferTargetId,
                transferCounts: transferResults
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _pw, ...sanitizedUser } = user;

        res.json({ message: 'User deactivated', user: sanitizedUser });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const activateUser = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const orgId = getOrgId(currentUser);
        const userId = req.params.id;

        const where: any = { id: userId };
        if (currentUser.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
        }

        const existing = await prisma.user.findFirst({ where });
        if (!existing) return res.status(404).json({ message: 'User not found or access denied' });

        const moveBack = req.body.moveBack === true;
        const transferResults: any = {};

        if (moveBack) {
            const entitiesToRestore = [
                { model: 'lead', ownerField: 'assignedToId' },
                { model: 'account', ownerField: 'ownerId' },
                { model: 'contact', ownerField: 'ownerId' },
                { model: 'opportunity', ownerField: 'ownerId' },
                { model: 'task', ownerField: 'assignedToId' },
                { model: 'case', ownerField: 'assignedToId' },
                { model: 'quote', ownerField: 'assignedToId' },
                { model: 'goal', ownerField: 'assignedToId' },
                { model: 'salesTarget', ownerField: 'assignedToId' }
            ];

            for (const entity of entitiesToRestore) {
                const result = await (prisma as any)[entity.model].updateMany({
                    where: {
                        previousOwnerId: userId,
                        isDeleted: false
                    },
                    data: {
                        [entity.ownerField]: userId,
                        previousOwnerId: null
                    }
                });
                transferResults[entity.model] = result.count;
            }
        }

        const user = await prisma.user.update({
            where: { id: userId },
            data: { isActive: true }
        });

        // Audit Log
        logAudit({
            action: 'ACTIVATE_USER',
            entity: 'User',
            entityId: user.id,
            actorId: currentUser.id,
            organisationId: user.organisationId || currentUser.organisationId,
            details: { 
                email: user.email,
                restoredEntities: moveBack,
                transferCounts: transferResults
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _pw, ...sanitizedUser } = user;

        res.json({ message: 'User activated', user: sanitizedUser });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const permanentlyDeleteUser = async (req: Request, res: Response) => {
    try {
        const currentUser = (req as any).user;
        const orgId = getOrgId(currentUser);
        const userId = req.params.id;

        // Security check
        if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only administrators can permanently delete users' });
        }

        const where: any = { id: userId };
        if (currentUser.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
        }

        const existing = await prisma.user.findFirst({
            where,
            include: { subordinates: true }
        });

        if (!existing) {
            return res.status(404).json({ message: 'User not found or access denied' });
        }

        // 1. MUST be suspended first
        if (existing.isActive) {
            return res.status(400).json({ message: 'User must be suspended before they can be permanently deleted' });
        }

        // 2. Prevent deleting self
        if (existing.id === currentUser.id) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }

        console.log(`[PERMANENT_DELETE] User ${existing.email} deletion started by ${currentUser.email}`);

        // 3. Determine transfer target (for ownership)
        let transferTargetId = existing.reportsToId;
        if (!transferTargetId) {
            const adminUser = await prisma.user.findFirst({
                where: {
                    organisationId: existing.organisationId,
                    role: 'admin',
                    isActive: true,
                    id: { not: userId }
                }
            });
            transferTargetId = adminUser ? adminUser.id : currentUser.id;
        }

        /**
         * 4. CLEANUP / TRANSFER PHASE
         * We need to clear all mandatory/restrictive associations.
         */

        // Transfer transactional ownership (similar to deactivation, but more thorough)
        const entitiesToTransfer = [
            { model: 'lead', ownerField: 'assignedToId' },
            { model: 'account', ownerField: 'ownerId' },
            { model: 'contact', ownerField: 'ownerId' },
            { model: 'opportunity', ownerField: 'ownerId' },
            { model: 'task', ownerField: 'assignedToId' },
            { model: 'case', ownerField: 'assignedToId' },
            { model: 'quote', ownerField: 'assignedToId' },
            { model: 'goal', ownerField: 'assignedToId' },
            { model: 'salesTarget', ownerField: 'assignedToId' },
            { model: 'followUp', ownerField: 'assignedToId' },
            { model: 'calendarEvent', ownerField: 'createdById' },
            { model: 'quote', ownerField: 'createdById' },
            { model: 'goal', ownerField: 'createdById' },
            { model: 'team', ownerField: 'createdById' },
            { model: 'checkIn', ownerField: 'userId' },
            { model: 'attendance', ownerField: 'userId' }
        ];

        for (const entity of entitiesToTransfer) {
            if ((prisma as any)[entity.model]) {
                await (prisma as any)[entity.model].updateMany({
                    where: { [entity.ownerField]: userId },
                    data: { [entity.ownerField]: transferTargetId }
                });
            }
        }

        // 4.5 DELETE RESTRICTIVE BUT LESS IMPORTANT DATA
        // These models have mandatory recipientId/userId and are safe to purge
        const entitiesToPurge = [
            { model: 'notification', field: 'recipientId' },
            { model: 'searchHistory', field: 'userId' },
            { model: 'userLog', field: 'userId' },
            { model: 'apiKey', field: 'createdById' },
            { model: 'importJob', field: 'createdById' }
        ];

        for (const item of entitiesToPurge) {
            if ((prisma as any)[item.model]) {
                await (prisma as any)[item.model].deleteMany({
                    where: { [item.field]: userId }
                });
            }
        }

        // Nullify creator/history fields that might block deletion (restrictive FKs)
        const entitiesToNullify = [
            { model: 'lead', field: 'createdById' },
            { model: 'lead', field: 'previousOwnerId' },
            { model: 'account', field: 'createdById' },
            { model: 'account', field: 'previousOwnerId' },
            { model: 'contact', field: 'createdById' },
            { model: 'contact', field: 'previousOwnerId' },
            { model: 'opportunity', field: 'createdById' },
            { model: 'opportunity', field: 'previousOwnerId' },
            { model: 'task', field: 'createdById' },
            { model: 'task', field: 'previousOwnerId' },
            { model: 'followUp', field: 'createdById' },
            { model: 'interaction', field: 'createdById' },
            { model: 'leadHistory', field: 'changerId' },
            { model: 'leadHistory', field: 'newOwnerId' },
            { model: 'leadHistory', field: 'oldOwnerId' },
            { model: 'quote', field: 'createdById' },
            { model: 'quote', field: 'previousOwnerId' },
            { model: 'case', field: 'createdById' },
            { model: 'case', field: 'previousOwnerId' },
            { model: 'salesTarget', field: 'previousOwnerId' },
            { model: 'salesTarget', field: 'assignedById' },
            { model: 'goal', field: 'previousOwnerId' }
        ];

        for (const item of entitiesToNullify) {
            if ((prisma as any)[item.model]) {
                try {
                    // check if the field is actually nullable in our logic or prisma
                    await (prisma as any)[item.model].updateMany({
                        where: { [item.field]: userId },
                        data: { [item.field]: null }
                    });
                } catch (e) { /* ignore if field/model doesn't exist or is not nullable */ }
            }
        }

        // Disconnect subordinates
        if (existing.subordinates.length > 0) {
            await prisma.user.updateMany({
                where: { reportsToId: userId },
                data: { reportsToId: transferTargetId }
            });
        }

        // 5. Soft Delete the User record
        await prisma.user.update({
            where: { id: userId },
            data: { 
                isDeleted: true, 
                deletedAt: new Date(),
                isActive: false
            }
        });

        // Audit Log
        logAudit({
            action: 'DELETE_USER',
            entity: 'User',
            entityId: userId,
            actorId: currentUser.id,
            organisationId: existing.organisationId || currentUser.organisationId,
            details: { email: existing.email, deletedBy: currentUser.email, transferredTo: transferTargetId, type: 'SOFT_DELETE' }
        });

        res.json({ message: 'User moved to trash and associations transferred' });
    } catch (error) {
        logger.error('permanentlyDeleteUser Error', error, 'UserController');
        res.status(500).json({ message: (error as Error).message });
    }
};
