import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId, getVisibleUserIds } from '../utils/hierarchyUtils';
import { Prisma } from '../generated/client';
import { FollowUpService } from '../services/followUpService';
import { logAudit } from '../utils/auditLogger';
import { emitToOrg } from '../socket';
import { NotificationService } from '../services/notificationService';

// GET /api/follow-ups - Get all follow-up tasks for user and subordinates
export const getFollowUps = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string || '1');
        const limit = parseInt(req.query.limit as string || '20');
        const search = req.query.search as string;
        const status = req.query.status as string;
        const skip = (page - 1) * limit;
        const user = (req as any).user;

        console.log('[getFollowUps] User:', user.id, user.role, user.email);

        const where: Prisma.FollowUpWhereInput = {
            isDeleted: false
        };

        // 1. Organisation Scoping
        if (user.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = String(req.query.organisationId);
            }
        } else {
            const orgId = getOrgId(user);
            console.log('[getFollowUps] Org ID:', orgId);
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
        }

        // 2. Hierarchy Visibility - a follow-up "belongs to" whoever it's
        // ASSIGNED to, full stop - not whoever owns the related lead/contact/
        // account/opportunity. That used to also be a source of visibility
        // (see git history on this block), which meant a rep with no
        // subordinates could see OTHER people's follow-up tasks just because
        // they happened to sit on a lead assigned to her - Ajeena's own "My
        // Day" dashboard was showing 24 overdue items (14 of them literally
        // assigned to other reps) instead of the 10 actually hers, while a
        // manager filtering the list by her name correctly showed 10. Both
        // views now agree: assignedTo (plus your own not-yet-assigned
        // creations) is the one definition of "your follow-ups", everywhere.
        const isAdmin = user.role === 'super_admin' || user.role === 'admin';
        const requestedUserId = req.query.userId as string;
        const isFilteringByUser = requestedUserId && requestedUserId !== 'all';

        if (!isAdmin) {
            const visibleUserIds = await getVisibleUserIds(user.id);

            if (isFilteringByUser) {
                // A specific-user filter (e.g. a manager picking a report from the
                // "Assigned To" dropdown): confirm the target is someone the caller
                // can see, then filter directly by their assignedToId - not ANDed
                // on top of the caller's own OR-block below, which would otherwise
                // re-derive (and potentially distort) visibility through the
                // caller's own conditions instead of the target user's.
                if (!visibleUserIds.includes(requestedUserId)) {
                    return res.status(403).json({ message: 'You do not have visibility into this user\'s follow-ups' });
                }
            } else {
                where.OR = [
                    // Follow-ups assigned to user or subordinates
                    { assignedToId: { in: visibleUserIds } },
                    // Follow-ups created by user or subordinates, but ONLY while still
                    // unassigned - once a follow-up is handed to someone else (shuffler
                    // reassignment, manual reassign, etc.), the creator shouldn't keep
                    // seeing it in their own list forever. If the new assignee happens to
                    // be a subordinate, the `assignedToId` branch above already covers it;
                    // this branch existing without the assignedToId:null guard is what let
                    // a creator and a later assignee both see the same "due today" entry
                    // and both independently contact the lead (reported for Musadhiq at
                    // Edufolio, reassigned from Jasna to Swathi via the shuffler).
                    { createdById: { in: visibleUserIds }, assignedToId: null }
                ];
            }
        }

        if (search) {
            const searchConditions = [
                { subject: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                { lead: { firstName: { contains: search, mode: 'insensitive' } } },
                { lead: { lastName: { contains: search, mode: 'insensitive' } } },
                { lead: { company: { contains: search, mode: 'insensitive' } } },
                { contact: { firstName: { contains: search, mode: 'insensitive' } } },
                { contact: { lastName: { contains: search, mode: 'insensitive' } } },
                { account: { name: { contains: search, mode: 'insensitive' } } },
                { opportunity: { name: { contains: search, mode: 'insensitive' } } },
                { assignedTo: { firstName: { contains: search, mode: 'insensitive' } } },
                { assignedTo: { lastName: { contains: search, mode: 'insensitive' } } }
            ];

            if (!where.AND) where.AND = [];
            (where.AND as any[]).push({ OR: searchConditions });
        }

        if (status) {
            if (status !== 'all') {
                where.status = status as any;
            }
            // If status is 'all', we omit where.status to return all statuses (active, completed, deferred)
        } else {
            where.status = { in: ['not_started', 'in_progress'] };
        }
        
        const branchId = req.query.branchId as string;
        if (branchId && branchId !== 'all') {
            if (!where.AND) where.AND = [];
            (where.AND as any[]).push({
                OR: [
                    { branchId: branchId },
                    { lead: { branchId: branchId } },
                    { opportunity: { branchId: branchId } },
                    { contact: { branchId: branchId } },
                    { account: { branchId: branchId } }
                ]
            });
        }

        if (isFilteringByUser) {
            where.assignedToId = requestedUserId;
        }

        console.log('[getFollowUps] Final query where:', JSON.stringify(where, null, 2));

        const count = await prisma.followUp.count({ where });
        console.log('[getFollowUps] Count:', count);

        const followUps = await prisma.followUp.findMany({
            where,
            include: {
                assignedTo: { select: { firstName: true, lastName: true, email: true } },
                createdBy: { select: { firstName: true, lastName: true, email: true } },
                lead: {
                    where: { isDeleted: false },
                    select: { id: true, firstName: true, lastName: true, company: true }
                },
                contact: { select: { id: true, firstName: true, lastName: true } },
                account: { select: { id: true, name: true } },
                opportunity: { select: { id: true, name: true } },
                branch: { select: { id: true, name: true } },
            },
            skip,
            take: limit,
            orderBy: { dueDate: 'asc' }
        });

        console.log('[getFollowUps] Follow-ups found:', followUps.length);

        // Transform follow-ups to include relatedTo for Frontend compatibility
        const transformedFollowUps = followUps.map(followUp => {
            let relatedTo = null;
            let onModel = null;

            if (followUp.lead) { relatedTo = followUp.lead; onModel = 'Lead'; }
            else if (followUp.contact) { relatedTo = followUp.contact; onModel = 'Contact'; }
            else if (followUp.account) { relatedTo = followUp.account; onModel = 'Account'; }
            else if (followUp.opportunity) { relatedTo = followUp.opportunity; onModel = 'Opportunity'; }

            return {
                ...followUp,
                relatedTo,
                onModel
            };
        });

        const baseWhere = { ...where };
        delete baseWhere.status;

        const now = new Date();
        const endOfToday = (() => {
            const istTime = now.getTime() + (5.5 * 60 * 60 * 1000);
            const istDate = new Date(istTime);
            const endOfTodayIST = new Date(Date.UTC(
                istDate.getUTCFullYear(),
                istDate.getUTCMonth(),
                istDate.getUTCDate(),
                23, 59, 59, 999
            ));
            return new Date(endOfTodayIST.getTime() - (5.5 * 60 * 60 * 1000));
        })();

        // `overdue`/`today` split on `now` (the exact instant), not on the
        // start of the IST calendar day. Every per-card "Overdue" badge —
        // both `FollowUpMobileCard.tsx` (web, via date-fns `isPast`) and
        // Dad-mobile's `FollowUpCard` (`dueDate.isBefore(now)`) — already
        // uses precise-instant comparison, so a follow-up due earlier today
        // (already past) correctly renders "Overdue" on its own card. The
        // old `dueDate < startOfToday` cutoff here counted that same
        // follow-up under "today" instead, so the stat card's Overdue total
        // silently undercounted anything overdue-by-hours-not-days within
        // the current day — exactly the mismatch reported: a user's card
        // list showing overdue items while their own stat card read 0.
        const [activeCount, overdueCount, todayCount, upcomingCount] = await Promise.all([
            prisma.followUp.count({
                where: {
                    ...baseWhere,
                    status: { in: ['not_started', 'in_progress'] }
                }
            }),
            prisma.followUp.count({
                where: {
                    ...baseWhere,
                    status: { in: ['not_started', 'in_progress'] },
                    dueDate: { lt: now }
                }
            }),
            prisma.followUp.count({
                where: {
                    ...baseWhere,
                    status: { in: ['not_started', 'in_progress'] },
                    dueDate: { gte: now, lte: endOfToday }
                }
            }),
            prisma.followUp.count({
                where: {
                    ...baseWhere,
                    status: { in: ['not_started', 'in_progress'] },
                    dueDate: { gt: endOfToday }
                }
            })
        ]);

        res.json({
            tasks: transformedFollowUps, // Keep 'tasks' key for backward compat with frontend if needed, or change to 'followUps'
            page,
            totalPages: Math.ceil(count / limit),
            totalTasks: count,
            counts: {
                active: activeCount,
                overdue: overdueCount,
                today: todayCount,
                upcoming: upcomingCount
            }
        });
    } catch (error) {
        console.error('[getFollowUps] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/follow-ups - Create a new follow-up
export const createFollowUp = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { subject, description, priority, dueDate, relatedTo, onModel, assignedToId } = req.body;

        if (!dueDate) {
            return res.status(400).json({ message: 'Due date is required for follow-ups' });
        }

        const data: any = {
            subject,
            description,
            priority: priority || 'medium',
            status: 'not_started',
            dueDate: new Date(dueDate),
            organisationId: orgId,
            createdById: user.id,
            assignedToId: assignedToId || user.id,
            branchId: user.branchId
        };

        if (relatedTo && onModel) {
            if (onModel === 'Lead') data.leadId = relatedTo;
            else if (onModel === 'Contact') data.contactId = relatedTo;
            else if (onModel === 'Account') data.accountId = relatedTo;
            else if (onModel === 'Opportunity') data.opportunityId = relatedTo;
        }

        const followUp = await FollowUpService.createFollowUp(data);

        // Sync Lead follow-up date
        if (data.leadId) {
            await FollowUpService.syncLeadFollowUp(data.leadId);
        }

        if (orgId) {
            await logAudit({
                organisationId: orgId,
                actorId: user.id,
                action: 'CREATE_FOLLOW_UP',
                entity: 'FollowUp',
                entityId: followUp.id,
                details: { subject: followUp.subject }
            });

            // Real-time signal for the Follow-ups page - previously a brand-new
            // follow-up gave the assignee zero indication anything changed
            // (no socket emit, no notification at all), so it could sit
            // invisible in their stale cached list/Overdue count for up to
            // this app's 5-minute TanStack Query staleTime.
            emitToOrg(orgId, 'followup_created', { followUpId: followUp.id, assignedToId: followUp.assignedToId });
        }

        if (followUp.assignedToId && followUp.assignedToId !== user.id) {
            NotificationService.send(
                followUp.assignedToId,
                'New Follow-up Assigned',
                `You have a new follow-up: ${followUp.subject}`,
                'info',
                { resource: 'FollowUp', id: followUp.id }
            ).catch(err => console.error('[createFollowUp] Failed to notify assignee:', err));
        }

        res.status(201).json(followUp);
    } catch (error) {
        console.error('[createFollowUp] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// PUT /api/follow-ups/:id - Update a follow-up
export const updateFollowUp = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const user = (req as any).user;
        const { status, dueDate, subject, description, priority, assignedToId } = req.body;

        const followUp = await prisma.followUp.findUnique({
            where: { id },
            include: { 
                createdBy: true, 
                assignedTo: true,
                lead: true,
                contact: true,
                account: true,
                opportunity: true
            }
        });

        if (!followUp) {
            return res.status(404).json({ message: 'Follow-up not found' });
        }

        const isCreator = followUp.createdById === user.id;
        const isAssignee = followUp.assignedToId === user.id;
        const isAdmin = user.role === 'admin' || user.role === 'super_admin';

        let isAuthorized = isCreator || isAssignee || isAdmin;

        if (!isAuthorized) {
            // Check hierarchy and related entity ownership
            const visibleUserIds = await getVisibleUserIds(user.id);
            
            const isCreatedBySubordinate = followUp.createdById ? visibleUserIds.includes(followUp.createdById) : false;
            const isAssignedToSubordinate = followUp.assignedToId ? visibleUserIds.includes(followUp.assignedToId) : false;
            
            const isLeadOwner = followUp.lead?.assignedToId ? visibleUserIds.includes(followUp.lead.assignedToId) : false;
            const isContactOwner = (followUp.contact as any)?.ownerId ? visibleUserIds.includes((followUp.contact as any).ownerId) : false;
            const isAccountOwner = (followUp.account as any)?.ownerId ? visibleUserIds.includes((followUp.account as any).ownerId) : false;
            const isOpportunityOwner = (followUp.opportunity as any)?.ownerId ? visibleUserIds.includes((followUp.opportunity as any).ownerId) : false;

            if (isCreatedBySubordinate || isAssignedToSubordinate || isLeadOwner || isContactOwner || isAccountOwner || isOpportunityOwner) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: 'Not authorized to update this follow-up' });
        }

        const updatedFollowUp = await prisma.followUp.update({
            where: { id },
            data: {
                ...(status && { status }),
                ...(dueDate && { dueDate: new Date(dueDate) }),
                ...(subject && { subject }),
                ...(description !== undefined && { description }),
                ...(priority && { priority }),
                ...(assignedToId !== undefined && { assignedToId })
            },
            include: {
                assignedTo: { select: { firstName: true, lastName: true, email: true } },
                createdBy: { select: { firstName: true, lastName: true, email: true } },
                lead: {
                    where: { isDeleted: false },
                    select: { id: true, firstName: true, lastName: true, company: true }
                },
                contact: { select: { id: true, firstName: true, lastName: true } },
                account: { select: { id: true, name: true } },
                opportunity: { select: { id: true, name: true } },
            }
        });

        // Sync Lead follow-up date
        if (updatedFollowUp.leadId) {
            await FollowUpService.syncLeadFollowUp(updatedFollowUp.leadId);
        }

        // Same real-time gap as createFollowUp above - a reassignment (or any
        // status/dueDate edit) previously never told anyone, so the new
        // assignee's Follow-ups page could sit stale for up to 5 minutes.
        const orgIdForEmit = getOrgId(user) || followUp.organisationId;
        if (orgIdForEmit) {
            emitToOrg(orgIdForEmit, 'followup_updated', { followUpId: updatedFollowUp.id, assignedToId: updatedFollowUp.assignedToId });
        }

        const wasReassigned = assignedToId !== undefined && assignedToId !== followUp.assignedToId;
        if (wasReassigned && updatedFollowUp.assignedToId && updatedFollowUp.assignedToId !== user.id) {
            NotificationService.send(
                updatedFollowUp.assignedToId,
                'Follow-up Assigned to You',
                `A follow-up was assigned to you: ${updatedFollowUp.subject}`,
                'info',
                { resource: 'FollowUp', id: updatedFollowUp.id }
            ).catch(err => console.error('[updateFollowUp] Failed to notify new assignee:', err));
        }

        // Transform response
        let relatedTo = null;
        let onModel = null;

        if (updatedFollowUp.lead) { relatedTo = updatedFollowUp.lead; onModel = 'Lead'; }
        else if (updatedFollowUp.contact) { relatedTo = updatedFollowUp.contact; onModel = 'Contact'; }
        else if (updatedFollowUp.account) { relatedTo = updatedFollowUp.account; onModel = 'Account'; }
        else if (updatedFollowUp.opportunity) { relatedTo = updatedFollowUp.opportunity; onModel = 'Opportunity'; }

        res.json({
            ...updatedFollowUp,
            relatedTo,
            onModel
        });
    } catch (error) {
        console.error('[updateFollowUp] Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
