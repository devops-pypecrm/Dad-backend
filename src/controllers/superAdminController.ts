import { Request, Response } from 'express';
import prisma from '../config/prisma';

// Get all organisations (Super Admin only)
export const getAllOrganisations = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const organisations = await prisma.organisation.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                licenses: {
                    where: { status: { in: ['active', 'trial'] } },
                    include: { plan: true },
                    take: 1
                }
            }
        });

        // Get user counts for each org
        const orgIds = organisations.map(o => o.id);
        const userCounts = await prisma.user.groupBy({
            by: ['organisationId'],
            where: { organisationId: { in: orgIds }, isActive: true },
            _count: { id: true }
        });

        const countMap = new Map(userCounts.map(u => [u.organisationId, u._count.id]));

        const result = organisations.map(org => ({
            ...org,
            userCount: countMap.get(org.id) || 0,
            activeLicense: org.licenses[0] || null
        }));

        res.json({ organisations: result });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get all users and their passwords grouped by organisation (Super Admin only)
export const getUserPasswords = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const users = await prisma.user.findMany({
            where: { isPlaceholder: false },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                plainPassword: true,
                role: true,
                organisation: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                firstName: 'asc'
            }
        });

        // Group by organisation
        const groupedData = users.reduce((acc, user) => {
            const orgName = user.organisation?.name || 'Unknown Organisation';
            const orgId = user.organisation?.id || 'unknown';
            
            if (!acc[orgId]) {
                acc[orgId] = {
                    organisationName: orgName,
                    users: []
                };
            }
            
            acc[orgId].users.push({
                id: user.id,
                name: `${user.firstName} ${user.lastName || ''}`.trim(),
                email: user.email,
                phone: user.phone,
                password: user.plainPassword,
                role: user.role
            });
            
            return acc;
        }, {} as Record<string, any>);

        res.json({ data: Object.values(groupedData) });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Create new organisation (Super Admin or Registration)
export const createOrganisation = async (req: Request, res: Response) => {
    try {
        const { name, slug, contactEmail, planId, firstName, lastName, password } = req.body;

        // Check if slug is unique
        const existingOrg = await prisma.organisation.findUnique({ where: { slug } });
        if (existingOrg) {
            return res.status(400).json({ message: 'Organisation slug already exists' });
        }

        // Check if user email exists
        const existingUser = await prisma.user.findUnique({ where: { email: contactEmail } });
        if (existingUser) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }

        // Lazy load bcrypt
        const bcrypt = await import('bcryptjs');
        const hashedPassword = await bcrypt.hash(password || 'Welcome123', 10);

        // Transaction to ensure atomicity
        const result = await prisma.$transaction(async (tx) => {
            // 1. Create Organisation
            const organisation = await tx.organisation.create({
                data: {
                    name,
                    slug: slug || name.toLowerCase().replace(/\s+/g, '-'),
                    contactEmail,
                    status: 'active',
                    subscription: {
                        status: planId ? 'active' : 'trial',
                        startDate: new Date().toISOString(),
                        endDate: new Date(Date.now() + (planId ? 30 : 14) * 24 * 60 * 60 * 1000).toISOString()
                    }
                }
            });

            // 2. Create Admin User
            const user = await tx.user.create({
                data: {
                    firstName: firstName || 'Admin',
                    lastName: lastName || 'User',
                    email: contactEmail,
                    password: hashedPassword,
                    role: 'admin',
                    organisationId: organisation.id,
                    isActive: true
                }
            });

            // 3. Create License (if plan)
            if (planId) {
                const plan = await tx.subscriptionPlan.findUnique({ where: { id: planId } });
                if (plan) {
                    const endDate = new Date();
                    endDate.setDate(endDate.getDate() + plan.durationDays);

                    await tx.license.create({
                        data: {
                            organisationId: organisation.id,
                            planId: planId,
                            status: 'active',
                            startDate: new Date(),
                            endDate,
                            maxUsers: plan.maxUsers,
                            activatedById: user.id
                        }
                    });
                }
            }

            return { organisation, tempPassword: password || 'Welcome123' };
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: result.organisation.id,
                actorId: (req as any).user?.id || 'SYSTEM_REG', // Super Admin ID or SYSTEM if registration
                action: 'CREATE_ORGANISATION',
                entity: 'Organisation',
                entityId: result.organisation.id,
                details: { name: result.organisation.name, slug: result.organisation.slug }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(result);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

// Update organisation
export const updateOrganisationAdmin = async (req: Request, res: Response) => {
    try {
        console.log(`[updateOrganisationAdmin] Incoming update for orgId: ${req.params.id}`);
        console.log('Body:', JSON.stringify(req.body, null, 2));

        if (!(req as any).user.isSuperAdmin) {
            console.log('[updateOrganisationAdmin] Access denied: User is not super admin');
            return res.status(403).json({ message: 'Access denied' });
        }

        const orgId = req.params.id;
        const data = { ...req.body };

        // Handle Plan Assignment checks
        if ('planId' in data) {
            if (data.planId) {
                const currentOrg = await prisma.organisation.findUnique({
                    where: { id: orgId },
                    include: {
                        licenses: {
                            where: { status: 'active' },
                            take: 1
                        }
                    }
                });
                const currentPlanId = currentOrg?.licenses[0]?.planId;

                if (data.planId === currentPlanId) {
                    console.log(`[updateOrganisationAdmin] Plan ID ${data.planId} is same as current. skipping license update.`);
                } else {
                    console.log(`[updateOrganisationAdmin] Plan assignment detected. planId: ${data.planId}`);
                    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: data.planId } });

                    if (!plan) {
                        console.log(`[updateOrganisationAdmin] Error: Invalid Plan ID - ${data.planId}`);
                        throw new Error('Invalid Plan ID');
                    }
                    console.log(`[updateOrganisationAdmin] Found plan: ${plan.name}`);

                    // 1. Update Org Limits based on Plan
                    data.userLimit = plan.maxUsers;
                    data.status = 'active'; // Activate org if plan assignment happens

                    console.log(`[updateOrganisationAdmin] Updating org limits: userLimit=${data.userLimit}, status=${data.status}`);

                    // 2. Legacy Subscription JSON sync
                    const existingSubscription = (currentOrg?.subscription as any) || {};

                    data.subscription = {
                        ...existingSubscription,
                        status: 'active',
                        plan: plan.name,
                        planId: plan.id,
                        startDate: new Date(),
                        endDate: new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000)
                    };
                    console.log('[updateOrganisationAdmin] Updated subscription JSON:', JSON.stringify(data.subscription, null, 2));

                    // 3. Deactivate old active licenses
                    const deactivated = await prisma.license.updateMany({
                        where: { organisationId: orgId, status: 'active' },
                        data: { status: 'cancelled', cancelledAt: new Date() }
                    });
                    console.log(`[updateOrganisationAdmin] Deactivated ${deactivated.count} old active licenses`);

                    // 4. Create New License
                    const newLicense = await prisma.license.create({
                        data: {
                            organisationId: orgId,
                            planId: plan.id,
                            status: 'active',
                            startDate: new Date(),
                            endDate: new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000),
                            maxUsers: plan.maxUsers,
                            autoRenew: true
                        }
                    });
                    console.log(`[updateOrganisationAdmin] Created new license: ${newLicense.id}`);
                }
            }
            // Always clean up planId from data intended for Organisation model update
            delete data.planId;
        }

        console.log('[updateOrganisationAdmin] Final data for prisma.organisation.update:', JSON.stringify(data, null, 2));
        const organisation = await prisma.organisation.update({
            where: { id: orgId },
            data: data
        });

        console.log('[updateOrganisationAdmin] Organisation updated successfully');

        // Audit Log
        try {
            console.log('[updateOrganisationAdmin] Creating audit log...');
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: organisation.id,
                actorId: (req as any).user.id,
                action: 'UPDATE_ORGANISATION',
                entity: 'Organisation',
                entityId: organisation.id,
                details: { updatedFields: Object.keys(data) }
            });
            console.log('[updateOrganisationAdmin] Audit log created');
        } catch (e) {
            console.error('[updateOrganisationAdmin] Audit Log Error:', e);
        }

        res.json(organisation);
    } catch (error) {
        console.error('[updateOrganisationAdmin] Caught error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// Suspend organisation
export const suspendOrganisation = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const organisation = await prisma.organisation.update({
            where: { id: req.params.id },
            data: {
                status: 'suspended',
                subscription: { status: 'cancelled' }
            }
        });

        // Cancel all licenses
        await prisma.license.updateMany({
            where: { organisationId: organisation.id },
            data: { status: 'cancelled', cancelledAt: new Date() }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: organisation.id,
                actorId: (req as any).user.id,
                action: 'SUSPEND_ORGANISATION',
                entity: 'Organisation',
                entityId: organisation.id
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({ message: 'Organisation suspended', organisation });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get organisation stats (Super Admin)
export const getOrganisationStats = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const now = new Date();
        const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));

        const [totalOrgs, activeOrgs, suspendedOrgs, totalUsers, activeLicenses, newOrgsLast30Days, revenue] = await Promise.all([
            prisma.organisation.count(),
            prisma.organisation.count({ where: { status: 'active' } }),
            prisma.organisation.count({ where: { status: 'suspended' } }),
            prisma.user.count({ where: { isActive: true } }),
            prisma.license.count({ where: { status: 'active' } }),
            prisma.organisation.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
            // Calculate revenue from active licenses
            prisma.license.findMany({
                where: { status: 'active' },
                include: { plan: true }
            })
        ]);

        const totalRevenue = revenue.reduce((acc, license) => acc + (license.plan?.price || 0), 0);

        // Group by Plan
        const planDistribution = await prisma.license.groupBy({
            by: ['planId'],
            where: { status: 'active' },
            _count: { id: true }
        });

        // Fetch plan names
        const planIds = planDistribution.map(p => p.planId).filter(id => id !== null) as string[];
        const plans = await prisma.subscriptionPlan.findMany({ where: { id: { in: planIds } } });
        const planMap = new Map(plans.map(p => [p.id, p.name]));

        const planStats = planDistribution.map(p => ({
            name: planMap.get(p.planId!) || 'Unknown',
            count: p._count.id
        }));

        res.json({
            overview: {
                totalOrganisations: totalOrgs,
                activeOrganisations: activeOrgs,
                newOrganisations: newOrgsLast30Days,
                suspendedOrganisations: suspendedOrgs,
                totalUsers,
                activeLicenses,
                totalRevenue
            },
            planDistribution: planStats
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Reset user password (Super Admin Only)
export const resetUserPassword = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { userId, newPassword } = req.body;
        
        if (!userId || !newPassword || newPassword.length < 8) {
            return res.status(400).json({ message: 'Valid user ID and password (min 8 chars) required' });
        }

        const bcrypt = await import('bcryptjs');
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword, tokenVersion: { increment: 1 } }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            await logAudit({
                organisationId: updatedUser.organisationId || 'SYSTEM',
                actorId: (req as any).user.id,
                action: 'SUPERADMIN_RESET_PASSWORD',
                entity: 'User',
                entityId: userId,
                details: { resetBy: (req as any).user.email, targetUser: updatedUser.email }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/helper-logs
// Paginated, filterable view of HelperActivityLog rows (uploaded by the
// PypeCRM Helper / Dad-call-recorder app) across every organisation.
// Supports polling (frontend refetchInterval) for a near-real-time feed.
export const getHelperActivityLogs = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const { userId, organisationId, level, event, page = '1', limit = '50' } = req.query as Record<string, string>;
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

        const where: any = {};
        if (userId) where.userId = userId;
        if (organisationId) where.organisationId = organisationId;
        if (level) where.level = level;
        if (event) where.event = { contains: event, mode: 'insensitive' };

        const [logs, total] = await Promise.all([
            prisma.helperActivityLog.findMany({
                where,
                orderBy: { clientTimestamp: 'desc' },
                skip: (pageNum - 1) * limitNum,
                take: limitNum,
                include: {
                    user: { select: { id: true, firstName: true, lastName: true, email: true } },
                    organisation: { select: { id: true, name: true } },
                },
            }),
            prisma.helperActivityLog.count({ where }),
        ]);

        res.json({
            logs,
            pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
        });
    } catch (error) {
        console.error('getHelperActivityLogs Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/helper-logs/users
// Distinct (user, organisation) pairs that have ever uploaded a helper log —
// powers the filter dropdown without loading the full log list first.
export const getHelperActivityLogUsers = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const rows = await prisma.helperActivityLog.findMany({
            distinct: ['userId'],
            select: {
                userId: true,
                organisationId: true,
                user: { select: { firstName: true, lastName: true, email: true } },
                organisation: { select: { name: true } },
            },
            orderBy: { userId: 'asc' },
        });

        res.json({ users: rows });
    } catch (error) {
        console.error('getHelperActivityLogUsers Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

