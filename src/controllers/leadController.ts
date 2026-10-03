import express from 'express';
import { emitToOrg } from '../socket';
import prisma from '../config/prisma';
import { getOrgId, getSubordinateIds, getVisibleUserIds, getLeadVisibilityFilter } from '../utils/hierarchyUtils';
import { DistributionService } from '../services/distributionService';
import { WorkflowEngine } from '../services/workflowEngine';
import { NotificationService } from '../services/notificationService';
import { LeadSource } from '../generated/client';
import { isAdmin, isSuperAdmin, isOrgAdmin } from '../utils/roleUtils';
import { GeoLocationService } from '../services/geoLocationService';
import { FollowUpService } from '../services/followUpService';
import { TaskService } from '../services/taskService';
import { GallaboxService } from '../services/gallaboxService';
import DuplicateLeadService from '../services/duplicateLeadService';
// Dynamic import used for OpenAI to avoid startup errors if missing

// Shared by the dashboard-linked lead-health list endpoints (getUnattendedLeads,
// getNoActivityLeads) below — mirrors the IST-aware createdAt date-range logic
// already inlined in getLeads, so a date range picked on the Dashboard filters
// "created within this window" consistently everywhere.
const buildCreatedAtDateFilter = (req: express.Request): { gte?: Date; lt?: Date } | null => {
    if (!req.query.startDate && !req.query.endDate) return null;
    const dateFilter: { gte?: Date; lt?: Date } = {};
    if (req.query.startDate) {
        const s = new Date(req.query.startDate as string);
        const start = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), 0, 0, 0, 0));
        start.setMinutes(start.getMinutes() - 330);
        dateFilter.gte = start;
    }
    if (req.query.endDate) {
        const e = new Date(req.query.endDate as string);
        const end = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate() + 1, 0, 0, 0, 0));
        end.setMinutes(end.getMinutes() - 330);
        dateFilter.lt = end;
    }
    return dateFilter;
};

// GET /api/leads
export const getLeads = async (req: express.Request, res: express.Response) => {
    try {
        console.log('[getLeads] Query Params:', req.query); // DEBUG LOG

        const pageSize = Number(req.query.pageSize) || 10;
        const page = Number(req.query.page) || 1;
        const user = (req as any).user;
        const where: any = { isDeleted: false };
        const andConditions: any[] = [];

        console.log('[getLeads] User:', user.id, user.role); // DEBUG LOG

        // 1. Organisation Scoping
        if (user.isSuperAdmin || isSuperAdmin(user)) {
            if (req.query.organisationId) where.organisationId = req.query.organisationId as string;
        } else {
            const orgId = getOrgId(user);
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
        }

        // 2. Hierarchy Visibility
        // Only apply organization-wide override for super_admin and admin. 
        // Standard managers now fall into the hierarchy checking logic below.
        if (!user.isSuperAdmin && !isSuperAdmin(user) && user.role !== 'admin') {
            // New Logic: Anyone can see their own leads + leads of their subordinates (recursively) + managed branches.
            // Role names no longer strictly limit visibility if they have reporting subordinates.
            const visibleUserIds = await getVisibleUserIds(user.id);

            const orConditions: any[] = [
                { assignedToId: { in: visibleUserIds } }, // Assigned to self or any subordinate/branch user
                {
                    // Created by self or a subordinate, but ONLY while still unassigned - once
                    // it's handed to someone else, the `assignedToId` branch above already
                    // covers it if the new owner is visible to this user, and if not, this user
                    // shouldn't keep seeing (and un-officially working) a lead that's no longer
                    // theirs. Unconditionally keeping every self-created lead visible forever
                    // (regardless of reassignment) let a rep keep flipping a lead's status back
                    // and forth against whoever it's actually assigned to now - reported for
                    // "Abdul Nafih" at Edufolio, where the original creator and the current
                    // owner kept alternately re-updating the same lead's status for months.
                    AND: [
                        { createdById: { in: visibleUserIds } },
                        { assignedToId: null }
                    ]
                }
            ];

            // Manager can see orphaned/unassigned leads
            if (user.role === 'manager') {
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

            andConditions.push({ OR: orConditions });
        }

        // Lightweight count-only mode for the web app's "Showing X of Y" indicator —
        // same org/visibility scoping as the full list above, but none of the query
        // filters below (status/source/search/date/etc.), and skips findMany entirely
        // so it stays cheap even though it's fired alongside the filtered request.
        if (req.query.countOnly === 'true') {
            const defaultWhere = andConditions.length > 0 ? { ...where, AND: andConditions } : where;
            const defaultTotal = await prisma.lead.count({ where: defaultWhere });
            return res.json({ total: defaultTotal });
        }

        // Filter: Status
        if (req.query.status) {
            where.status = req.query.status as string;
        }

        // Filter: Branch
        if (req.query.branchId) {
            where.branchId = req.query.branchId as string;
        }

        // Filter: Source
        if (req.query.source && Object.values(LeadSource).includes(req.query.source as LeadSource)) {
            where.source = req.query.source as LeadSource;
        }

        // Filter: Campaign. Lead has no campaign FK, only sourceDetails Json -
        // same JSON-path filtering pattern analyticsController.ts's
        // getLeadsByStage already uses. Not just Meta Ads anymore - bulk-
        // imported leads are tagged with sourceDetails.campaignName (no
        // campaignId, since there's no live ad account behind them), so this
        // matches on EITHER key rather than assuming campaignId is always
        // present. Pushed into andConditions (not assigned directly to
        // where.sourceDetails) so it combines correctly instead of clobbering
        // anything, matching the OR-combining pattern used elsewhere in this
        // function.
        if (req.query.campaignId) {
            andConditions.push({
                OR: [
                    { sourceDetails: { path: ['campaignId'], equals: req.query.campaignId as string } },
                    { sourceDetails: { path: ['campaignName'], equals: req.query.campaignId as string } }
                ]
            });
        }

        // Filter: Search (OR condition)
        if (req.query.search) {
            const search = String(req.query.search).trim();
            const searchNoSpace = search.replace(/\s+/g, '');

            // `phone` is stored WITHOUT the country code (that's the separate
            // phoneCountryCode column) - so a search like "+919496923534"
            // never matched the stored "9496923534" since the field is
            // shorter than the search string itself (contains() can't match
            // the other way around). Strip digits and also try the search
            // with a leading country-code (1-3 digits, covers nearly all
            // real calling codes) peeled off, so "+91XXXXXXXXXX" or
            // "91XXXXXXXXXX" both still match the bare local number.
            const searchDigits = search.replace(/\D/g, '');
            const phoneCandidates = Array.from(new Set(
                [search, searchNoSpace, searchDigits,
                    ...(searchDigits.length > 6 ? [1, 2, 3].map(n => searchDigits.slice(n)) : [])]
                    .filter(s => s.length >= 4)
            ));

            andConditions.push({
                OR: [
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { firstName: { contains: searchNoSpace, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: searchNoSpace, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } },
                    { email: { contains: searchNoSpace, mode: 'insensitive' } },
                    { company: { contains: search, mode: 'insensitive' } },
                    { company: { contains: searchNoSpace, mode: 'insensitive' } },
                    ...phoneCandidates.flatMap(c => ([
                        { phone: { contains: c, mode: 'insensitive' as const } },
                        { secondaryPhone: { contains: c, mode: 'insensitive' as const } }
                    ]))
                ]
            });
        }

        // Filter: Assigned User
        if (req.query.assignedTo) {
            where.assignedToId = req.query.assignedTo as string;
        }

        // Filter: Date Range (createdAt)
        // startDate/endDate arrive as plain "YYYY-MM-DD" (the calendar day picked in the UI, which
        // displays "Created At" in the browser's local/IST time). Building the window from UTC
        // midnight instead of IST midnight excludes leads created in the early-morning IST hours
        // (UTC previous day) even though their displayed date matches — shift by IST's +5:30 offset
        // so the query window lines up with the IST calendar day actually shown in the column.
        if (req.query.startDate || req.query.endDate) {
            const dateFilter: any = {};
            if (req.query.startDate) {
                const s = new Date(req.query.startDate as string);
                const start = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), 0, 0, 0, 0));
                start.setMinutes(start.getMinutes() - 330);
                dateFilter.gte = start;
            }
            if (req.query.endDate) {
                const e = new Date(req.query.endDate as string);
                const end = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate() + 1, 0, 0, 0, 0));
                end.setMinutes(end.getMinutes() - 330);
                dateFilter.lt = end;
            }
            where.createdAt = dateFilter;
        }

        // Combine all conditions
        if (andConditions.length > 0) {
            where.AND = andConditions;
        }

        // 3. Sorting
        let orderBy: any = { updatedAt: 'desc' };
        const sortBy = req.query.sortBy as string;
        const sortOrder = (req.query.sortOrder as string) || 'desc';

        if (sortBy) {
            if (sortBy === 'owner') {
                orderBy = { assignedTo: { firstName: sortOrder } };
            } else if (['firstName', 'lastName', 'createdAt', 'updatedAt', 'leadScore', 'status'].includes(sortBy)) {
                orderBy = { [sortBy]: sortOrder };
            }
        }

        console.log('[getLeads] Prisma Where:', JSON.stringify(where, null, 2)); // DEBUG LOG

        const total = await prisma.lead.count({ where });
        const leads = await prisma.lead.findMany({
            where,
            include: {
                assignedTo: {
                    select: { id: true, firstName: true, lastName: true, email: true }
                },
                interactions: {
                    where: { type: 'note', isDeleted: false },
                    orderBy: { date: 'desc' },
                    take: 1,
                    select: { description: true, date: true }
                },
                convertedOpportunities: {
                    where: { stage: { in: ['closed_won', 'closed_lost'] } },
                    orderBy: { updatedAt: 'desc' },
                    take: 1,
                    select: { stage: true, lostReason: true }
                }
            },
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy
        });

        // Derive a human-readable closed opportunity status (Won/Lost) for leads that converted.
        const leadsWithClosedStatus = leads.map(lead => {
            const closedOpp = (lead as any).convertedOpportunities?.[0];
            const closedOpportunityStatus = closedOpp
                ? (closedOpp.stage === 'closed_won' ? 'Won' : 'Lost')
                : null;
            return { ...lead, closedOpportunityStatus };
        });

        res.json({ leads: leadsWithClosedStatus, page, pages: Math.ceil(total / pageSize), total });
    } catch (error) {
        console.error('getLeads Error:', error);
        // Return 500 but include error message for debugging
        res.status(500).json({ message: (error as Error).message, stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined });
    }
};

// POST /api/leads
export const createLead = async (req: express.Request, res: express.Response) => {
    try {
        const { email, phone } = req.body;

        if (!phone) return res.status(400).json({ message: 'Phone number is required' });

        // Sanitize Phone (Support scientific notation and international prefixes)
        let cleanPhone = phone.toString();
        
        // Handle scientific notation (e.g., 9.19E+11)
        if (cleanPhone.includes('E+') || cleanPhone.includes('e+')) {
            const num = Number(cleanPhone);
            if (!isNaN(num)) {
                cleanPhone = num.toLocaleString('fullwide', { useGrouping: false });
            }
        }
        
        // Final digit-only cleaning
        cleanPhone = cleanPhone.replace(/\D/g, '');

        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(400).json({ message: 'Organisation context required' });

        const currentUser = (req as any).user;
        const assignedTo = req.body.assignedTo;
        const leadOwnerId = assignedTo || currentUser.id;

        // Resolve Branch (Lead branch is the lead owner's branch)
        let targetBranchId = req.body.branchId || currentUser.branchId;
        if (assignedTo) {
            const assignedUser = await prisma.user.findUnique({
                where: { id: assignedTo },
                select: { branchId: true }
            });
            if (assignedUser?.branchId) targetBranchId = assignedUser.branchId;
        }

        const { firstName, lastName, source, sourceDetails, company, enquiryAbout } = req.body;

        // Check for duplicates using DuplicateLeadService (Strictly isolated by branch)
        const duplicateCheck = await DuplicateLeadService.checkDuplicate(cleanPhone, email, orgId, targetBranchId || undefined, false, req.body.phoneCountryCode);

        if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
            // Handle as re-enquiry
            const reEnquiryData = {
                firstName: firstName,
                lastName: lastName,
                email: email,
                phone: cleanPhone,
                phoneCountryCode: req.body.phoneCountryCode,
                country: req.body.country,
                countryCode: req.body.countryCode,
                company: company,
                enquiryAbout: enquiryAbout,
                source: source,
                sourceDetails: sourceDetails
            };

            const updatedLead = await DuplicateLeadService.handleReEnquiry(
                duplicateCheck.existingLead,
                reEnquiryData,
                orgId
            );

            // Hierarchy Check: Only return full lead details if requester has permission
            const visibleUserIds = await getVisibleUserIds(currentUser.id);
            const hasPermission = 
                currentUser.isSuperAdmin || 
                isSuperAdmin(currentUser) || 
                updatedLead.assignedToId === currentUser.id || 
                visibleUserIds.includes(updatedLead.assignedToId || '') || 
                updatedLead.createdById === currentUser.id ||
                (updatedLead.createdById && visibleUserIds.includes(updatedLead.createdById) && !updatedLead.assignedToId);

            return res.status(200).json({
                message: 'Lead already exists. Marked as re-enquiry and notifications sent.',
                lead: hasPermission ? updatedLead : { id: updatedLead.id, firstName: 'Private', lastName: 'Lead', isPrivate: true },
                isReEnquiry: true,
                matchedBy: duplicateCheck.matchedBy,
                reEnquiryCount: updatedLead.reEnquiryCount
            });
        }

        // Sanitize email: treat empty string as no email
        const cleanEmail = email && email.trim() !== '' ? email.trim() : undefined;

        // Detect country from IP address if not provided
        let geoData = null;
        if (!req.body.country && !req.body.countryCode) {
            const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection.remoteAddress;
            if (ipAddress) {
                geoData = await GeoLocationService.detectCountryFromIP(ipAddress as string);
            }

            // Fallback: Try to detect from phone number
            if (!geoData && cleanPhone) {
                geoData = GeoLocationService.detectCountryFromPhone(cleanPhone);
            }
        }

        // Custom Field Validation
        if (req.body.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Lead', orgId, req.body.customFields);
        }

        // Resolve Default Status from Organisation Settings
        let leadStatus = req.body.status;
        if (!leadStatus) {
            const org = await prisma.organisation.findUnique({
                where: { id: orgId },
                select: { leadStatuses: true }
            });
            
            if (org?.leadStatuses && Array.isArray(org.leadStatuses)) {
                const statuses = org.leadStatuses as any[];
                const configuredDefault = statuses.find((s) => s.isDefault);
                if (configuredDefault) {
                    leadStatus = configuredDefault.id;
                }
            }
            
            // Final Fallback
            if (!leadStatus) leadStatus = 'new';
        }

        // Create — only pass explicitly known Lead fields (no blind spreading)
        const lead = await prisma.lead.create({
            data: {
                firstName: req.body.firstName || '',
                lastName: req.body.lastName || undefined,
                email: cleanEmail,
                phone: cleanPhone,
                secondaryPhone: req.body.secondaryPhone || undefined,
                company: req.body.company || undefined,
                enquiryAbout: req.body.enquiryAbout || undefined,
                jobTitle: req.body.jobTitle || undefined,
                address: req.body.address || undefined,
                customFields: req.body.customFields || undefined,
                tags: req.body.tags || undefined,
                stage: req.body.stage || undefined,
                sourceDetails: req.body.sourceDetails || undefined,
                country: req.body.country || geoData?.country || undefined,
                countryCode: req.body.countryCode || geoData?.countryCode || undefined,
                phoneCountryCode: req.body.phoneCountryCode || geoData?.phoneCountryCode || undefined,
                organisation: { connect: { id: orgId } },
                branch: targetBranchId ? { connect: { id: targetBranchId } } : undefined,
                // Assign to creator by default, or to specified user
                assignedTo: { connect: { id: leadOwnerId } },
                source: req.body.source as LeadSource || LeadSource.manual,
                status: leadStatus,
                potentialValue: req.body.potentialValue ? parseFloat(req.body.potentialValue) : 0,
                createdBy: { connect: { id: currentUser.id } } // Track creator for visibility
            }
        });

        // 3a. Handle Products if provided (products field is optional)
        if (req.body.products !== undefined && Array.isArray(req.body.products)) {
            const productItems = req.body.products;
            let totalValue = 0;

            // Only process if products array is not empty
            if (productItems.length > 0) {
                for (const item of productItems) {
                    // Validate that productId exists
                    if (!item.productId) {
                        continue; // Skip invalid items
                    }

                    const product = await prisma.product.findUnique({ where: { id: item.productId } });
                    if (product) {
                        const price = product.basePrice || 0;
                        const quantity = item.quantity || 1;
                        totalValue += price * quantity;

                        await prisma.leadProduct.create({
                            data: {
                                leadId: lead.id,
                                productId: item.productId,
                                quantity: quantity,
                                price: price
                            }
                        });
                    }
                }

                // Update lead with calculated value if products were added
                if (totalValue > 0) {
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: { potentialValue: totalValue }
                    });
                    lead.potentialValue = totalValue; // Update local obj for response
                }
            }
        }

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_LEAD',
                entity: 'Lead',
                entityId: lead.id,
                actorId: (req as any).user.id,
                organisationId: orgId,
                details: { name: `${lead.firstName} ${lead.lastName || ''}`.trim(), company: lead.company }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        // Enable Distribution only if no explicit assignment was made
        // This allows assignment rules to work for automated leads, but respects manual assignments
        if (!assignedTo) {
            await DistributionService.assignLead(lead, orgId);
        } else if (assignedTo !== currentUser.id) {
            // Manual assignment at creation time (e.g. an admin creating a
            // lead and handing it straight to a rep) previously never
            // notified the assignee at all — only reassignment via
            // `updateLead` did. Same message convention as that path; no
            // notification when the creator assigns the lead to themself.
            const leadName = `${lead.firstName} ${lead.lastName || ''}`.trim();
            NotificationService.send(
                leadOwnerId,
                'New Lead Assigned',
                `Lead "${leadName}" has been assigned to you by ${currentUser.firstName}.`,
                'info'
            ).catch(console.error);
        }

        // Trigger Workflow Engine for lead creation
        try {
            await WorkflowEngine.evaluate('Lead', 'created', lead, orgId);
            import('../services/webhookService').then(({ WebhookService }) => {
                WebhookService.triggerEvent('lead.created', lead, orgId).catch(console.error);
            });
            // AI Scoring
            import('../services/leadScoringService').then(({ LeadScoringService }) => {
                LeadScoringService.scoreLead(lead.id).catch(console.error);
            });
            // Goal Automation
            import('../services/goalService').then(({ GoalService }) => {
                const assignedId = lead.assignedToId;
                if (assignedId) {
                    GoalService.updateProgressForUser(assignedId, 'leads').catch(console.error);
                }
            });

            // Meta Conversion API: New Lead
            import('../services/metaConversionService').then(({ MetaConversionService }) => {
                MetaConversionService.sendEvent(orgId, {
                    eventName: 'Lead',
                    userData: {
                        email: lead.email,
                        phone: lead.phone,
                        firstName: lead.firstName,
                        lastName: lead.lastName,
                        externalId: lead.id
                    },
                    actionSource: 'system_generated' // or website if we knew source url
                }, lead.branchId).catch(console.error);
            });
            // Gallabox Sync
            GallaboxService.getClientForOrg(orgId).then(gallabox => {
                if (gallabox) {
                    gallabox.syncLeadToContact(lead).catch(err => {
                        console.error('Auto Gallabox Sync Error:', err.message);
                    });
                }
            }).catch(console.error);
        } catch (workflowErr) {
            console.error('WorkflowEngine error:', workflowErr);
            // Don't fail the request if workflow fails
        }

        // Socket Emit for Real-time Sync
        emitToOrg(orgId, 'lead_created', lead);

        res.status(201).json(lead);
    } catch (error: any) {
        console.error('createLead Error:', error);

        // Handle Prisma Unique Constraint Errors (e.g., P2002)
        if (error.code === 'P2002') {
            const target = error.meta?.target || [];
            if (target.includes('phone')) {
                return res.status(400).json({
                    message: 'A lead with this phone number already exists in your organisation.'
                });
            }
            if (target.includes('email')) {
                return res.status(400).json({
                    message: 'A lead with this email address already exists in your organisation.'
                });
            }
            return res.status(400).json({
                message: 'A lead with these details already exists in your organisation.'
            });
        }

        res.status(400).json({ message: (error as Error).message });
    }
};

export const getLeadById = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        // 1. Organization & Existence scoping (Check if it even exists in their world)
        const existingLead = await prisma.lead.findUnique({
            where: { id: req.params.id },
            select: { organisationId: true, isDeleted: true }
        });

        if (!existingLead || existingLead.isDeleted || (orgId && existingLead.organisationId !== orgId)) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        const where: any = { id: req.params.id, isDeleted: false };

        // 2. Hierarchy Visibility scoping
        if (!user.isSuperAdmin && !isSuperAdmin(user) && user.role !== 'admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);
            
            const orConditions: any[] = [
                { assignedToId: { in: visibleUserIds } }, // Assigned to self or any subordinate/branch user
                { createdById: user.id },                // Created by the user (always visible)
                {
                    AND: [
                        { createdById: { in: visibleUserIds } }, // Created by subordinate
                        { assignedToId: null }    // But not reassigned to someone else
                    ]
                }
            ];

            if (user.role === 'admin') {
                orConditions.push({ assignedToId: null });
            } else if (user.role === 'manager') {
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

            where.OR = orConditions;
        }

        const lead = await prisma.lead.findFirst({
            where,
            include: {
                assignedTo: { select: { firstName: true, lastName: true, email: true } },
                products: { include: { product: true } },
                // Lead.status alone can't tell the UI whether this lead was actually converted —
                // 'won'/'lost'/'converted' can also just be a manually-picked custom status from
                // the org's configured lead-status list, unrelated to a real Opportunity ever
                // existing. Expose the real signal so the frontend can gate "Move to Pipeline" on it.
                convertedOpportunities: { where: { isDeleted: false }, select: { id: true, stage: true } }
            }
        });

        if (!lead) {
            return res.status(403).json({
                message: 'Access Denied: This lead is outside of your visibility hierarchy.',
                error: 'HIERARCHY_FORBIDDEN'
            });
        }

        res.json({ ...lead, isConverted: lead.convertedOpportunities.length > 0 });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateLead = async (req: express.Request, res: express.Response) => {
    try {
        const updates = { ...req.body };
        const leadId = req.params.id;
        const requester = (req as any).user;
        let historyData: any = null;

        // Fetch current lead to check for ownership change
        const currentLead = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!currentLead) return res.status(404).json({ message: 'Lead not found' });

        // General access check: mirrors getLeads' own visibility rules - a non-admin
        // may only modify a lead that's currently assigned to them/a subordinate, or
        // was created by them/a subordinate and is still unassigned (plus a manager's
        // branch-orphan carve-out, same as the list). Before this, org membership was
        // the ONLY gate here, so any user in the org could PATCH any other lead's
        // status by ID once they had it (e.g. a stale bookmark/cached lead from
        // before it was reassigned) - exactly what let "Abdul Nafih" and "Musadhiq"
        // at Edufolio get repeatedly flip-flopped in status by both their original
        // creator and their current owner, neither aware of the other.
        if (!requester.isSuperAdmin && !isSuperAdmin(requester) && !isAdmin(requester)) {
            const visibleUserIds = await getVisibleUserIds(requester.id);
            const isManagerBranchOrphan = requester.role === 'manager' && !currentLead.assignedToId &&
                (!currentLead.branchId || currentLead.branchId === requester.branchId);
            const canAccess =
                (currentLead.assignedToId && visibleUserIds.includes(currentLead.assignedToId)) ||
                (!currentLead.assignedToId && currentLead.createdById && visibleUserIds.includes(currentLead.createdById)) ||
                isManagerBranchOrphan;
            if (!canAccess) {
                return res.status(403).json({ message: 'You do not have permission to update this lead.' });
            }
        }

        // Hierarchy Check
        if (updates.assignedToId || updates.assignedTo) { // Handle payload differences
            const targetUserId = updates.assignedToId || updates.assignedTo; // Assuming ID string

            if (!requester.isSuperAdmin && !isSuperAdmin(requester) && !isAdmin(requester)) {
                const allowedIds = await getVisibleUserIds(requester.id);

                // If passing an object (legacy), extract ID?? Usually frontend sends ID string for update.
                // Let's assume ID string.
                if (typeof targetUserId === 'string' && !allowedIds.includes(targetUserId)) {
                    return res.status(403).json({ message: 'You can only assign leads to your subordinates.' });
                }
            }

            // Track History
            if (currentLead.assignedToId !== targetUserId) {
                historyData = {
                    leadId,
                    oldOwnerId: currentLead.assignedToId,
                    newOwnerId: targetUserId,
                    changedById: requester.id,
                    reason: req.body.reason || 'Manual Assignment'
                };
            }

            // Sync branch and team with new owner
            const assignedUser = await prisma.user.findUnique({
                where: { id: targetUserId },
                select: { branchId: true, teamId: true }
            });
            if (assignedUser) {
                if (assignedUser.branchId) updates.branchId = assignedUser.branchId;
                if (assignedUser.teamId) updates.teamId = assignedUser.teamId;
            }

            // Remap for Prisma - store the ID directly
            updates.assignedToId = targetUserId;
            delete updates.assignedTo; // Clean up the relation object

            // Notify new owner
            if (currentLead.assignedToId !== targetUserId) {
                const leadName = `${currentLead.firstName} ${currentLead.lastName || ''}`.trim();
                NotificationService.send(
                    targetUserId,
                    'New Lead Assigned',
                    `Lead "${leadName}" has been assigned to you by ${requester.firstName}.`,
                    'info'
                ).catch(console.error);
            }
        }

        // Phone Sanitization & Country Detection
        if (updates.phone) {
            let cleanPhone = updates.phone.toString();
            
            // Handle scientific notation
            if (cleanPhone.includes('E+') || cleanPhone.includes('e+')) {
                const num = Number(cleanPhone);
                if (!isNaN(num)) {
                    cleanPhone = num.toLocaleString('fullwide', { useGrouping: false });
                }
            }
            
            updates.phone = cleanPhone.replace(/\D/g, '');

            // Detect country if not provided or explicitly requested.
            // A client sending phoneCountryCode explicitly (mobile/web's
            // country picker) already knows the right answer — don't let the
            // digits-only heuristic below (which just guesses India for any
            // bare 10-digit 6-9-leading number) clobber it for every other
            // country's leads just because country/countryCode weren't also
            // sent (neither client sends those separately today).
            if (!updates.phoneCountryCode && (!updates.country || !updates.countryCode)) {
                const geoData = GeoLocationService.detectCountryFromPhone(updates.phone);
                if (geoData) {
                    updates.country = geoData.country;
                    updates.countryCode = geoData.countryCode;
                    updates.phoneCountryCode = geoData.phoneCountryCode;
                }
            }
        }

        // Duplicate Check for phone/email update
        if ((updates.phone && updates.phone !== currentLead.phone) || (updates.email && updates.email !== currentLead.email)) {
            const duplicateCheck = await DuplicateLeadService.checkDuplicate(
                updates.phone || currentLead.phone,
                updates.email || currentLead.email,
                currentLead.organisationId,
                currentLead.branchId || undefined,
                false,
                updates.phoneCountryCode || currentLead.phoneCountryCode
            );
            
            if (duplicateCheck.isDuplicate && duplicateCheck.existingLead && duplicateCheck.existingLead.id !== currentLead.id) {
                return res.status(400).json({
                    message: `A lead with this ${duplicateCheck.matchedBy} already exists in this branch.`
                });
            }
        }

        // Track Status Change
        if (updates.status && updates.status !== currentLead.status) {
            // CRITICAL: Block transition to 'qualified' or 'converted' if no products
            if (['qualified', 'converted'].includes(updates.status)) {
                const productCount = await prisma.leadProduct.count({ where: { leadId } });
                if (productCount === 0) {
                    return res.status(400).json({
                        message: 'Please add at least one product before qualifying or converting this lead.'
                    });
                }
            }

            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'LEAD_STATUS_CHANGE',
                entity: 'Lead',
                entityId: leadId,
                actorId: requester.id,
                organisationId: currentLead.organisationId,
                details: { 
                    name: `${currentLead.firstName} ${currentLead.lastName || ''}`.trim(),
                    oldStatus: currentLead.status, 
                    newStatus: updates.status 
                }
            });

            // CRITICAL for Reporting: Create LeadHistory record
            await prisma.leadHistory.create({
                data: {
                    leadId,
                    fieldName: 'status',
                    oldValue: currentLead.status,
                    newValue: updates.status,
                    changedById: requester.id,
                    reason: req.body.reason || 'Manual Status Update'
                }
            }).catch(() => {});
        }

        // Track Follow-up Change and Create Task
        if (updates.nextFollowUp) {
            // Create interaction log
            await prisma.interaction.create({
                data: {
                    leadId: leadId,
                    type: 'other',
                    subject: 'Follow-up Scheduled',
                    description: `Next follow-up scheduled for ${new Date(updates.nextFollowUp).toLocaleDateString()}`,
                    createdById: requester.id,
                    organisationId: currentLead.organisationId
                }
            });

            // Auto-create or reschedule follow-up task
            const leadName = `${currentLead.firstName} ${currentLead.lastName || ''}`.trim();
            const dueDate = new Date(updates.nextFollowUp);

            await FollowUpService.rescheduleOrCreateFollowUp({
                subject: `Follow up with ${leadName}`,
                description: `Follow-up scheduled for ${leadName} from ${currentLead.company || 'Unknown Company'}`,
                status: 'not_started',
                priority: 'medium',
                dueDate: dueDate,
                organisationId: currentLead.organisationId,
                createdById: requester.id,
                leadId: leadId,
                assignedToId: updates.assignedToId || currentLead.assignedToId || requester.id,
                branchId: currentLead.branchId
            });
        } else if (updates.nextFollowUp === null) {
            // User explicitly cleared the follow-up date, so defer all active follow-ups
            await prisma.followUp.updateMany({
                where: {
                    leadId: leadId,
                    isDeleted: false,
                    status: { notIn: ['completed', 'deferred'] }
                },
                data: { status: 'deferred' }
            });
        }

        if (updates.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Lead', currentLead.organisationId, updates.customFields);
        }

        const whereObj: any = { id: leadId, isDeleted: false };
        if (requester.role !== 'super_admin') {
            const orgId = getOrgId(requester);
            if (!orgId) return res.status(403).json({ message: 'No org' });
            whereObj.organisationId = orgId;
            // Don't filter by branchId on update - users can update leads across branches if they have access
        }

        // Sanitize phone if it's being updated
        if (updates.phone) {
            let cleanPhone = updates.phone.toString().replace(/\D/g, '');
            updates.phone = cleanPhone;
        }

        // List of allowed fields to prevent relation/schema mismatches crashing Prisma
        const allowedFields = [
            'firstName', 'lastName', 'email', 'phone', 'secondaryPhone', 'company', 'enquiryAbout', 'jobTitle', 'address',
            'status', 'source', 'sourceDetails', 'stage', 'tags', 'potentialValue',
            'nextFollowUp', 'customFields', 'isHotLead', 'lostReason', 'notes',
            'country', 'countryCode', 'phoneCountryCode', 'city', 'state', 'zip'
        ];

        const leadUpdates: any = {};
        allowedFields.forEach(field => {
            if (updates[field] !== undefined) {
                leadUpdates[field] = updates[field];
            }
        });

        // Add special handling for relation IDs if they are strings (Prisma connect is handled above)
        if (updates.assignedToId) leadUpdates.assignedToId = updates.assignedToId;
        if (updates.branchId) leadUpdates.branchId = updates.branchId;

        // Whether this request actually changes anything vs. what's already stored — a
        // client stuck resubmitting the same payload (e.g. a runaway autosave loop) should
        // still succeed as a no-op, but must not re-fire hierarchy-wide notifications on
        // every call. Seen in production: two users' clients hammered this endpoint with
        // identical payloads hundreds of times per second, flooding one branch manager with
        // 17,000+ "Lead Updated" notifications since nothing here was gated on real change.
        const hasRealChange = Object.keys(leadUpdates).some((field) => {
            const before = (currentLead as any)[field];
            const after = leadUpdates[field];
            if (before instanceof Date || after instanceof Date) {
                return new Date(before as any).getTime() !== new Date(after as any).getTime();
            }
            if (typeof before === 'object' || typeof after === 'object') {
                return JSON.stringify(before) !== JSON.stringify(after);
            }
            return before !== after;
        });

        // Update Lead Basic Info
        const [lead] = await prisma.$transaction([
            prisma.lead.update({
                where: whereObj,
                data: leadUpdates,
                include: { assignedTo: { select: { firstName: true, lastName: true, email: true } } }
            }),
            ...(historyData ? [
                prisma.leadHistory.create({ data: historyData }),
                prisma.followUp.updateMany({
                    where: { leadId, isDeleted: false, status: { notIn: ['completed'] } },
                    data: { assignedToId: leadUpdates.assignedToId, createdById: leadUpdates.assignedToId }
                }),
                prisma.task.updateMany({
                    where: { leadId, isDeleted: false, status: { notIn: ['completed'] } },
                    data: { assignedToId: leadUpdates.assignedToId, createdById: leadUpdates.assignedToId }
                }),
                // Keep any Opportunity/Account/Contact already spawned from this lead in
                // sync with reassignment. Without this, a deal keeps showing its owner as
                // whoever the lead happened to be assigned to at the moment it was
                // converted — reassigning the lead afterward (e.g. shuffler, manual
                // reassignment) silently left the deal attributed to the old owner
                // forever, breaking that person's (and the new owner's) Won/Expected counts.
                prisma.opportunity.updateMany({
                    where: { leadId, isDeleted: false },
                    data: { ownerId: leadUpdates.assignedToId, previousOwnerId: currentLead.assignedToId }
                }),
                prisma.account.updateMany({
                    where: { leadId, isDeleted: false },
                    data: { ownerId: leadUpdates.assignedToId, previousOwnerId: currentLead.assignedToId }
                }),
                prisma.contact.updateMany({
                    where: { leadId, isDeleted: false },
                    data: { ownerId: leadUpdates.assignedToId, previousOwnerId: currentLead.assignedToId }
                })
            ] : [])
        ]);

        let finalLead = lead;

        // Handle Products Update (products field is optional)
        if (req.body.products !== undefined && Array.isArray(req.body.products)) {
            const productItems = req.body.products;

            // 1. Clear existing products (simplest approach for full replace)
            await prisma.leadProduct.deleteMany({ where: { leadId } });

            // 2. Add new products and calculate value (only if products array is not empty)
            let totalValue = 0;

            if (productItems.length > 0) {
                for (const item of productItems) {
                    // Validate that productId exists
                    if (!item.productId) {
                        continue; // Skip invalid items
                    }

                    const product = await prisma.product.findUnique({ where: { id: item.productId } });
                    if (product) {
                        // Priority 1: Price from payload (custom pricing), Priority 2: Product base price
                        const price = item.price !== undefined ? Number(item.price) : (product.basePrice || 0);
                        const quantity = item.quantity || 1;
                        totalValue += price * quantity;

                        await prisma.leadProduct.create({
                            data: {
                                leadId,
                                productId: item.productId,
                                quantity: quantity,
                                price: price,
                                customName: item.customName || undefined
                            }
                        });
                    }
                }
            }

            // 3. Update Lead Value
            finalLead = await prisma.lead.update({
                where: { id: leadId },
                data: { potentialValue: totalValue },
                include: {
                    assignedTo: { select: { firstName: true, lastName: true, email: true } },
                    products: { include: { product: true } }
                }
            });

            // Log History for Value Change
            if (currentLead.potentialValue !== totalValue) {
                await prisma.leadHistory.create({
                    data: {
                        leadId,
                        changedById: requester.id,
                        fieldName: 'potentialValue',
                        oldValue: currentLead.potentialValue?.toString() || '0',
                        newValue: totalValue.toString()
                    }
                });
            }
        }

        // Audit Log for update
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'UPDATE_LEAD',
                entity: 'Lead',
                entityId: leadId,
                actorId: requester.id,
                organisationId: currentLead.organisationId,
                details: { name: `${currentLead.firstName} ${currentLead.lastName || ''}`.trim(), updatedFields: Object.keys(updates) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json(finalLead);

        // Webhook
        import('../services/webhookService').then(({ WebhookService }) => {
            WebhookService.triggerEvent('lead.updated', lead, lead.organisationId).catch(console.error);
        });

        // AI Scoring Trigger (if relevant fields changed)
        if (updates.jobTitle || updates.company || updates.email || updates.phone) {
            import('../services/leadScoringService').then(({ LeadScoringService }) => {
                LeadScoringService.scoreLead(leadId).catch(console.error);
            });
        }

        // Socket Emit for Real-time Sync
        emitToOrg(finalLead.organisationId, 'lead_updated', finalLead);

        // Notifications
        import('../services/notificationService').then(({ NotificationService }) => {
            const leadName = `${finalLead.firstName} ${finalLead.lastName || ''}`.trim();

            // 1. Hierarchy Notification (existing) — only for requests that actually changed
            // something (see hasRealChange above); a no-op resubmission shouldn't notify anyone.
            if (hasRealChange) {
                NotificationService.sendToHierarchy(
                    requester.id,
                    'Lead Updated',
                    `${requester.firstName} updated lead: ${leadName}`,
                    'info'
                ).catch(console.error);
            }

            // 2. Owner Notification for Status Change
            if (updates.status && updates.status !== currentLead.status) {
                if (finalLead.assignedToId && finalLead.assignedToId !== requester.id) {
                    NotificationService.send(
                        finalLead.assignedToId,
                        'Lead Status Updated',
                        `Your lead "${leadName}" status has been updated to "${updates.status}" by ${requester.firstName}.`,
                        'info'
                    ).catch(console.error);
                }
            }
        });

    } catch (error: any) {
        console.error('[updateLead] Error:', error);

        // Handle Prisma Unique Constraint Errors (e.g., P2002)
        if (error.code === 'P2002') {
            const target = error.meta?.target || [];
            if (target.includes('phone')) {
                return res.status(400).json({
                    message: 'A lead with this phone number already exists in your organisation.'
                });
            }
            if (target.includes('email')) {
                return res.status(400).json({
                    message: 'A lead with this email address already exists in your organisation.'
                });
            }
            return res.status(400).json({
                message: 'A lead with these details already exists in your organisation.'
            });
        }

        res.status(400).json({ message: (error as Error).message });
    }
};

export const deleteLead = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const leadId = req.params.id;

        // Role Check
        if (!isAdmin(user)) {
            return res.status(403).json({ message: 'Not authorized to delete leads' });
        }

        const lead = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        // Org Check
        if (!isSuperAdmin(user)) {
            const userOrgId = getOrgId(user);
            if (lead.organisationId !== userOrgId) {
                return res.status(403).json({ message: 'Not authorized to delete this lead' });
            }
        }

        await prisma.$transaction([
            prisma.lead.update({
                where: { id: leadId },
                data: { isDeleted: true, deletedAt: new Date() }
            }),
            // Cascade delete related entities
            prisma.contact.updateMany({
                where: { leadId: leadId },
                data: { isDeleted: true, deletedAt: new Date() }
            }),
            prisma.account.updateMany({
                where: { leadId: leadId },
                data: { isDeleted: true, deletedAt: new Date() }
            }),
            prisma.opportunity.updateMany({
                where: { leadId: leadId },
                data: { isDeleted: true, deletedAt: new Date() }
            })
        ]);

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'DELETE_LEAD',
                entity: 'Lead',
                entityId: leadId,
                actorId: user.id,
                organisationId: lead.organisationId,
                details: { name: `${lead.firstName} ${lead.lastName || ''}`.trim() }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        // Socket Emit for Real-time Sync
        emitToOrg(lead.organisationId, 'lead_deleted', { id: leadId });

        res.json({ message: 'Lead deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createBulkLeads = async (req: express.Request, res: express.Response) => {
    try {
        const { leads, assignmentRuleId, applyAssignmentRules, splitUserIds } = req.body;
        const user = (req as any).user;

        // Support both direct array (legacy) and object with options
        const leadsData = Array.isArray(req.body) ? req.body : leads;
        const ruleId = Array.isArray(req.body) ? undefined : assignmentRuleId;
        const applyRules = Array.isArray(req.body) ? true : (applyAssignmentRules !== false); // Default to true if not explicitly false
        const splitIds = Array.isArray(req.body) ? [] : (splitUserIds || []);
        let splitIndex = 0;

        console.log('[createBulkLeads] Received:', leadsData?.length || 0, 'leads', 'RuleID:', ruleId, 'SplitIds:', splitIds);

        if (!Array.isArray(leadsData) || leadsData.length === 0) {
            return res.status(400).json({ message: 'Invalid input' });
        }

        // Map data
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        let createdCount = 0;
        let duplicateCount = 0;
        let reEnquiryCount = 0;
        const errors: any[] = [];

        // Pre-fetch users for email resolution
        const orgUsers = await prisma.user.findMany({
            where: { organisationId: orgId },
            select: { id: true, email: true }
        });
        const userEmailMap = new Map(orgUsers.map(u => [u.email.toLowerCase(), u.id]));

        for (const l of leadsData) {
            try {
                // Sanitize phone: keep all digits for the service to handle normalization
                let cleanPhone = l.phone?.toString().replace(/\D/g, '') || '';

                // Resolve owner and branch EARLY. `explicitBranchId` tracks whether THIS row
                // actually named a branch/owner (as opposed to just falling back to the
                // importer's own branch) — that distinction matters below: a row with no
                // branch signal of its own should never move an existing lead to a
                // different branch, it should just land back with whoever already owns it.
                let targetOwnerId = l.assignedTo || l.assignedToId;

                // Resolution via ownerEmail if provided in import
                if (!targetOwnerId && l.ownerEmail && typeof l.ownerEmail === 'string') {
                    const resolvedId = userEmailMap.get(l.ownerEmail.toLowerCase());
                    if (resolvedId) targetOwnerId = resolvedId;
                }

                let explicitBranchId: string | undefined = l.branchId || undefined;

                // If specific user resolved, sync branch with them
                if (targetOwnerId) {
                    const assignedUser = await prisma.user.findUnique({
                        where: { id: targetOwnerId },
                        select: { branchId: true }
                    });
                    if (assignedUser?.branchId) explicitBranchId = explicitBranchId || assignedUser.branchId;
                }

                let targetBranchId = explicitBranchId || user.branchId;

                // Duplicate detection is intentionally ORG-WIDE for bulk import, not scoped
                // to targetBranchId — branch-scoped detection is right for genuine walk-ins,
                // but for imports (which routinely re-upload the same contacts under a
                // different source label or branch guess) it just lets the same person get
                // re-created once per branch/source combination. See handleReEnquiry below
                // for how a genuinely-different branch on the row is still respected.
                const DuplicateLeadService = (await import('../services/duplicateLeadService')).default;
                const duplicateCheck = await DuplicateLeadService.checkDuplicate(
                    cleanPhone,
                    l.email,
                    orgId,
                    targetBranchId || undefined,
                    true, // includeAllBranches
                    l.phoneCountryCode
                );

                if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
                    const existingLead = duplicateCheck.existingLead;
                    // Only actually move branch/owner when this row explicitly names one
                    // AND it's genuinely different from where the lead already sits —
                    // "not branch specific" (explicitBranchId unset) always keeps the
                    // current owner, matching the default re-enquiry behavior.
                    const movingToNewBranch = !!explicitBranchId && explicitBranchId !== existingLead.branchId;

                    let newOwnerId: string | undefined;
                    if (movingToNewBranch) {
                        // Prefer an explicitly-named owner/ownerEmail for this row; otherwise
                        // auto-distribute within the new branch the same way a fresh lead
                        // would be, so it doesn't just land on the importer by default.
                        newOwnerId = targetOwnerId || undefined;
                        if (!newOwnerId) {
                            const { DistributionService } = await import('../services/distributionService');
                            newOwnerId = await DistributionService.assignLead(
                                { ...l, id: undefined, branchId: explicitBranchId },
                                orgId,
                                undefined,
                                user.id
                            ) || undefined;
                        }
                    }

                    // Handle as re-enquiry
                    await DuplicateLeadService.handleReEnquiry(
                        existingLead,
                        {
                            firstName: l.firstName,
                            lastName: l.lastName || '',
                            email: l.email,
                            phone: cleanPhone,
                            phoneCountryCode: l.phoneCountryCode,
                            country: l.country,
                            countryCode: l.countryCode,
                            company: l.company,
                            enquiryAbout: l.enquiryAbout,
                            source: l.source || 'import',
                            sourceDetails: l.sourceDetails,
                            ...(movingToNewBranch ? { newBranchId: explicitBranchId, newOwnerId } : {})
                        },
                        orgId
                    );
                    reEnquiryCount++;
                    continue;
                }

                // Try to detect country from phone if not provided
                let geoData = null;
                if (!l.country && !l.countryCode && cleanPhone) {
                    geoData = GeoLocationService.detectCountryFromPhone(cleanPhone);
                }

                // Normalize campaign info once so both rule-matching (below) and the
                // created lead itself (which previously dropped this entirely) agree
                // on the same sourceDetails.campaignName that assignment rules key on.
                const finalSourceDetails = l.sourceDetails || (l.campaignName || l.campaign
                    ? { campaignName: l.campaignName || l.campaign }
                    : undefined);

                let finalOwnerId = targetOwnerId;
                // `DistributionService.assignLead` already notifies the
                // assignee itself (see `notifyUser`, called on all of its
                // success/fallback branches) — track when that path was
                // taken so the notification added below isn't sent twice
                // for the same lead.
                let assignedViaDistribution = false;

                if (splitIds.length > 0) {
                    finalOwnerId = splitIds[splitIndex % splitIds.length];
                    splitIndex++;
                } else if (!finalOwnerId && applyRules) {
                    const { DistributionService } = await import('../services/distributionService');
                    finalOwnerId = await DistributionService.assignLead(
                        { ...l, sourceDetails: finalSourceDetails, id: undefined, branchId: targetBranchId || undefined },
                        orgId,
                        ruleId,
                        user.id // Importer fallback
                    ) || undefined;
                    assignedViaDistribution = true;
                }

                // Robust Status and Stage Resolution for Bulk Creation
                const csvStatus = (l.status || l.Status || '').toString().trim().toLowerCase();
                const csvStage = (l.stage || l.Stage || '').toString().trim().toLowerCase();
                
                let finalStatus = 'new';
                let finalStage = null;

                if (csvStage) {
                    finalStatus = csvStage;
                    finalStage = csvStage;
                } else if (csvStatus) {
                    finalStatus = csvStatus;
                    finalStage = csvStatus;
                } else {
                    finalStatus = csvStatus || 'new';
                    finalStage = null;
                }

                if (finalStatus === 'shuffled_lead' || finalStage === 'shuffled_lead') {
                    throw new Error("Cannot import leads with 'shuffled_lead' status.");
                }

                const data: any = {
                    firstName: l.firstName,
                    lastName: l.lastName || '',
                    phone: cleanPhone,
                    email: l.email,
                    company: l.company,
                    country: l.country || geoData?.country || undefined,
                    countryCode: l.countryCode || geoData?.countryCode || undefined,
                    phoneCountryCode: l.phoneCountryCode || geoData?.phoneCountryCode || undefined,
                    organisation: { connect: { id: orgId } },
                    source: l.source || LeadSource.import,
                    status: finalStatus,
                    leadScore: l.leadScore ? parseInt(l.leadScore.toString()) : 0,
                    stage: finalStage || undefined,
                    createdBy: { connect: { id: user.id } },
                    // Preserve campaign info from the import row so it's visible on the lead
                    // afterward (Campaign column, lead detail) and so campaign-based
                    // assignment rules can match against it, same as the live Meta webhook does.
                    sourceDetails: finalSourceDetails
                };

                // Connect to branch if available
                const finalBranchId = l.branchId || user.branchId;
                if (finalBranchId) {
                    data.branch = { connect: { id: finalBranchId } };
                }

                // Connect to assigned user if determined
                // If finalOwnerId is null (e.g., no rule matched), it creates an unassigned lead 
                // (or you can fallback to the importer: user.id)
                // We'll fallback to user (the importer) if no rule matched and no manual assignment.
                const finalAssignedTo = finalOwnerId || user.id;
                if (finalAssignedTo) {
                    data.assignedTo = { connect: { id: finalAssignedTo } };
                }

                console.log('[createBulkLeads] Creating lead:', data.firstName, data.phone, 'Assigned to:', finalAssignedTo);

                const lead = await prisma.lead.create({ data });

                // AI Scoring
                import('../services/leadScoringService').then(({ LeadScoringService }) => {
                    LeadScoringService.scoreLead(lead.id).catch(console.error);
                });

                // Notify the assignee — only for an explicit/split
                // assignment (`assignedViaDistribution` already handled its
                // own notification internally) and only when it's not the
                // importer assigning the row to themself.
                if (!assignedViaDistribution && finalAssignedTo !== user.id) {
                    const leadName = `${lead.firstName} ${lead.lastName || ''}`.trim();
                    NotificationService.send(
                        finalAssignedTo,
                        'New Lead Assigned',
                        `Lead "${leadName}" has been assigned to you (bulk import).`,
                        'info'
                    ).catch(console.error);
                }

                createdCount++;
            } catch (error: any) {
                console.error('[createBulkLeads] Error creating lead:', error.message, 'Lead data:', l);
                errors.push({ lead: l, error: error.message });
                duplicateCount++;
            }
        }

        console.log('[createBulkLeads] Results:', { created: createdCount, reEnquiries: reEnquiryCount, duplicates: duplicateCount, errors: errors.length });

        res.status(201).json({
            message: `Bulk import completed`,
            created: createdCount,
            reEnquiries: reEnquiryCount,
            duplicates: duplicateCount,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const bulkAssignLeads = async (req: express.Request, res: express.Response) => {
    try {
        const { leadIds, assignedTo, reason } = req.body;
        const requester = (req as any).user;

        if (!isAdmin(requester)) {
            const allowedIds = await getVisibleUserIds(requester.id);
            if (!allowedIds.includes(assignedTo)) {
                return res.status(403).json({ message: 'Forbidden assignment' });
            }
        }

        // Fetch current leads to track old owners
        const currentLeads = await prisma.lead.findMany({
            where: { id: { in: leadIds } },
            select: { id: true, assignedToId: true }
        });

        // Fetch new owner to sync team and branch
        const newOwner = await prisma.user.findUnique({
            where: { id: assignedTo },
            select: { teamId: true, branchId: true }
        });

        // Update leads
        const result = await prisma.lead.updateMany({
            where: { id: { in: leadIds } },
            data: { 
                assignedToId: assignedTo,
                teamId: newOwner?.teamId || null,
                branchId: newOwner?.branchId || null
            }
        });

        // Create history records for each lead
        const historyRecords = currentLeads.map(lead => ({
            leadId: lead.id,
            oldOwnerId: lead.assignedToId,
            newOwnerId: assignedTo,
            changedById: requester.id,
            reason: reason || 'Bulk Assignment'
        }));

        if (historyRecords.length > 0) {
            await prisma.leadHistory.createMany({
                data: historyRecords
            });

            // Keep any already-spawned Opportunity/Account/Contact in sync with the
            // reassignment — same reasoning as the single-lead update path.
            await Promise.all([
                prisma.opportunity.updateMany({
                    where: { leadId: { in: leadIds }, isDeleted: false },
                    data: { ownerId: assignedTo }
                }),
                prisma.account.updateMany({
                    where: { leadId: { in: leadIds }, isDeleted: false },
                    data: { ownerId: assignedTo }
                }),
                prisma.contact.updateMany({
                    where: { leadId: { in: leadIds }, isDeleted: false },
                    data: { ownerId: assignedTo }
                }),
                prisma.followUp.updateMany({
                    where: { leadId: { in: leadIds }, isDeleted: false, status: { notIn: ['completed', 'deferred'] } },
                    data: { assignedToId: assignedTo }
                }),
                prisma.task.updateMany({
                    where: { leadId: { in: leadIds }, isDeleted: false, status: { notIn: ['completed'] } },
                    data: { assignedToId: assignedTo }
                })
            ]);

            // Notify new owner
            if (assignedTo !== requester.id) {
                const { NotificationService } = await import('../services/notificationService');
                NotificationService.send(
                    assignedTo,
                    'Bulk Leads Assigned',
                    `${result.count} leads have been assigned to you by ${requester.firstName}.`,
                    'info'
                ).catch(console.error);
            }
        }

        res.json({ message: 'Assigned successfully', count: result.count });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const convertLead = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const leadId = id;

        const { dealName, amount, accountId, accountName, contactName, stage, paymentType, paidAmount, installments, lostReason } = req.body;
        const user = (req as any).user;
        
        // Initial org check for the converting user
        const userOrgId = getOrgId(user);
        if (!userOrgId && !user.isSuperAdmin) return res.status(400).json({ message: 'No organisation context' });

        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: {
                organisation: true,
                products: { include: { product: true } }
            }
        });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        // CRITICAL: Block conversion if no products
        if (!lead.products || lead.products.length === 0) {
            return res.status(400).json({ 
                message: 'Please add at least one product before converting this lead to an opportunity.' 
            });
        }

        // Lead.status alone isn't a reliable signal here: 'won'/'lost'/'converted' can also be a
        // plain custom status a user picked manually from the org's configured lead-status list
        // (Organisation.leadStatuses), completely independent of ever actually converting this
        // lead into an Opportunity. The only real signal that conversion already happened is an
        // existing Opportunity linked to this lead.
        //
        // But "already converted" shouldn't mean "can never convert again" - a lead that came
        // back after its deal was fully closed (won or lost) and is now closing a genuinely new
        // deal needs somewhere to record it. Only block when an existing opportunity is still
        // OPEN (actively being worked) - that's the real "don't create a duplicate in-progress
        // deal" case this check exists for. Once every prior opportunity is closed_won/
        // closed_lost, allow a fresh one regardless of whether the lead was reset via the
        // system's own re-enquiry detection or just a manual status change by a rep (reported
        // case: MUHAMMAD RAZAN K at Edufolio - won in May, lost, manually reset and reassigned,
        // then won again in September for a different amount - isReEnquiry/reEnquiryCount were
        // never set on it, so gating purely on those would have kept blocking this exact case).
        const existingOpenOpportunity = await prisma.opportunity.findFirst({
            where: { leadId, isDeleted: false, stage: { notIn: ['closed_won', 'closed_lost'] } },
            select: { id: true }
        });
        if (existingOpenOpportunity) {
            return res.status(400).json({ message: 'Lead already converted' });
        }

        // "Move to Pipeline" always creates the opportunity as 'prospecting' (Expected) regardless
        // of whatever the lead's status label currently says — a lead pre-marked 'won' still lands
        // in Expected and has to be moved to Closed Won explicitly afterward via the Opportunities
        // board. Only the dedicated Closed Won/Closed Lost quick-actions send an explicit `stage`.
        const effectiveStage = stage || 'prospecting';

        // Calculate opportunity amount from lead products if not provided
        let opportunityAmount = Number(amount) || 0;

        // If no amount provided, use lead's potentialValue or calculate from products
        if (!amount || opportunityAmount === 0) {
            if (lead.potentialValue && lead.potentialValue > 0) {
                console.log(`[convertLead] Using potentialValue ${lead.potentialValue} as fallback for amount`);
                opportunityAmount = lead.potentialValue;
            } else if (lead.products && lead.products.length > 0) {
                // Calculate from products
                opportunityAmount = lead.products.reduce((total, item) => {
                    return total + (item.price * item.quantity);
                }, 0);
                console.log(`[convertLead] Using product sum ${opportunityAmount} as fallback for amount`);
            }
        }

        // Use lead's organisationId to ensure deal stays in correct tenant
        const orgId = (lead.organisationId || userOrgId) as string;
        
        // 0. Limit Check
        const org = lead.organisation;
        /*
        if (org.contactLimit > 0) {
            const contactCount = await prisma.contact.count({
                where: { organisationId: orgId, isDeleted: false }
            });
            if (contactCount >= org.contactLimit) {
                return res.status(403).json({
                    message: `Contact limit reached (${org.contactLimit}). Please upgrade your plan.`,
                    code: 'LIMIT_EXCEEDED',
                    limit: org.contactLimit
                });
            }
        }
        */

        const result = await prisma.$transaction(async (tx) => {
            // Determine owner for new entities (preserve lead owner if assigned)
            const finalOwnerId = lead.assignedToId || user.id;

            // 1. Handle Account
            let targetAccountId = accountId;
            let account;

            if (targetAccountId) {
                account = await tx.account.findUnique({ where: { id: targetAccountId } });
                if (!account) throw new Error('Target account not found');
            } else {
                // Create new Account
                account = await tx.account.create({
                    data: {
                        name: accountName || lead.company || `${lead.firstName} ${lead.lastName || ''}`.trim(),
                        organisationId: orgId,
                        ownerId: finalOwnerId,
                        type: 'customer',
                        phone: lead.phone,
                        address: lead.address as any,
                        leadId: lead.id, // Link to original lead
                        branchId: lead.branchId || undefined
                    }
                });
                targetAccountId = account.id;
            }

            // 2. Create Contact
            let firstName = lead.firstName;
            let lastName = lead.lastName || '';

            if (contactName) {
                const parts = contactName.trim().split(/\s+/);
                if (parts.length > 1) {
                    lastName = parts.pop() || '';
                    firstName = parts.join(' ');
                } else {
                    firstName = contactName;
                    lastName = '';
                }
            }

            const contact = await tx.contact.create({
                data: {
                    firstName,
                    lastName,
                    email: lead.email,
                    phones: lead.phone ? [{ type: 'mobile', number: lead.phone }] : [],
                    jobTitle: lead.jobTitle,
                    organisationId: orgId,
                    ownerId: finalOwnerId,
                    accountId: targetAccountId,
                    address: lead.address as any,
                    customFields: lead.customFields as any, // Migrate custom fields
                    leadId: lead.id, // Link to original lead
                    branchId: lead.branchId || undefined
                }
            });

            // Determine default opportunity lead status
            let defaultOppStatus = 'new_opportunity';
            if (org.opportunityLeadStatuses && Array.isArray(org.opportunityLeadStatuses)) {
                const statuses = org.opportunityLeadStatuses as any[];
                const configuredDefault = statuses.find((s) => s.isDefault);
                if (configuredDefault) {
                    defaultOppStatus = configuredDefault.id;
                } else if (statuses.length > 0) {
                    defaultOppStatus = statuses[0].id;
                }
            }

            // 3. Create Opportunity
            const opportunity = await tx.opportunity.create({
                data: {
                    name: dealName || `Deal - ${lead.company || lead.lastName || lead.firstName}`,
                    amount: opportunityAmount,
                    stage: effectiveStage,
                    closeDate: new Date(), // Set to today by default instead of +30 days
                    organisationId: orgId,
                    ownerId: finalOwnerId,
                    accountId: targetAccountId,
                    leadId: lead.id,
                    branchId: lead.branchId || undefined,
                    pipelineId: lead.pipelineId || undefined, // Preserve pipeline context
                    contacts: { connect: { id: contact.id } },
                    lostReason: effectiveStage === 'closed_lost' ? lostReason : undefined,
                    leadStatus: defaultOppStatus
                }
            });

            // 4. Migrate Products from Lead to Account
            const leadProducts = await tx.leadProduct.findMany({
                where: { leadId: leadId },
                include: { product: true }
            });

            if (leadProducts.length > 0) {
                // Create AccountProduct entries for each LeadProduct
                for (const leadProduct of leadProducts) {
                    await tx.accountProduct.create({
                        data: {
                            accountId: targetAccountId,
                            productId: leadProduct.productId,
                            organisationId: orgId,
                            quantity: leadProduct.quantity,
                            price: leadProduct.price || 0, // Migrate custom price
                            customName: leadProduct.customName, // Migrate custom name
                            purchaseDate: new Date(),
                            status: 'active',
                            notes: `Converted from lead: ${lead.firstName} ${lead.lastName || ''}`.trim()
                        }
                    });
                }
            }

            // 5. Update Lead — reflect the opportunity's outcome directly on the lead when it's
            // created already closed (won/lost); otherwise it's just 'converted' (still open).
            const newLeadStatus = effectiveStage === 'closed_won' ? 'won' : effectiveStage === 'closed_lost' ? 'lost' : 'converted';
            const updatedLead = await tx.lead.update({
                where: { id: leadId },
                data: {
                    status: newLeadStatus
                }
            });

            // 6. Log History for Reporting
            await tx.leadHistory.create({
                data: {
                    leadId: leadId,
                    fieldName: 'status',
                    oldValue: lead.status,
                    newValue: newLeadStatus,
                    changedById: user.id,
                    reason: 'Lead Converted to Opportunity'
                }
            });

            // 6. Migrate Interactions
            await tx.interaction.updateMany({
                where: { leadId: leadId },
                data: {
                    contactId: contact.id,
                    accountId: targetAccountId
                }
            });

            // 7. Migrate WhatsApp Messages
            await tx.whatsAppMessage.updateMany({
                where: { leadId: leadId },
                data: {
                    contactId: contact.id
                }
            });

            // 8. Migrate Tasks
            await tx.task.updateMany({
                where: { leadId: leadId },
                data: {
                    leadId: null, // Unlink from lead
                    contactId: contact.id,
                    accountId: targetAccountId,
                    opportunityId: opportunity.id
                }
            });

            return { account, contact, opportunity, lead: updatedLead, migratedProducts: leadProducts.length };
        });

        // Audit Log for conversion
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CONVERT_LEAD',
                entity: 'Lead',
                entityId: leadId,
                actorId: user.id,
                organisationId: orgId,
                details: {
                    name: `${lead.firstName} ${lead.lastName || ''}`.trim(),
                    company: lead.company,
                    accountId: result.account.id,
                    contactId: result.contact.id,
                    opportunityId: result.opportunity.id,
                    migratedProducts: result.migratedProducts
                }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        // Notify Lead Owner
        if (lead.assignedToId && lead.assignedToId !== user.id) {
            const { NotificationService } = await import('../services/notificationService');
            const leadName = `${lead.firstName} ${lead.lastName || ''}`.trim();
            NotificationService.send(
                lead.assignedToId,
                'Lead Moved to Pipeline',
                `Your lead "${leadName}" has been moved to the pipeline by ${user.firstName}.`,
                'info'
            ).catch(console.error);
        }

        // --- Handle Immediate Closure Logic (payment is AWAITED to ensure PaymentRecord rows are written) ---
        if (stage === 'closed_won' && result.opportunity) {
            const oppId = result.opportunity.id;

            try {
                if (paymentType === 'paid') {
                    const PaymentService = (await import('../services/paymentService')).default;
                    await PaymentService.recordFullPayment(oppId, user.id, orgId);
                } else if (paymentType === 'partial') {
                    const PaymentService = (await import('../services/paymentService')).default;
                    if (paidAmount > 0) {
                        await PaymentService.recordPartialPayment(oppId, paidAmount, user.id, orgId);
                    }
                    if (installments && installments.length > 0) {
                        const EMIService = (await import('../services/emiService')).default;
                        await EMIService.convertToEMI(oppId, installments, orgId);
                    }
                } else if (paymentType === 'emi') {
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
                // Payment processing failed — roll back paymentStatus on opportunity to avoid mismatch
                console.error('[convertLead] Payment recording failed, rolling back paymentStatus:', paymentError);
                await prisma.opportunity.update({
                    where: { id: oppId },
                    data: { paymentStatus: 'pending' }
                }).catch(e => console.error('[convertLead] Rollback failed:', e));
            }

            // Target/Goal Updates
            import('../services/salesTargetService').then(({ SalesTargetService }) => {
                SalesTargetService.updateProgressForUser(result.opportunity.ownerId!).catch(console.error);
            });
            import('../services/goalService').then(({ GoalService }) => {
                GoalService.updateProgressForUser(result.opportunity.ownerId!, 'revenue').catch(console.error);
            });

            // Hierarchy Notification
            try {
                if (paymentType && (paymentType === 'paid' || paymentType === 'partial' || paymentType === 'emi')) {
                    const { NotificationService } = await import('../services/notificationService');
                    const owner = await prisma.user.findUnique({
                        where: { id: result.opportunity.ownerId! },
                        select: { reportsToId: true, firstName: true, lastName: true }
                    });

                    if (owner && owner.reportsToId) {
                        let paymentMessage = '';
                        if (paymentType === 'paid') paymentMessage = `Full payment of ₹${result.opportunity.amount.toLocaleString('en-IN')} received.`;
                        else if (paymentType === 'partial') paymentMessage = `Partial payment of ₹${paidAmount?.toLocaleString('en-IN')} received (Total: ₹${result.opportunity.amount.toLocaleString('en-IN')}).`;
                        else if (paymentType === 'emi') paymentMessage = `EMI payment plan initiated for ₹${result.opportunity.amount.toLocaleString('en-IN')}.`;

                        await NotificationService.sendToHierarchy(
                            result.opportunity.ownerId!,
                            'Sale Closed with Payment! 🎉💰',
                            `${owner.firstName} ${owner.lastName} closed a deal "${result.opportunity.name}". ${paymentMessage}`,
                            'success'
                        );
                    }
                }
            } catch (notifyErr) {
                console.error('Hierarchy notification error:', notifyErr);
            }
        }

        res.json({
            message: 'Lead converted successfully',
            data: result
        });

    } catch (error) {
        console.error('Lead conversion error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

import fs from 'fs';
import path from 'path';

const logDebug = (msg: string) => {
    try {
        const logPath = path.join(__dirname, '../../debug_crash.log');
        fs.appendFileSync(logPath, `${new Date().toISOString()} - [Leads] ${msg}\n`);
    } catch (e) {
        console.error('Failed to write log', e);
    }
};

export const getViolations = async (req: express.Request, res: express.Response) => {
    try {
        logDebug('Entered getViolations');
        const user = (req as any).user;
        const pageSize = Number(req.query.pageSize) || 10;
        const page = Number(req.query.page) || 1;
        logDebug(`User: ${user?.id}, Role: ${user?.role}`);

        // User sees violations where they were the PREVIOUS owner (the one who failed)
        // OR if they are a manager, seeing violations of their subordinates?
        // Prompt says "user and their managers need to give an explanation".

        const where: any = {
            rotationViolation: true,
            isDeleted: false,
        };

        if (user.role !== 'super_admin') {
            const orgId = getOrgId(user);
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;

            let visibleUserIds: string[] = [];
            try {
                logDebug('Fetching visible users...');
                visibleUserIds = await getVisibleUserIds(user.id);
                logDebug(`Visible users found: ${visibleUserIds.length}`);
            } catch (subError) {
                logDebug(`Error fetching visible users: ${(subError as Error).message}`);
                console.error('[getViolations] Error fetching visible users:', subError);
                visibleUserIds = [user.id];
            }

            where.previousOwnerId = { in: visibleUserIds };
        }

        logDebug(`[Leads] Querying Prisma with where: ${JSON.stringify(where)}`);
        const violations = await prisma.lead.findMany({
            where,
            include: {
                previousOwner: { select: { firstName: true, lastName: true } },
                assignedTo: { select: { firstName: true, lastName: true } }
            },
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { violationTime: 'desc' }
        });

        logDebug(`[Leads] Violations found: ${violations.length}`);

        const total = await prisma.lead.count({ where });
        res.json({ violations, page, pages: Math.ceil(total / pageSize), total });

    } catch (error) {
        logDebug(`getViolations CRASHED: ${(error as Error).message}\nStack: ${(error as Error).stack}`);
        console.error('[getViolations] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getLeadHistory = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const user = (req as any).user;

        // Verify access (simple org check)
        const lead = await prisma.lead.findUnique({ where: { id } });
        const orgId = getOrgId(user);

        if (!lead || (orgId && lead.organisationId !== orgId && user.role !== 'super_admin')) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        const history = await prisma.leadHistory.findMany({
            where: { leadId: id },
            include: {
                oldOwner: { select: { firstName: true, lastName: true } },
                newOwner: { select: { firstName: true, lastName: true } },
                changedBy: { select: { firstName: true, lastName: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(history);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * Full per-event re-enquiry history for a single lead - every time this phone
 * number enquired again, not just the current merged state (which is all
 * `GET /leads/re-enquiries` and the Lead record itself show). Backs the
 * mobile app's "Re-Enquiry History" tab.
 *
 * Every event has an 'Re-Enquiry Received' Interaction (created since this
 * feature's inception) and a matching entry (same index, both appended once
 * per event in DuplicateLeadService.handleReEnquiry) in
 * Lead.sourceDetails.reEnquiries[]. Events from before the richer snapshot
 * fields (submittedName/submittedPhone/submittedEmail) were added only have
 * a name, recovered from the interaction's logged text - older re-enquiries
 * can still be viewed, just without phone/email to split off with.
 */
export const getReEnquiryHistory = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const user = (req as any).user;
        const orgId = getOrgId(user);

        const lead = await prisma.lead.findUnique({
            where: { id },
            select: {
                id: true,
                organisationId: true,
                isDeleted: true,
                sourceDetails: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
                reEnquiryCount: true,
                isReEnquiry: true
            }
        });

        if (!lead || lead.isDeleted || (orgId && lead.organisationId !== orgId && user.role !== 'super_admin')) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        const reEnquiryInteractions = await prisma.interaction.findMany({
            where: { leadId: id, subject: 'Re-Enquiry Received' },
            select: { description: true, date: true, createdAt: true },
            orderBy: { createdAt: 'asc' }
        });

        const snapshots: any[] = (lead.sourceDetails as any)?.reEnquiries || [];

        const events = reEnquiryInteractions.map((interaction, index) => {
            const snapshot = snapshots[index];
            const nameMatch = (interaction.description || '').match(/^Lead (.+?) has enquired again/);
            const nameAtReEnquiryTime = nameMatch ? nameMatch[1].trim() : null;

            return {
                eventIndex: index,
                date: interaction.date,
                name: snapshot?.submittedName || nameAtReEnquiryTime || null,
                phone: snapshot?.submittedPhone || null,
                email: snapshot?.submittedEmail || null,
                source: snapshot?.source || null,
                hasFullSnapshot: !!(snapshot?.submittedPhone || snapshot?.submittedEmail),
                alreadySplitLeadId: snapshot?.splitIntoLeadId || null
            };
        }).reverse(); // most recent first

        res.json({
            leadId: lead.id,
            currentName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
            currentPhone: lead.phone,
            currentEmail: lead.email,
            reEnquiryCount: lead.reEnquiryCount,
            events
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * Manually splits one past re-enquiry event off into its own, separate Lead
 * row - for when a rep looks at the re-enquiry history and recognizes it was
 * actually a different person sharing (or mistyping into) the same phone
 * number as the original lead, not the same customer.
 *
 * Deliberately requires `confirmed: true` from the caller - the frontend/
 * mobile UI is expected to show an explicit warning first, since the new
 * lead necessarily shares the original's phone number (or the event's own
 * submitted phone, if one was captured) and could get matched back onto
 * either lead on a future re-enquiry. This is a known, accepted tradeoff of
 * a manual split, not something this endpoint can fully prevent.
 */
export const splitReEnquiryIntoLead = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const { eventIndex, confirmed } = req.body;
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!confirmed) {
            return res.status(400).json({
                message: 'This action must be explicitly confirmed - it creates a lead sharing the same phone number as the original.'
            });
        }
        if (typeof eventIndex !== 'number' || eventIndex < 0) {
            return res.status(400).json({ message: 'A valid eventIndex is required' });
        }

        const lead = await prisma.lead.findUnique({ where: { id } });
        if (!lead || lead.isDeleted || (orgId && lead.organisationId !== orgId && user.role !== 'super_admin')) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        const snapshots: any[] = (lead.sourceDetails as any)?.reEnquiries || [];
        const snapshot = snapshots[eventIndex];

        if (snapshot?.splitIntoLeadId) {
            return res.status(400).json({
                message: 'This re-enquiry has already been split into a separate lead',
                leadId: snapshot.splitIntoLeadId
            });
        }

        let recoveredName: string | null = snapshot?.submittedName || null;
        if (!recoveredName) {
            const interactions = await prisma.interaction.findMany({
                where: { leadId: id, subject: 'Re-Enquiry Received' },
                select: { description: true },
                orderBy: { createdAt: 'asc' }
            });
            const match = (interactions[eventIndex]?.description || '').match(/^Lead (.+?) has enquired again/);
            recoveredName = match ? match[1].trim() : null;
        }
        if (!recoveredName) {
            return res.status(400).json({ message: 'No name could be recovered for this re-enquiry event' });
        }

        const parts = recoveredName.split(/\s+/);
        const newLastName = parts.length > 1 ? parts.pop()! : null;
        const newFirstName = parts.join(' ') || recoveredName;

        // branchId is deliberately left null (unassigned) rather than copied
        // from the original lead - Lead's [phone, organisationId, branchId]
        // unique constraint would otherwise reject this insert outright,
        // since this is by definition the same phone number as the original
        // (that's exactly why a manual split was needed instead of just
        // editing the name).
        const newLead = await prisma.lead.create({
            data: {
                firstName: newFirstName,
                lastName: newLastName,
                phone: snapshot?.submittedPhone || lead.phone,
                email: snapshot?.submittedEmail || null,
                organisationId: lead.organisationId,
                branchId: null,
                assignedToId: lead.assignedToId,
                createdById: user.id,
                source: lead.source,
                status: 'new',
                originalLeadId: lead.id,
                sourceDetails: {
                    splitFromLeadId: lead.id,
                    splitFromEventIndex: eventIndex,
                    splitFromEventDate: snapshot?.date || null,
                    note: `Manually split off from lead ${lead.id}'s re-enquiry history by user ${user.id} - flagged as a different person sharing the same phone number.`
                }
            }
        });

        if (snapshot) {
            snapshots[eventIndex] = { ...snapshot, splitIntoLeadId: newLead.id };
            await prisma.lead.update({
                where: { id: lead.id },
                data: { sourceDetails: { ...(lead.sourceDetails as any || {}), reEnquiries: snapshots } }
            });
        }

        await prisma.interaction.create({
            data: {
                type: 'other',
                direction: 'inbound',
                subject: 'Re-Enquiry Split Into New Lead',
                description: `Re-enquiry from "${recoveredName}" (event #${eventIndex + 1}) was split into a new lead (${newLead.id}) - flagged as a different person sharing this phone number.`,
                date: new Date(),
                leadId: lead.id,
                createdById: user.id,
                organisationId: lead.organisationId
            }
        });

        res.status(201).json({ newLeadId: newLead.id });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};


export const submitExplanation = async (req: express.Request, res: express.Response) => {
    try {
        const { leadId, explanation, type } = req.body; // type = 'user' | 'manager'
        const user = (req as any).user;

        const lead = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        if (!lead.rotationViolation) {
            return res.status(400).json({ message: 'This lead is not flagged for violation' });
        }

        const data: any = {};

        if (type === 'user') {
            if (lead.previousOwnerId !== user.id && !isAdmin(user) && !user.isSuperAdmin) {
                return res.status(403).json({ message: 'Only the previous owner can submit a user explanation' });
            }
            data.userExplanation = explanation;
        } else if (type === 'manager') {
            // Check if user is manager of previousOwner
            // Ideally we check hierarchy properly.
            // For MVP, if user is admin or has subordinates including previousOwner
            const userRole = await prisma.role.findFirst({
                where: {
                    OR: [
                        { id: user.role },
                        { roleKey: user.role, organisationId: user.organisationId },
                        { roleKey: user.role, organisationId: null }
                    ]
                }
            });
            if (userRole && userRole.name === 'Sales Rep') {
                return res.status(403).json({ message: 'Sales reps cannot submit manager explanations' });
            }
            data.managerExplanation = explanation;
        } else {
            return res.status(400).json({ message: 'Invalid explanation type' });
        }

        const updatedLead = await prisma.lead.update({
            where: { id: leadId },
            data
        });

        res.json(updatedLead);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getPendingFollowUpsCount = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const now = new Date();
        const endOfToday = new Date(now.setHours(23, 59, 59, 999));

        const where: any = {
            nextFollowUp: { lte: endOfToday },
            status: { not: 'converted' },
            isDeleted: false
        };

        if (user.role !== 'super_admin') {
            const orgId = getOrgId(user);
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
        }

        // Daily Briefing is personal
        where.assignedToId = user.id;

        const leads = await prisma.lead.findMany({
            where,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                nextFollowUp: true,
                company: true
            },
            orderBy: { nextFollowUp: 'asc' }
        });

        res.json({ count: leads.length, leads });
    } catch (error) {
        console.error('[getPendingFollowUpsCount] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

export const suggestNextStep = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(403).json({ message: 'No organisation context' });

        const { NextStepService } = await import('../services/nextStepService');
        const suggestion = await NextStepService.suggestNextStep(id, orgId);

        res.json(suggestion);
    } catch (error) {
        console.error('[suggestNextStep] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

export const generateAIResponse = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const { context } = req.body; // e.g. "Draft an intro email"

        const lead = await prisma.lead.findUnique({ where: { id } });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        // Lazy load OpenAI
        const { OpenAI } = await import('openai');
        if (!process.env.OPENAI_API_KEY) {
            return res.json({ draft: `[Mock AI Draft]\n\nHi ${lead.firstName},\n\nI noticed you work at ${lead.company}. We'd love to chat.\n\nBest,\n[Your Name]` });
        }

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "You are a helpful sales assistant. Draft a short, professional email." },
                { role: "user", content: `Lead: ${lead.firstName} ${lead.lastName} from ${lead.company}. Title: ${lead.jobTitle}. Context: ${context || 'Introduction'}` }
            ],
        });

        res.json({ draft: completion.choices[0].message.content });

    } catch (error) {
        console.error('[generateAIResponse] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};



// GET /api/leads/re-enquiries - Get all re-enquiry leads
export const getReEnquiryLeads = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(403).json({ message: 'No organisation context' });

        // Enforce hierarchy: Managers only see their branch's re-enquiries
        let branchId = undefined;
        if (!isAdmin(user) && !isOrgAdmin(user) && user.branchId) {
            branchId = user.branchId;
        }

        const DuplicateLeadService = (await import('../services/duplicateLeadService')).default;
        const reEnquiryLeads = await DuplicateLeadService.getReEnquiryLeads(orgId, branchId);

        res.json({
            leads: reEnquiryLeads,
            count: reEnquiryLeads.length
        });
    } catch (error) {
        console.error('getReEnquiryLeads Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/leads/duplicates - Find all duplicate leads
export const getDuplicateLeads = async (req: express.Request, res: express.Response) => {
    try {
        const orgId = getOrgId((req as any).user);
        if (!orgId) return res.status(403).json({ message: 'No organisation context' });

        const DuplicateLeadService = (await import('../services/duplicateLeadService')).default;
        const duplicates = await DuplicateLeadService.findDuplicates(orgId);

        res.json({
            duplicates,
            count: duplicates.length
        });
    } catch (error) {
        console.error('getDuplicateLeads Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/leads/unattended
// Leads that have been ASSIGNED to a rep but are still sitting in "new" — i.e.
// nobody has worked them yet. Same definition as the "Unattended" metric on the
// Performance Report (reportController.ts) and the Dashboard's lead-health card.
export const getUnattendedLeads = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(403).json({ message: 'No organisation context' });

        const pageSize = Number(req.query.pageSize) || 50;
        const page = Number(req.query.page) || 1;

        const isSuperAdminUser = user.isSuperAdmin || isSuperAdmin(user);
        const visibilityFilter = await getLeadVisibilityFilter(user, isSuperAdminUser);

        // `interactions: { none: {} }` (no filter conditions inside `none`) compiles
        // to an UNCORRELATED, ORG-UNSCOPED `NOT IN (SELECT leadId FROM Interaction
        // WHERE leadId IS NOT NULL)` — scanning every organisation's Interaction rows
        // platform-wide, not just this org's. That's what was timing out this page in
        // production. Fetching this org's own interacted lead ids first (via
        // `Interaction.organisationId`, already indexed) and excluding them via
        // `id: { notIn }` avoids the bad codegen — see the identical fix + longer
        // explanation on `getLeadHealth` in analyticsController.ts.
        const interactedLeadIds = (
            await prisma.interaction.findMany({
                where: { organisationId: orgId, leadId: { not: null } },
                select: { leadId: true },
                distinct: ['leadId'],
            })
        ).map((i) => i.leadId as string);

        const where: any = {
            organisationId: orgId,
            isDeleted: false,
            status: 'new',
            // Owner filter narrows WHO it's assigned to; without one, still require
            // it to be assigned to *someone* — that's the whole definition of "unattended".
            assignedToId: req.query.assignedTo ? (req.query.assignedTo as string) : { not: null },
            // A lead can sit at status "new" while still having real activity logged
            // against it (a rep called but hasn't updated the stage yet) — that's not
            // actually unattended. Only flag it when the interaction timeline is
            // genuinely empty, i.e. nobody has done anything with it at all.
            id: { notIn: interactedLeadIds },
            ...visibilityFilter,
        };
        if (req.query.branchId) where.branchId = req.query.branchId as string;
        if (req.query.source && Object.values(LeadSource).includes(req.query.source as LeadSource)) {
            where.source = req.query.source as LeadSource;
        }
        const createdAtFilter = buildCreatedAtDateFilter(req);
        if (createdAtFilter) where.createdAt = createdAtFilter;

        const [total, leads] = await Promise.all([
            prisma.lead.count({ where }),
            prisma.lead.findMany({
                where,
                include: {
                    assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
                // Oldest-assigned-first — the longer a lead has sat untouched, the more urgent it is.
                orderBy: { createdAt: 'asc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);

        res.json({ leads, page, pages: Math.ceil(total / pageSize), total });
    } catch (error) {
        console.error('getUnattendedLeads Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/leads/no-activity
// Leads that aren't already closed (converted/lost) and haven't had any field/
// status update in 30+ days — i.e. gone cold. Same definition as the
// Dashboard's lead-health card, minus the client-side "no-activity" quick view
// on the main Leads list (which doesn't exclude closed leads).
export const getNoActivityLeads = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(403).json({ message: 'No organisation context' });

        const pageSize = Number(req.query.pageSize) || 50;
        const page = Number(req.query.page) || 1;

        const isSuperAdminUser = user.isSuperAdmin || isSuperAdmin(user);
        const visibilityFilter = await getLeadVisibilityFilter(user, isSuperAdminUser);

        const staleThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const where: any = {
            organisationId: orgId,
            isDeleted: false,
            // A specific stage filter narrows within the open set; without one, still
            // exclude closed leads — those naturally stop changing and shouldn't count.
            status: req.query.status ? (req.query.status as string) : { notIn: ['converted', 'lost'] },
            updatedAt: { lt: staleThreshold },
            // Don't rely on updatedAt alone — it's only a proxy for "somebody touched this
            // record" and can miss gaps in whichever code path logged the interaction.
            // Directly confirm there's no call/WhatsApp/email/meeting/note of any kind in
            // the same window before calling a lead "no activity".
            interactions: { none: { date: { gte: staleThreshold } } },
            ...visibilityFilter,
        };
        if (req.query.branchId) where.branchId = req.query.branchId as string;
        if (req.query.assignedTo) where.assignedToId = req.query.assignedTo as string;
        if (req.query.source && Object.values(LeadSource).includes(req.query.source as LeadSource)) {
            where.source = req.query.source as LeadSource;
        }
        const createdAtFilter = buildCreatedAtDateFilter(req);
        if (createdAtFilter) where.createdAt = createdAtFilter;

        const [total, leads] = await Promise.all([
            prisma.lead.count({ where }),
            prisma.lead.findMany({
                where,
                include: {
                    assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
                // Most-stale-first — the longest-untouched leads surface at the top.
                orderBy: { updatedAt: 'asc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);

        res.json({ leads, page, pages: Math.ceil(total / pageSize), total });
    } catch (error) {
        console.error('getNoActivityLeads Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/leads/:id/sync-gallabox
export const syncToGallabox = async (req: express.Request, res: express.Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const leadId = req.params.id;

        if (!orgId) return res.status(403).json({ message: 'Organisation context required' });

        const lead = await prisma.lead.findUnique({
            where: { id: leadId, organisationId: orgId }
        });

        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        const gallabox = await GallaboxService.getClientForOrg(orgId);
        if (!gallabox) {
            return res.status(400).json({ message: 'Gallabox is not connected or configured for your organisation.' });
        }

        const result = await gallabox.syncLeadToContact(lead);

        res.json({
            success: true,
            message: 'Lead successfully synced to Gallabox',
            result
        });
    } catch (error: any) {
        console.error('syncToGallabox Error:', error);
        res.status(500).json({ message: error.message });
    }
};
