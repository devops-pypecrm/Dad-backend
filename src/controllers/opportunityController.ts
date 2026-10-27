import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId, getSubordinateIds, getVisibleUserIds, getOppVisibilityFilter } from '../utils/hierarchyUtils';
import { Prisma } from '../generated/client';
import { NotificationService } from '../services/notificationService';

// GET /api/opportunities
export const getOpportunities = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string || '1');
        const limit = parseInt(req.query.limit as string || '1000');
        const skip = (page - 1) * limit;

        const user = (req as any).user;
        const where: Prisma.OpportunityWhereInput = { isDeleted: false };

        // 1. Organisation Scoping
        if (user.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = String(req.query.organisationId);
            }
        } else {
            const orgId = getOrgId(user);
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
            // Branch filtering should be handled by visibility logic or explicit query params
            if (req.query.branchId) where.branchId = String(req.query.branchId);
        }

        // 2. Hierarchy Visibility
        if (user.role !== 'super_admin' && user.role !== 'admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);
            // If explicit ownerId is requested, ensure it's within visible range
            if (req.query.ownerId && visibleUserIds.includes(String(req.query.ownerId))) {
                where.ownerId = String(req.query.ownerId);
            } else {
                // Restricting on ownerId alone misses opportunities that are tagged to a
                // branch this user manages but happen to be owned by someone outside
                // their reporting chain (e.g. an org admin who entered/owns a deal
                // directly, with no branchId of their own on their user record) -
                // getVisibleUserIds only includes people whose OWN branchId matches a
                // managed branch, which doesn't catch that case. A branch manager
                // filtering their own branch should see every deal in it regardless of
                // who owns it, same as Lead's manager-branch-orphan carve-out.
                const managedBranches = await prisma.branch.findMany({
                    where: { managerId: user.id, isDeleted: false },
                    select: { id: true }
                });
                const managedBranchIds = managedBranches.map(b => b.id);

                if (managedBranchIds.length > 0) {
                    // AND-combined, not assigned to where.OR directly - the `search`
                    // filter below also assigns to where.OR, which would otherwise
                    // silently overwrite (not combine with) this visibility scoping,
                    // the same bug already found and fixed in caseController.getCases.
                    if (!where.AND) where.AND = [];
                    (where.AND as any[]).push({
                        OR: [
                            { ownerId: { in: visibleUserIds } },
                            { branchId: { in: managedBranchIds } }
                        ]
                    });
                } else {
                    where.ownerId = { in: visibleUserIds };
                }
            }
        } else if (req.query.ownerId) {
            where.ownerId = String(req.query.ownerId);
        }

        // Lightweight count-only mode for the web app's "Showing X of Y" indicator —
        // same org/visibility scoping as the full list above, none of the dynamic
        // filters below, and skips findMany entirely.
        if (req.query.countOnly === 'true') {
            const defaultTotal = await prisma.opportunity.count({ where });
            return res.json({ total: defaultTotal });
        }

        // 3. Dynamic Filters
        if (req.query.stage && req.query.stage !== 'all') {
            if (req.query.stage === 'expected') {
                where.stage = { in: ['prospecting', 'qualification', 'proposal', 'negotiation'] } as any;
            } else {
                where.stage = String(req.query.stage) as any;
            }
        }
        if (req.query.type && req.query.type !== 'all') {
            where.type = String(req.query.type) as any;
        }
        if (req.query.search) {
            // AND-combined, not a direct where.OR assignment - see comment above on the
            // hierarchy visibility block for why that matters.
            if (!where.AND) where.AND = [];
            (where.AND as any[]).push({
                OR: [
                    { name: { contains: String(req.query.search), mode: 'insensitive' } },
                    { description: { contains: String(req.query.search), mode: 'insensitive' } }
                ]
            });
        }
        if (req.query.leadSource && req.query.leadSource !== 'all') {
            where.leadSource = String(req.query.leadSource);
        }

        // Date Range Filters
        if (req.query.startDate || req.query.endDate) {
            const dateFilter: any = {};
            if (req.query.startDate) {
                dateFilter.gte = new Date(String(req.query.startDate));
            }
            if (req.query.endDate) {
                const end = new Date(String(req.query.endDate));
                // UTC-explicit, matching analyticsController.ts's getDateFilter —
                // this list is the tap-through target for the Dashboard's Won/Lost
                // tiles, which compute their end-of-day boundary via setUTCHours.
                // Using local setHours here made the two agree only by accident
                // (only when the server process itself happens to run in UTC);
                // on any other server TZ (or a dev machine running the backend
                // locally in IST) it silently shifted this list's cutoff by the
                // offset, so a deal counted by the tile could vanish from the
                // list it links to.
                end.setUTCHours(23, 59, 59, 999);
                dateFilter.lte = end;
            }
            // For closed deals, "this month" means "closed this month" — matches the
            // Dashboard's Won/Lost tiles (getDashboardStats filters closed opportunities
            // by closeDate). Filtering by createdAt here instead caused deals created in
            // one month but closed in another to silently disappear from the very list
            // the dashboard tile links to, showing a different count than the tile.
            // Non-closed stages keep filtering by createdAt (closeDate is often null/future
            // for those, e.g. this page's own All Time/This Month/Last Month browsing filter).
            //
            // The "expected" pipeline view is the one exception: it's a live snapshot of
            // everything currently open, not a per-period slice — a deal opened in an
            // earlier month that's still open ("carried forward") is still part of today's
            // pipeline. Filtering it by createdAt hid those deals whenever a date range
            // was applied (e.g. the Dashboard's "Pipeline" tile deep-links here with the
            // current month range), which is exactly what getExpectedRevenueReport already
            // avoids by never date-filtering its own open-deals query.
            const stage = req.query.stage ? String(req.query.stage) : '';
            if (stage === 'closed_won' || stage === 'closed_lost') {
                where.closeDate = dateFilter;
            } else if (stage !== 'expected') {
                where.createdAt = dateFilter;
            }
        }

        // Add filters if needed (e.g. stage, etc.) based on query params if standard match Mongoose behavior which passed `query` directly sometimes?
        // Mongoose code had `const query: any = {}` and populated it manually.
        // It didn't seemingly blindly pass req.query to find()? 
        // Ah, checked code: it only set org and owner. 
        // But implicitly if Mongoose `find(query)` was used, maybe other params were assumed?
        // No, lines 16-25 constructed query.
        // So strict filtering.
        // I'll stick to strict.

        const count = await prisma.opportunity.count({ where });
        const opportunities = await prisma.opportunity.findMany({
            where,
            include: {
                account: { select: { name: true } },
                owner: { select: { id: true, firstName: true, lastName: true, profileImage: true } },
                branch: { select: { name: true } },
                emiSchedule: { select: { id: true, status: true } },
                lead: { select: { id: true, firstName: true, lastName: true, status: true } }
            },
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            opportunities,
            page,
            totalPages: Math.ceil(count / limit),
            totalOpportunities: count
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/opportunities
export const createOpportunity = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'Organisation context required' });

        // Validate required fields
        if (!req.body.account) {
            return res.status(400).json({ message: 'Account is required to create an opportunity' });
        }

        let leadStatus = req.body.leadStatus;
        if (!leadStatus) {
            const org = await prisma.organisation.findUnique({
                where: { id: orgId },
                select: { opportunityLeadStatuses: true }
            });
            if (org?.opportunityLeadStatuses && Array.isArray(org.opportunityLeadStatuses)) {
                const statuses = org.opportunityLeadStatuses as any[];
                const configuredDefault = statuses.find((s) => s.isDefault);
                if (configuredDefault) {
                    leadStatus = configuredDefault.id;
                } else if (statuses.length > 0) {
                    leadStatus = statuses[0].id;
                }
            }
            if (!leadStatus) leadStatus = 'new_opportunity';
        }

        const opportunityData: Prisma.OpportunityCreateInput = {
            name: req.body.name,
            amount: Number(req.body.amount),
            stage: req.body.stage,
            probability: req.body.probability,
            closeDate: req.body.closeDate ? new Date(req.body.closeDate) : null,
            leadSource: req.body.leadSource,
            description: req.body.description,
            customFields: req.body.customFields,
            tags: req.body.tags,
            type: req.body.type || 'NEW_BUSINESS', // Default
            leadStatus,

            organisation: { connect: { id: orgId } },
            owner: { connect: { id: user.id } },
            branch: user.branchId ? { connect: { id: user.branchId } } : (req.body.branchId ? { connect: { id: req.body.branchId } } : undefined),

            // Account is required in schema
            account: { connect: { id: req.body.account } }
        };

        // Custom Field Validation
        if (req.body.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Opportunity', orgId, req.body.customFields);
        }

        const opportunity = await prisma.opportunity.create({
            data: opportunityData
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_OPPORTUNITY',
                entity: 'Opportunity',
                entityId: opportunity.id,
                actorId: user.id,
                organisationId: orgId,
                details: { name: opportunity.name, amount: opportunity.amount, type: opportunity.type }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(opportunity);

        // Webhook
        import('../services/webhookService').then(({ WebhookService }) => {
            WebhookService.triggerEvent('opportunity.created', opportunity, orgId).catch(console.error);
        });

        // Trigger Sales Target Update if created as closed_won
        if (opportunity.stage === 'closed_won' && opportunity.ownerId) {
            // New logic for payment and EMI
            const { paymentType, paidAmount, installments } = req.body;
            const oppId = opportunity.id;

            if (paymentType === 'paid') {
                import('../services/paymentService').then(m => m.default.recordFullPayment(oppId, user.id, orgId).catch(console.error));
            } else if (paymentType === 'partial') {
                import('../services/paymentService').then(async m => {
                    if (paidAmount > 0) {
                        await m.default.recordPartialPayment(oppId, paidAmount, user.id, orgId);
                    }
                    if (installments && installments.length > 0) {
                        const { default: EMIService } = await import('../services/emiService');
                        await EMIService.convertToEMI(oppId, installments, orgId);
                    }
                });
            } else if (paymentType === 'emi') {
                (async () => {
                    try {
                        // First update payment status
                        await prisma.opportunity.update({
                            where: { id: oppId },
                            data: { paymentStatus: 'partial' }
                        });

                        // Then convert to EMI
                        if (installments && installments.length > 0) {
                            const { default: EMIService } = await import('../services/emiService');
                            await EMIService.convertToEMI(oppId, installments, orgId);
                        }
                    } catch (error) {
                        console.error('Error in EMI conversion:', error);
                    }
                })();
            }

            import('../services/salesTargetService').then(({ SalesTargetService }) => {
                SalesTargetService.updateProgressForUser(opportunity.ownerId!).catch(console.error);
            });
            import('../services/goalService').then(({ GoalService }) => {
                GoalService.updateProgressForUser(opportunity.ownerId!, 'revenue').catch(console.error);
            });

            // Meta Conversion API: Purchase
            if (req.body.amount && opportunity.amount > 0) {
                import('../services/metaConversionService').then(({ MetaConversionService }) => {
                    MetaConversionService.sendEvent(orgId, {
                        eventName: 'Purchase',
                        userData: { externalId: user.id },
                        customData: {
                            value: opportunity.amount,
                            currency: 'INR',
                            contentName: opportunity.name
                        }
                    }).catch(console.error);
                });
            }

            // Hierarchy Notification on Sale Closure with Payment
            try {
                const { paymentType, paidAmount } = req.body;

                // Only send notification if payment is recorded
                if (paymentType && (paymentType === 'paid' || paymentType === 'partial' || paymentType === 'emi')) {
                    const owner = await prisma.user.findUnique({
                        where: { id: opportunity.ownerId! },
                        select: { reportsToId: true, firstName: true, lastName: true }
                    });

                    if (owner && owner.reportsToId) {
                        let paymentMessage = '';
                        if (paymentType === 'paid') {
                            paymentMessage = `Full payment of ₹${opportunity.amount.toLocaleString('en-IN')} received.`;
                        } else if (paymentType === 'partial') {
                            paymentMessage = `Partial payment of ₹${paidAmount?.toLocaleString('en-IN')} received (Total: ₹${opportunity.amount.toLocaleString('en-IN')}).`;
                        } else if (paymentType === 'emi') {
                            paymentMessage = `EMI payment plan initiated for ₹${opportunity.amount.toLocaleString('en-IN')}.`;
                        }

                        await NotificationService.sendToHierarchy(
                            opportunity.ownerId!,
                            'Sale Closed with Payment! 🎉💰',
                            `${owner.firstName} ${owner.lastName} closed a deal "${opportunity.name}". ${paymentMessage}`,
                            'success'
                        );
                    }
                }
            } catch (notifyErr) {
                console.error('Hierarchy notification error:', notifyErr);
            }
        }
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const getOpportunityById = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        const where: any = { id: req.params.id, isDeleted: false };
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
            // Removed strict branchId check to allow cross-branch visibility via hierarchy

            // The list endpoint (getOpportunities) already restricts non-admins to their
            // own hierarchy's opportunities — this direct-by-ID lookup was missing that
            // same check, so anyone in the org could view any other rep's deal (including
            // amount/payment info) just by knowing or guessing the opportunity ID.
            if (user.role !== 'admin') {
                const visibilityFilter = await getOppVisibilityFilter(user, user.isSuperAdmin);
                Object.assign(where, visibilityFilter);
            }
        }

        const opportunity = await prisma.opportunity.findFirst({
            where,
            include: {
                account: {
                    select: {
                        name: true,
                        accountProducts: {
                            include: {
                                product: true
                            },
                            orderBy: {
                                createdAt: 'desc'
                            }
                        }
                    }
                },
                owner: { select: { id: true, firstName: true, lastName: true, profileImage: true, email: true } },
                contacts: true,
                lead: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        status: true,
                        assignedTo: {
                            select: {
                                id: true,
                                firstName: true,
                                lastName: true,
                                profileImage: true,
                                email: true
                            }
                        }
                    }
                },
                emiSchedule: {
                    include: {
                        installments: {
                            orderBy: { installmentNumber: 'asc' }
                        }
                    }
                },
                paymentRecords: {
                    orderBy: { paymentDate: 'desc' }
                }
            }
        });

        if (!opportunity) return res.status(404).json({ message: 'Opportunity not found' });
        res.json(opportunity);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateOpportunity = async (req: Request, res: Response) => {
    try {
        const updates = { ...req.body };
        const oppId = req.params.id;

        // Extract payment-related fields that are not part of the Opportunity model
        const { paymentType, paidAmount, installments, ...opportunityUpdates } = updates;

        // Handle Relation Updates
        if (opportunityUpdates.account && typeof opportunityUpdates.account === 'string') {
            opportunityUpdates.account = { connect: { id: opportunityUpdates.account } };
        }
        if (opportunityUpdates.owner && typeof opportunityUpdates.owner === 'string') {
            opportunityUpdates.owner = { connect: { id: opportunityUpdates.owner } };
        }
        
        // Parse closeDate string to Date object
        if (opportunityUpdates.closeDate !== undefined) {
            opportunityUpdates.closeDate = opportunityUpdates.closeDate ? new Date(opportunityUpdates.closeDate) : null;
        }

        // Fetch first for validation and existence
        const currentOpp = await prisma.opportunity.findUnique({ where: { id: oppId } });
        if (!currentOpp) return res.status(404).json({ message: 'Opportunity not found' });

        // Add validation to prevent moving out of terminal stages
        const isClosingNow = opportunityUpdates.stage && opportunityUpdates.stage !== currentOpp.stage &&
            (opportunityUpdates.stage === 'closed_won' || opportunityUpdates.stage === 'closed_lost');
        if (opportunityUpdates.stage && opportunityUpdates.stage !== currentOpp.stage) {
            if (currentOpp.stage === 'closed_won' || currentOpp.stage === 'closed_lost') {
                return res.status(400).json({
                    message: `Opportunity is already ${currentOpp.stage === 'closed_won' ? 'Won' : 'Lost'} and cannot be moved to another stage.`
                });
            }
        }

        // closeDate is what every dashboard/report actually filters "deals closed in
        // [month]" by, so it needs to reflect when the deal was ACTUALLY closed — not
        // whenever it happened to be converted/created. None of the closing UIs (Kanban
        // drag, Close Won/Lost dialogs) send a closeDate, so without this the field stayed
        // frozen at creation time forever, misattributing the close to the wrong month.
        // Only fills in when the caller didn't explicitly provide one, so an intentional
        // backdated closeDate is still respected.
        if (isClosingNow && opportunityUpdates.closeDate === undefined) {
            opportunityUpdates.closeDate = new Date();
        }

        // Same idea for leadStatus: none of the closing UIs (Kanban drag → Close Won/Lost
        // dialogs) send it, so it stayed stuck at whatever it was before closing (e.g.
        // "New Opportunity") even on a deal that's now actually Won/Lost — misleading on
        // the Kanban card. Only fills in when not explicitly provided, so an intentional
        // custom leadStatus on close is still respected.
        if (isClosingNow && opportunityUpdates.leadStatus === undefined) {
            opportunityUpdates.leadStatus = opportunityUpdates.stage === 'closed_won' ? 'won' : 'lost';
        }

        if (opportunityUpdates.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Opportunity', currentOpp.organisationId, opportunityUpdates.customFields);
        }

        const requester = (req as any).user;
        const whereObj: any = { id: oppId };
        if (requester.role !== 'super_admin') {
            const orgId = getOrgId(requester);
            if (!orgId) return res.status(403).json({ message: 'No org' });
            whereObj.organisationId = orgId;
            // Removed strict branchId check for cross-branch updates

            // Same hierarchy scoping as the read/list endpoints — without this, any rep
            // could edit (amount, stage, owner, etc.) any other rep's opportunity just by
            // knowing its ID, regardless of whether they're allowed to even see it.
            if (requester.role !== 'admin') {
                const visibilityFilter = await getOppVisibilityFilter(requester, requester.isSuperAdmin);
                Object.assign(whereObj, visibilityFilter);
            }
        }

        const opportunity = await prisma.opportunity.update({
            where: whereObj,
            data: opportunityUpdates,
            include: {
                account: { select: { name: true } },
                owner: { select: { id: true, firstName: true, lastName: true, profileImage: true } }
            }
        });

        // Back-sync the outcome onto the originating Lead when this opportunity closes.
        // convertLead sets Lead.status to 'converted' for a still-open opportunity; once it's
        // later closed won/lost, the lead should reflect that instead of staying 'converted'.
        if (
            opportunity.leadId &&
            (opportunityUpdates.stage === 'closed_won' || opportunityUpdates.stage === 'closed_lost')
        ) {
            const newLeadStatus = opportunityUpdates.stage === 'closed_won' ? 'won' : 'lost';
            const syncedLead = await prisma.lead.findFirst({
                where: { id: opportunity.leadId, status: 'converted' },
                select: { id: true, status: true }
            });
            if (syncedLead) {
                await prisma.lead.update({
                    where: { id: syncedLead.id },
                    data: { status: newLeadStatus }
                });
                // This updateMany previously changed Lead.status with no LeadHistory
                // row at all, so any report reading LeadHistory (e.g. the Daily
                // Report's per-user Won/Lost counts) silently showed 0 for every
                // lead actually won/lost via the opportunity pipeline instead of
                // the one-step convertLead flow.
                await prisma.leadHistory.create({
                    data: {
                        leadId: syncedLead.id,
                        fieldName: 'status',
                        oldValue: syncedLead.status,
                        newValue: newLeadStatus,
                        changedById: requester?.id || null,
                        reason: `Opportunity closed as ${newLeadStatus === 'won' ? 'Won' : 'Lost'}`
                    }
                });
            }
        }

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'UPDATE_OPPORTUNITY',
                entity: 'Opportunity',
                entityId: oppId,
                actorId: requester.id,
                organisationId: opportunity.organisationId,
                details: { name: opportunity.name, updatedFields: Object.keys(updates) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        // Trigger Sales Target Update when opportunity is closed won
        if ((req.body.stage === 'closed_won' || (opportunity.stage === 'closed_won' && req.body.amount)) && opportunity.ownerId) {
            // Payment recording is AWAITED to ensure PaymentRecord rows are written before responding
            const { paymentType, paidAmount, installments } = req.body;
            const orgId = opportunity.organisationId;

            try {
                if (paymentType === 'paid') {
                    const PaymentService = (await import('../services/paymentService')).default;
                    await PaymentService.recordFullPayment(oppId, requester.id, orgId);
                } else if (paymentType === 'partial') {
                    const PaymentService = (await import('../services/paymentService')).default;
                    if (paidAmount > 0) {
                        await PaymentService.recordPartialPayment(oppId, paidAmount, requester.id, orgId);
                    }
                    if (installments && installments.length > 0) {
                        const EMIService = (await import('../services/emiService')).default;
                        await EMIService.convertToEMI(oppId, installments, orgId);
                    }
                } else if (paymentType === 'emi') {
                    // Update payment status first, then set up EMI schedule
                    await prisma.opportunity.update({
                        where: { id: oppId },
                        data: { paymentStatus: 'partial' }
                    });
                    if (installments && installments.length > 0) {
                        const EMIService = (await import('../services/emiService')).default;
                        await EMIService.convertToEMI(oppId, installments, orgId);
                    }
                }
            } catch (paymentError) {
                // Payment processing failed — roll back paymentStatus to avoid mismatch with Sales Book
                console.error('[updateOpportunity] Payment recording failed, rolling back paymentStatus:', paymentError);
                await prisma.opportunity.update({
                    where: { id: oppId },
                    data: { paymentStatus: 'pending' }
                }).catch(e => console.error('[updateOpportunity] Rollback failed:', e));
            }

            import('../services/salesTargetService').then(({ SalesTargetService }) => {
                SalesTargetService.updateProgressForUser(opportunity.ownerId!).catch(err => {
                    console.error('SalesTargetService error:', err);
                });
            }).catch(err => {
                console.error('Failed to load SalesTargetService:', err);
            });

            // Goal Automation
            import('../services/goalService').then(({ GoalService }) => {
                GoalService.updateProgressForUser(opportunity.ownerId!, 'revenue').catch(console.error);
            });

            // Meta Conversion API: Purchase
            if (req.body.amount && opportunity.amount > 0) {
                import('../services/metaConversionService').then(async ({ MetaConversionService }) => {
                    const oppWithContact = await prisma.opportunity.findUnique({
                        where: { id: oppId },
                        include: {
                            contacts: { take: 1 }
                        }
                    });

                    if (oppWithContact && oppWithContact.contacts.length > 0) {
                        const contact = oppWithContact.contacts[0];
                        const phone = (contact.phones as any)?.mobile || (contact.phones as any)?.work || '';

                        MetaConversionService.sendEvent(opportunity.organisationId, {
                            eventName: 'Purchase',
                            userData: {
                                email: contact.email,
                                phone: phone,
                                firstName: contact.firstName,
                                lastName: contact.lastName,
                                externalId: contact.id
                            },
                            customData: {
                                value: opportunity.amount,
                                currency: 'USD',
                                contentName: opportunity.name
                            },
                            actionSource: 'system_generated'
                        }).catch(console.error);
                    }
                });
            }

            // Hierarchy Notification on Sale Closure with Payment
            try {
                const { paymentType, paidAmount } = req.body;

                // Only send notification if payment is recorded
                if (paymentType && (paymentType === 'paid' || paymentType === 'partial' || paymentType === 'emi')) {
                    const owner = await prisma.user.findUnique({
                        where: { id: opportunity.ownerId! },
                        select: { reportsToId: true, firstName: true, lastName: true }
                    });

                    if (owner && owner.reportsToId) {
                        let paymentMessage = '';
                        if (paymentType === 'paid') {
                            paymentMessage = `Full payment of ₹${opportunity.amount.toLocaleString('en-IN')} received.`;
                        } else if (paymentType === 'partial') {
                            paymentMessage = `Partial payment of ₹${paidAmount?.toLocaleString('en-IN')} received (Total: ₹${opportunity.amount.toLocaleString('en-IN')}).`;
                        } else if (paymentType === 'emi') {
                            paymentMessage = `EMI payment plan initiated for ₹${opportunity.amount.toLocaleString('en-IN')}.`;
                        }

                        await NotificationService.sendToHierarchy(
                            opportunity.ownerId!,
                            'Sale Closed with Payment! 🎉💰',
                            `${owner.firstName} ${owner.lastName} closed a deal "${opportunity.name}". ${paymentMessage}`,
                            'success'
                        );
                    }
                }
            } catch (notifyErr) {
                console.error('Hierarchy notification error:', notifyErr);
            }
        }

        if (updates.stage && updates.stage !== currentOpp.stage) {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'OPPORTUNITY_STAGE_CHANGE',
                entity: 'Opportunity',
                entityId: oppId,
                actorId: requester.id,
                organisationId: currentOpp.organisationId,
                details: { name: currentOpp.name, oldStage: currentOpp.stage, newStage: updates.stage }
            });
        }

        res.json(opportunity);

        // Webhook
        import('../services/webhookService').then(({ WebhookService }) => {
            WebhookService.triggerEvent('opportunity.updated', opportunity, opportunity.organisationId).catch(console.error);
        });
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const deleteOpportunity = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const opportunityId = req.params.id;
        const orgId = getOrgId(user);

        // 1. Role Check
        if (user.role !== 'super_admin' && user.role !== 'admin' && user.role !== 'organisation_admin') {
            return res.status(403).json({ message: 'Not authorized to delete opportunities' });
        }

        const where: any = { id: opportunityId };
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
            // Removed strict branchId check for cross-branch deletion
        }

        const opportunity = await prisma.opportunity.findFirst({ where });
        if (!opportunity) return res.status(404).json({ message: 'Opportunity not found' });

        await prisma.opportunity.update({
            where: { id: opportunityId },
            data: { isDeleted: true, deletedAt: new Date() }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'DELETE_OPPORTUNITY',
                entity: 'Opportunity',
                entityId: opportunityId,
                actorId: user.id,
                organisationId: opportunity.organisationId,
                details: { name: opportunity.name }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({ message: 'Opportunity deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
