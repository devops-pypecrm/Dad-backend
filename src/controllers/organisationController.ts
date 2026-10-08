import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { encrypt } from '../utils/encryption';
import { metaService } from '../services/metaService';
import bcrypt from 'bcryptjs';
import { logAudit } from '../utils/auditLogger';
 
const DEFAULT_LEAD_STATUSES = [
    { id: 'new', label: 'New', color: '#6366f1', isSystem: true, order: 0, isDefault: true },
    { id: 'contacted', label: 'Contacted', color: '#3b82f6', isSystem: false, order: 1 },
    { id: 'interested', label: 'Interested', color: '#10b981', isSystem: false, order: 2 },
    { id: 'qualified', label: 'Qualified', color: '#f59e0b', isSystem: false, order: 3 },
    { id: 'won', label: 'Won', color: '#10b981', isSystem: true, order: 4 },
    { id: 'lost', label: 'Lost', color: '#ef4444', isSystem: true, order: 5 }
];

const DEFAULT_OPPORTUNITY_LEAD_STATUSES = [
    { id: 'new_opportunity', label: 'New Opportunity', color: '#3b82f6', isSystem: true, order: 0, isDefault: true },
    { id: 'contacted', label: 'Contacted', color: '#f59e0b', isSystem: false, order: 1 },
    { id: 'demo_scheduled', label: 'Demo Scheduled', color: '#10b981', isSystem: false, order: 2 },
    { id: 'proposal_sent', label: 'Proposal Sent', color: '#6366f1', isSystem: false, order: 3 },
    { id: 'negotiation', label: 'Negotiation', color: '#8b5cf6', isSystem: false, order: 4 },
    { id: 'won', label: 'Won', color: '#10b981', isSystem: true, order: 5 },
    { id: 'lost', label: 'Lost', color: '#ef4444', isSystem: true, order: 6 }
];

export const createOrganisation = async (req: Request, res: Response) => {
    try {
        if ((req as any).user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Not authorized to create organisations' });
        }

        const { name, email, password, firstName, lastName } = req.body;

        // 1. Create Organisation
        const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const org = await prisma.organisation.create({
            data: {
                name,
                slug,
                contactEmail: email,
                status: 'active'
            }
        });

        // 1b. Create default Custom Product for this Organisation
        await prisma.product.create({
            data: {
                name: name, // Product name is the organisation name
                description: `Custom product for ${name}`,
                basePrice: 0,
                isCustom: true,
                isOrgProduct: true,
                organisationId: org.id,
                sku: `CUSTOM-${org.id.slice(0, 8).toUpperCase()}`
            }
        });

        // 2. Create Admin User for this Organisation
        const tempPassword = password || Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        const user = await prisma.user.create({
            data: {
                email,
                firstName,
                lastName,
                password: hashedPassword,
                role: 'admin',
                organisationId: org.id,
                isActive: true
            }
        });

        // Update org with createdBy
        await prisma.organisation.update({
            where: { id: org.id },
            data: { createdBy: user.id }
        });

        // Audit Log
        logAudit({
            action: 'CREATE_ORGANISATION',
            entity: 'Organisation',
            entityId: org.id,
            actorId: (req as any).user.id,
            organisationId: org.id,
            details: { name: org.name, slug: org.slug }
        });

        res.status(201).json({ organisation: org, adminUser: { ...user, password: undefined }, tempPassword });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getAllOrganisations = async (req: Request, res: Response) => {
    try {
        if ((req as any).user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const organisations = await prisma.organisation.findMany({
            orderBy: { createdAt: 'desc' }
        });

        // Get user counts for each organisation
        const orgIds = organisations.map(o => o.id);
        const userCounts = await prisma.user.groupBy({
            by: ['organisationId'],
            where: { organisationId: { in: orgIds }, isActive: true },
            _count: { id: true }
        });

        const countMap = new Map(userCounts.map(u => [u.organisationId, u._count.id]));

        const result = organisations.map(org => ({
            ...org,
            userCount: countMap.get(org.id) || 0
        }));

        res.json(result);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getOrganisation = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        let orgId = getOrgId(user);

        // If super admin and requesting specific org via param
        if (user.role === 'super_admin' && req.params.id) {
            orgId = req.params.id;
        }

        if (!orgId) {
            // Super admin without own org and no id param
            if (user.role === 'super_admin') {
                return res.json({ message: 'Superadmin account', isSuperAdmin: true });
            }
            return res.status(404).json({ message: 'Organisation not found' });
        }

        const org = await prisma.organisation.findUnique({
            where: { id: orgId }
        });
        if (!org) return res.status(404).json({ message: 'Organisation not found' });
 
        // Fallback for Lead Statuses if not configured
        if (!org.leadStatuses || (Array.isArray(org.leadStatuses) && org.leadStatuses.length === 0)) {
            org.leadStatuses = DEFAULT_LEAD_STATUSES as any;
        }

        // Fallback for Opportunity Lead Statuses if not configured
        if (!org.opportunityLeadStatuses || (Array.isArray(org.opportunityLeadStatuses) && org.opportunityLeadStatuses.length === 0)) {
            org.opportunityLeadStatuses = DEFAULT_OPPORTUNITY_LEAD_STATUSES as any;
        }

        // Get active user count
        const userCount = await prisma.user.count({
            where: {
                organisationId: orgId,
                isActive: true
            }
        });

        // If super admin requesting specific org, include full details
        if (user.role === 'super_admin' && req.params.id) {
            const [users, leadCount, contactCount, accountCount, opportunityCount, wonOpportunities, activeLicense] = await Promise.all([
                prisma.user.findMany({
                    where: { organisationId: orgId, isActive: true },
                    select: { id: true, firstName: true, lastName: true, email: true, role: true, position: true, createdAt: true, userId: true },
                    orderBy: { createdAt: 'desc' }
                }),
                prisma.lead.count({ where: { organisationId: orgId } }),
                prisma.contact.count({ where: { organisationId: orgId } }),
                prisma.account.count({ where: { organisationId: orgId } }),
                prisma.opportunity.count({ where: { organisationId: orgId } }),
                prisma.opportunity.aggregate({
                    where: { organisationId: orgId, stage: 'closed_won' },
                    _sum: { amount: true }
                }),
                prisma.license.findFirst({
                    where: { organisationId: orgId, status: { in: ['active', 'trial'] } },
                    include: { plan: true }
                })
            ]);

            return res.json({
                organisation: org,
                users,
                activeLicense,
                stats: {
                    userCount: users.length,
                    leadCount,
                    contactCount,
                    accountCount,
                    opportunityCount,
                    totalRevenue: wonOpportunities._sum.amount || 0
                }
            });
        }

        // Return org with userCount for normal users
        const isStaff = user.role === 'admin' || user.role === 'super_admin';
        const sanitizedOrg = { ...org };

        // Security: Remove sensitive integration details for non-admins
        if (!isStaff) {
            if (sanitizedOrg.integrations) {
                const integrations = { ...(sanitizedOrg.integrations as any) };
                if (integrations.meta) integrations.meta.accessToken = '[HIDDEN]';
                if (integrations.whatsapp) integrations.whatsapp.token = '[HIDDEN]';
                if (integrations.gallabox) {
                    integrations.gallabox.apiKey = '[HIDDEN]';
                    integrations.gallabox.apiSecret = '[HIDDEN]';
                }
                sanitizedOrg.integrations = integrations;
            }
        }

        console.log(`[getOrganisation] Responding for ${org.name}: userCount=${userCount}, userLimit=${sanitizedOrg.userLimit}`);
        res.json({ organisation: sanitizedOrg, userCount });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateOrganisation = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        let orgId = getOrgId(user);

        if (user.role === 'super_admin' && req.params.id) {
            orgId = req.params.id;
        }

        if (!orgId) return res.status(404).json({ message: 'Organisation not found' });

        const data = { ...req.body };

        // Handle Meta Token Exchange
        if (data.integrations?.meta?.accessToken && data.integrations?.meta?.connected) {
            try {
                // If it's not already encrypted (3 parts), try exchanging and always encrypt the result
                const currentToken = data.integrations.meta.accessToken;
                const isEncrypted = currentToken.split(':').length === 3;

                if (!isEncrypted) {
                    const exchangeResult = await metaService.exchangeForLongLivedToken(
                        currentToken,
                        data.integrations.meta
                    );
                    data.integrations.meta.accessToken = encrypt(exchangeResult.accessToken);
                    if (exchangeResult.expiresAt) {
                        data.integrations.meta.tokenExpiresAt = exchangeResult.expiresAt;
                    }
                }
            } catch (error) {
                console.error('Error exchanging Meta token:', error);
                // If exchange fails but we have a plain token, still encrypt it
                if (data.integrations.meta.accessToken.split(':').length !== 3) {
                    data.integrations.meta.accessToken = encrypt(data.integrations.meta.accessToken);
                }
            }
        }

        // Encrypt manual CAPI token if provided
        if (data.integrations?.meta?.capiToken && data.integrations.meta.capiToken.split(':').length !== 3) {
            data.integrations.meta.capiToken = encrypt(data.integrations.meta.capiToken);
        }

        if (Array.isArray(data.integrations?.metaAccounts)) {
            data.integrations.metaAccounts = data.integrations.metaAccounts.map((acc: any) => {
                if (acc.capiToken && acc.capiToken.split(':').length !== 3) {
                    return { ...acc, capiToken: encrypt(acc.capiToken) };
                }
                return acc;
            });
        }
        
        // Handle Gallabox Credential Encryption
        if (data.integrations?.gallabox?.connected) {
            const gallabox = data.integrations.gallabox;
            
            if (gallabox.apiKey && gallabox.apiKey.split(':').length !== 3) {
                data.integrations.gallabox.apiKey = encrypt(gallabox.apiKey);
            }
            
            if (gallabox.apiSecret && gallabox.apiSecret.split(':').length !== 3) {
                data.integrations.gallabox.apiSecret = encrypt(gallabox.apiSecret);
            }
        }

        // Handle Plan Assignment checks
        if ('planId' in data) {
            if (data.planId) {
                const plan = await prisma.subscriptionPlan.findUnique({ where: { id: data.planId } });
                if (!plan) throw new Error('Invalid Plan ID');

                // 1. Update Org Limits based on Plan
                data.userLimit = plan.maxUsers;
                data.status = 'active'; // Activate org if plan assignment happens

                // 2. Legacy Subscription JSON sync
                const existingSubscription = (await prisma.organisation.findUnique({ where: { id: orgId } }))?.subscription as any || {};
                data.subscription = {
                    ...existingSubscription,
                    status: 'active',
                    plan: plan.name,
                    planId: plan.id,
                    startDate: new Date(),
                    endDate: new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000)
                };

                // 3. Deactivate old active licenses
                await prisma.license.updateMany({
                    where: { organisationId: orgId, status: 'active' },
                    data: { status: 'cancelled', cancelledAt: new Date() }
                });

                // 4. Create New License
                await prisma.license.create({
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
            }
            // Clean up planId from data intended for Organisation model update
            delete data.planId;
        }

        const org = await prisma.organisation.update({
            where: { id: orgId },
            data: {
                ...data,
                // Ensure currency is allowed if passed
                currency: data.currency
            }
        });

        // Audit Log
        logAudit({
            action: 'UPDATE_ORGANISATION',
            entity: 'Organisation',
            entityId: org.id,
            actorId: user.id,
            organisationId: org.id,
            details: { updatedFields: Object.keys(data) }
        });

        res.json({ organisation: org });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteOrganisation = async (req: Request, res: Response) => {
    try {
        if ((req as any).user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const orgId = req.params.id;
        const org = await prisma.organisation.findUnique({
            where: { id: orgId }
        });

        if (!org) {
            return res.status(404).json({ message: 'Organisation not found' });
        }

        // Prevent Super Admin from deleting their own organisation
        const userOrgId = getOrgId((req as any).user);
        if (userOrgId === orgId) {
            return res.status(400).json({ message: 'You cannot delete your own organisation' });
        }

        // SOFT DELETE
        await prisma.organisation.update({
            where: { id: orgId },
            data: {
                isDeleted: true,
                updatedAt: new Date()
            }
        });

        // Also soft delete all users in the organisation to prevent login
        await prisma.user.updateMany({
            where: { organisationId: orgId },
            data: { isActive: false }
        });

        // Audit Log
        logAudit({
            action: 'SOFT_DELETE_ORGANISATION',
            entity: 'Organisation',
            entityId: orgId,
            actorId: (req as any).user.id,
            organisationId: orgId,
            details: {
                name: org.name,
                note: 'Organisation soft deleted - data preserved for recovery'
            }
        });

        res.json({
            message: 'Organisation marked as deleted (data preserved for recovery)',
            canRestore: true,
            deletedAt: new Date()
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const restoreOrganisation = async (req: Request, res: Response) => {
    try {
        if ((req as any).user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const orgId = req.params.id;
        const org = await prisma.organisation.findUnique({
            where: { id: orgId }
        });

        if (!org) {
            return res.status(404).json({ message: 'Organisation not found' });
        }

        if (!org.isDeleted) {
            return res.status(400).json({ message: 'Organisation is not deleted' });
        }

        // Restore the organisation
        await prisma.organisation.update({
            where: { id: orgId },
            data: {
                isDeleted: false,
                updatedAt: new Date()
            }
        });

        // Reactivate all users in the organisation
        await prisma.user.updateMany({
            where: { organisationId: orgId },
            data: { isActive: true }
        });

        // Audit Log
        logAudit({
            action: 'RESTORE_ORGANISATION',
            entity: 'Organisation',
            entityId: orgId,
            actorId: (req as any).user.id,
            organisationId: orgId,
            details: {
                name: org.name,
                note: 'Organisation restored from soft delete'
            }
        });

        res.json({
            message: 'Organisation restored successfully',
            restoredAt: new Date()
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const sendTestReport = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(404).json({ message: 'Organisation not found' });

        const org = await prisma.organisation.findFirst({
            where: { id: orgId },
            include: {
                users: {
                    where: { id: user.id }
                }
            }
        });

        if (!org) return res.status(404).json({ message: 'Organisation not found' });

        const { ReportingService } = await import('../services/reportingService');
        const { WhatsAppService } = await import('../services/whatsAppService');

        const stats = await ReportingService.getDailyStats(orgId);
        const report = ReportingService.formatWhatsAppReport(stats, org.name);

        const targetPhone = org.users[0]?.phone || org.contactPhone;

        if (!targetPhone) {
            return res.status(400).json({ message: 'No phone number configured for report' });
        }

        const waClient = await WhatsAppService.getClientForOrg(orgId);
        if (waClient && targetPhone) {
            await waClient.sendTextMessage(targetPhone, report);
        }

        // Send Email if enabled
        const targetEmail = org.contactEmail || user.email;
        if (org.dailyReportEmailEnabled && targetEmail) {
            const { EmailService } = await import('../services/emailService');
            const emailHtml = ReportingService.formatEmailReport(stats, org.name);
            await EmailService.sendEmail(
                targetEmail,
                `Test Daily Business Report - ${org.name}`,
                emailHtml,
                orgId
            );
        }

        // Gupshup daily business summary — same always-on-if-Contact-Phone-is-set behavior as the cron job
        if (org.contactPhone) {
            try {
                const { gupshupService, sendDailySummaryViaGupshup } = await import('../services/gupshupService');
                if (gupshupService.isConfigured()) {
                    await sendDailySummaryViaGupshup(orgId, org.name, org.contactPhone);
                }
            } catch (gupshupError) {
                console.error('sendTestReport Gupshup Error:', gupshupError);
            }
        }

        res.json({ message: `Test report sent`, stats });
    } catch (error) {
        console.error('sendTestReport Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * Permanently delete an organisation and all its data
 * SUPER ADMIN ONLY - This is irreversible!
 */
export const permanentlyDeleteOrganisation = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;

        // Only super admin can permanently delete
        if (user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Only super admins can permanently delete organisations' });
        }

        const orgId = req.params.id;

        // Verify organisation exists
        const org = await prisma.organisation.findUnique({
            where: { id: orgId },
            include: {
                _count: {
                    select: {
                        users: true,
                        leads: true,
                        products: true,
                        tasks: true
                    }
                }
            }
        });

        if (!org) {
            return res.status(404).json({ message: 'Organisation not found' });
        }

        // Prevent super admin from deleting their own organisation
        const userOrgId = getOrgId(user);
        if (userOrgId === orgId) {
            return res.status(400).json({ message: 'You cannot delete your own organisation' });
        }

        // Require confirmation parameter
        const { confirm } = req.body;
        if (confirm !== 'PERMANENTLY_DELETE') {
            return res.status(400).json({
                message: 'Confirmation required',
                instruction: 'Send { "confirm": "PERMANENTLY_DELETE" } in request body to proceed',
                warning: 'This will permanently delete all data including users, leads, products, and tasks',
                dataToBeDeleted: {
                    organisation: org.name,
                    users: org._count.users,
                    leads: org._count.leads,
                    products: org._count.products,
                    tasks: org._count.tasks
                }
            });
        }

        console.log(`⚠️  PERMANENT DELETE STARTED: Organisation "${org.name}" (${orgId}) by ${user.email}`);

        // Get all user IDs to handle cross-references
        const userIds = await prisma.user.findMany({
            where: { organisationId: orgId },
            select: { id: true }
        });

        const userIdList = userIds.map(u => u.id);

        /**
         * 1. DELETE JUNCTION TABLES AND SECONDARY CHILDREN
         * These must be deleted first as they depend on main entities.
         */

        // Lead junctions
        await prisma.leadProduct.deleteMany({ where: { lead: { organisationId: orgId } } });
        await prisma.leadHistory.deleteMany({ where: { lead: { organisationId: orgId } } });

        // Quote junctions  
        await prisma.quoteLineItem.deleteMany({ where: { quote: { organisationId: orgId } } });

        // User junctions/secondary data
        await prisma.searchHistory.deleteMany({ where: { userId: { in: userIdList } } });
        await prisma.userLeadQuotaTracker.deleteMany({ where: { userId: { in: userIdList } } });

        // Account products
        await prisma.accountProduct.deleteMany({ where: { organisationId: orgId } });

        // Product shares
        await prisma.productShare.deleteMany({ where: { organisationId: orgId } });

        /**
         * 2. DELETE MAIN ENTITIES LINKED TO ORG
         */

        // CRM Core
        await prisma.interaction.deleteMany({ where: { organisationId: orgId } });
        await prisma.opportunity.deleteMany({ where: { organisationId: orgId } });
        await prisma.lead.deleteMany({ where: { organisationId: orgId } });
        await prisma.contact.deleteMany({ where: { organisationId: orgId } });
        await prisma.account.deleteMany({ where: { organisationId: orgId } });
        await prisma.task.deleteMany({ where: { organisationId: orgId } });

        // Sales & Marketing
        await prisma.quote.deleteMany({ where: { organisationId: orgId } });
        await prisma.product.deleteMany({ where: { organisationId: orgId } });
        await prisma.salesTarget.deleteMany({ where: { organisationId: orgId } });
        await prisma.commission.deleteMany({ where: { organisationId: orgId } });
        await prisma.goal.deleteMany({ where: { organisationId: orgId } });
        await prisma.campaign.deleteMany({ where: { organisationId: orgId } });
        await prisma.landingPage.deleteMany({ where: { organisationId: orgId } });
        await prisma.webForm.deleteMany({ where: { organisationId: orgId } });
        await prisma.emailList.deleteMany({ where: { organisationId: orgId } });

        // Support & Communication
        await prisma.case.deleteMany({ where: { organisationId: orgId } });
        await prisma.callSettings.deleteMany({ where: { organisationId: orgId } });
        await prisma.whatsAppMessage.deleteMany({ where: { organisationId: orgId } });
        await prisma.whatsAppCampaign.deleteMany({ where: { organisationId: orgId } });
        await prisma.sMSCampaign.deleteMany({ where: { organisationId: orgId } });
        await prisma.webhook.deleteMany({ where: { organisationId: orgId } });
        await prisma.checkIn.deleteMany({ where: { organisationId: orgId } });

        // Infrastructure & Workspace
        await prisma.workflowRule.deleteMany({ where: { organisationId: orgId } });
        await prisma.workflowQueue.deleteMany({ where: { organisationId: orgId } });
        await prisma.workflow.deleteMany({ where: { organisationId: orgId } });
        await prisma.pipeline.deleteMany({ where: { organisationId: orgId } });
        await prisma.calendarEvent.deleteMany({ where: { organisationId: orgId } });
        await prisma.document.deleteMany({ where: { organisationId: orgId } });
        await prisma.team.deleteMany({ where: { organisationId: orgId } });
        await prisma.territory.deleteMany({ where: { organisationId: orgId } });
        await prisma.customField.deleteMany({ where: { organisationId: orgId } });
        await prisma.apiKey.deleteMany({ where: { organisationId: orgId } });
        await prisma.assignmentRule.deleteMany({ where: { organisationId: orgId } });
        await prisma.importJob.deleteMany({ where: { organisationId: orgId } });
        await prisma.license.deleteMany({ where: { organisationId: orgId } });

        // 3. System Logs for this org
        await prisma.notification.deleteMany({ where: { recipientId: { in: userIdList } } });
        await prisma.auditLog.deleteMany({ where: { organisationId: orgId } });

        // 4. Delete Users
        await prisma.user.deleteMany({ where: { organisationId: orgId } });

        // 5. Finally delete the Organisation
        await prisma.organisation.delete({ where: { id: orgId } });

        // 6. Audit Log (Logged AFTER successful deletion with 'system' org)
        await logAudit({
            action: 'PERMANENT_DELETE_ORGANISATION',
            entity: 'Organisation',
            entityId: orgId,
            actorId: user.id,
            organisationId: 'system',
            details: {
                name: org.name,
                deletedUsersCount: userIdList.length,
                warning: 'PERMANENT DELETION SUCCESSFUL'
            }
        });

        console.log(`✅  PERMANENT DELETE SUCCESSFUL: "${org.name}"`);

        res.json({
            message: 'Organisation permanently deleted',
            deletedData: {
                organisation: org.name,
                users: org._count.users,
                leads: org._count.leads,
                products: org._count.products,
                tasks: org._count.tasks
            }
        });
    } catch (error) {
        console.error('Permanent delete error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
