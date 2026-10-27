
import prisma from '../config/prisma';
import { NotificationService } from './notificationService';
// UserRole import removed

// Helper to get start of today (UTC midnight)
const getStartOfToday = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

export const DistributionService = {
    /**
     * Assign a lead to a user based on active assignment rules (Round Robin, Top Performer, etc.)
     */
    async assignLead(lead: any, organisationId: string, ruleId?: string, fallbackUserId?: string): Promise<string | null> {
        try {
            console.log(`[DistributionService] Attempting to assign lead ${lead.id || 'new'} (Branch: ${lead.branchId || 'None'})`);

            // 1. Fetch active rules for this organisation, filtered by branch
            // If ruleId is provided, restrict to that specific rule
            const where: any = {
                organisationId: organisationId,
                isActive: true,
                isDeleted: false
            };

            if (ruleId) {
                where.id = ruleId;
            }

            const rules = await prisma.assignmentRule.findMany({
                where,
                orderBy: [
                    { priority: 'asc' }
                ]
            });

            if (!rules || rules.length === 0) {
                console.log('[DistributionService] No active assignment rules found.');
                // Fallback to provided user OR organisation creator
                let finalFallbackId = fallbackUserId;
                if (!finalFallbackId) {
                    // Find an active administrator in this specific organisation
                    const orgAdmin = await prisma.user.findFirst({
                        where: {
                            organisationId: organisationId,
                            role: 'admin',
                            isActive: true
                        },
                        select: { id: true, branchId: true }
                    });

                    if (orgAdmin) {
                        finalFallbackId = orgAdmin.id;
                    } else {
                        // Extreme fallback to organisation creator (if they belong to the org)
                        const org = await prisma.organisation.findUnique({
                            where: { id: organisationId },
                            select: { createdBy: true }
                        });
                        
                        // Verify the creator is actually part of this organisation (not a superadmin)
                        if (org?.createdBy) {
                            const creator = await prisma.user.findUnique({
                                where: { id: org.createdBy },
                                select: { organisationId: true }
                            });
                            if (creator?.organisationId === organisationId) {
                                finalFallbackId = org.createdBy;
                            }
                        }
                    }
                }

                if (finalFallbackId && lead.id) {
                    const fallbackUser = await prisma.user.findUnique({
                        where: { id: finalFallbackId },
                        select: { branchId: true }
                    });

                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: {
                            assignedToId: finalFallbackId,
                            branchId: fallbackUser?.branchId || lead.branchId
                        }
                    });

                    // Log history for fallback assignment
                    await prisma.leadHistory.create({
                        data: {
                            leadId: lead.id,
                            newOwnerId: finalFallbackId,
                            changedById: finalFallbackId,
                            reason: 'Auto-assigned to organisation creator (no active rules match)'
                        }
                    });

                    console.log(`[DistributionService] Lead ${lead.id} assigned to fallback owner ${finalFallbackId}`);
                    this.notifyUser(finalFallbackId, lead, organisationId);
                }

                return finalFallbackId || null;
            }

            // 2. Iterate through rules to find a match
            let matchedAnyRule = false;
            for (const rule of rules) {
                // Branch check removed as branchId is only used for UI filtering of users when creating rules.

                if (this.matchesRule(rule, lead)) {
                    matchedAnyRule = true;
                    console.log(`[DistributionService] Matched rule: ${rule.name} (${rule.distributionType})`);
                    let assignedUserId: string | null = null;

                    // 3. Dispatch based on Distribution Type
                    switch (rule.distributionType) {
                        case 'specific_user': {
                            // Assign directly if defined
                            const assignTo = rule.assignTo as any;
                            if (assignTo && assignTo.value) {
                                assignedUserId = assignTo.value;
                            }
                            break;
                        }

                        case 'round_robin_role':
                            assignedUserId = await this.executeRoundRobin(rule, organisationId, lead.branchId);
                            break;

                        case 'top_performer':
                            assignedUserId = await this.executeTopPerformer(rule, organisationId, lead.branchId);
                            break;

                        case 'campaign_users':
                            // Round-robin among multiple specific users defined in assignTo.users
                            assignedUserId = await this.executeCampaignUsers(rule);
                            break;

                        default:
                            console.warn(`[DistributionService] Unsupported distribution type: ${rule.distributionType}`);
                    }

                    // 4. If user found, assign and save
                    if (assignedUserId) {
                        // Get the old owner before updating
                        const oldOwnerId = lead.assignedToId;

                        // Fetch new user's branch, off-duty status, and name
                        const assignedUser = await prisma.user.findUnique({
                            where: { id: assignedUserId },
                            select: { id: true, branchId: true, isOffDuty: true, firstName: true, lastName: true }
                        });

                        if (assignedUser?.isOffDuty) {
                            console.log(`[DistributionService] User ${assignedUserId} (${assignedUser.firstName || ''} ${assignedUser.lastName || ''}) is off-duty. Routing lead to organisation admin...`);
                            
                            // Find an active administrator in this specific organisation
                            const orgAdmin = await prisma.user.findFirst({
                                where: {
                                    organisationId: organisationId,
                                    role: 'admin',
                                    isActive: true,
                                    isOffDuty: false
                                },
                                select: { id: true, branchId: true }
                            }) || await prisma.user.findFirst({
                                where: {
                                    organisationId: organisationId,
                                    role: 'admin',
                                    isActive: true
                                },
                                select: { id: true, branchId: true }
                            });

                            let finalFallbackId = orgAdmin?.id;
                            if (!finalFallbackId) {
                                // Extreme fallback to organisation creator
                                const org = await prisma.organisation.findUnique({
                                    where: { id: organisationId },
                                    select: { createdBy: true }
                                });
                                if (org?.createdBy) {
                                    const creator = await prisma.user.findUnique({
                                        where: { id: org.createdBy },
                                        select: { organisationId: true }
                                    });
                                    if (creator?.organisationId === organisationId) {
                                        finalFallbackId = org.createdBy;
                                    }
                                }
                            }

                            if (finalFallbackId) {
                                const fallbackUser = await prisma.user.findUnique({
                                    where: { id: finalFallbackId },
                                    select: { branchId: true }
                                });

                                await prisma.lead.update({
                                    where: { id: lead.id },
                                    data: {
                                        assignedToId: finalFallbackId,
                                        branchId: fallbackUser?.branchId || lead.branchId
                                    }
                                });

                                await prisma.leadHistory.create({
                                    data: {
                                        leadId: lead.id,
                                        oldOwnerId: oldOwnerId,
                                        newOwnerId: finalFallbackId,
                                        changedById: finalFallbackId,
                                        reason: `Re-routed to admin because assigned user ${assignedUser.firstName || ''} ${assignedUser.lastName || ''} is off-duty`
                                    }
                                });

                                this.notifyUser(finalFallbackId, lead, organisationId);
                                console.log(`[DistributionService] Assigned lead to fallback admin/owner ${finalFallbackId} because primary assignee was off-duty`);
                                return finalFallbackId;
                            }
                        }

                        await prisma.lead.update({
                            where: { id: lead.id },
                            data: { 
                                assignedToId: assignedUserId,
                                branchId: assignedUser?.branchId || lead.branchId
                            }
                        });

                        // Create history record
                        await prisma.leadHistory.create({
                            data: {
                                leadId: lead.id,
                                oldOwnerId: oldOwnerId,
                                newOwnerId: assignedUserId,
                                changedById: assignedUserId, // System assignment
                                reason: `Auto-assigned via rule: ${rule.name}`
                            }
                        });

                        // Increment quota tracker
                        await this.incrementUserLeadCount(assignedUserId);

                        // Notify User
                        this.notifyUser(assignedUserId, lead, organisationId);

                        console.log(`[DistributionService] Assigned lead to user ${assignedUserId}`);
                        return assignedUserId;
                    }

                    // 5. FALLBACK: If no eligible user found (all at quota), escalate to manager
                    console.log('[DistributionService] No eligible users found (all at quota). Escalating to manager...');
                    const managerId = await this.findManagerForRule(rule);
                    if (managerId) {
                        // Get the old owner before updating
                        const oldOwnerId = lead.assignedToId;

                        // Fetch manager's branch
                        const manager = await prisma.user.findUnique({
                            where: { id: managerId },
                            select: { branchId: true }
                        });

                        await prisma.lead.update({
                            where: { id: lead.id },
                            data: { 
                                assignedToId: managerId,
                                branchId: manager?.branchId || lead.branchId
                            }
                        });

                        // Create history record
                        await prisma.leadHistory.create({
                            data: {
                                leadId: lead.id,
                                oldOwnerId: oldOwnerId,
                                newOwnerId: managerId,
                                changedById: managerId, // System assignment
                                reason: `Escalated to manager - all users at quota (Rule: ${rule.name})`
                            }
                        });

                        // Don't increment quota for manager - they'll manually reassign
                        this.notifyUser(managerId, lead, organisationId);
                        console.log(`[DistributionService] Escalated to manager ${managerId} for manual assignment`);
                        return managerId;
                    }
                }
            }

            // [STRICT RULE] If no rule matched for a Meta Lead, assign to Admin
            if (!matchedAnyRule && lead.source === 'meta_leadgen') {
                console.log(`[DistributionService] No campaign rules matched for Meta Lead ${lead.id}. Falling back to Admin.`);
                
                const orgAdmin = await prisma.user.findFirst({
                    where: {
                        organisationId: organisationId,
                        role: 'admin',
                        isActive: true
                    },
                    select: { id: true, branchId: true }
                });

                if (orgAdmin) {
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: {
                            assignedToId: orgAdmin.id,
                            branchId: orgAdmin.branchId || lead.branchId
                        }
                    });

                    await prisma.leadHistory.create({
                        data: {
                            leadId: lead.id,
                            newOwnerId: orgAdmin.id,
                            changedById: orgAdmin.id,
                            reason: 'Auto-assigned to admin (no matching campaign rules found)'
                        }
                    });

                    this.notifyUser(orgAdmin.id, lead, organisationId);
                    return orgAdmin.id;
                }
            }

            return null; // No rule matched or no user available

        } catch (error) {
            console.error('[DistributionService] Error assigning lead:', error);
            return null;
        }
    },

    /**
     * Check if lead matches the rule criteria
     * Supports nested field access like "sourceDetails.campaignName"
     */
    matchesRule(rule: any, lead: any): boolean {
        const criteria = rule.criteria as any[];
        if (!criteria || criteria.length === 0) return true;

        // Multiple criteria on the SAME field (e.g. three
        // "sourceDetails.campaignName equals X/Y/Z" rows meant as "any of
        // these campaigns") must be OR'd together within that field, not
        // ANDed - a lead has exactly one campaignName, so ANDing them made
        // the rule unmatchable by any lead and silently fell through to the
        // next rule / generic fallback assignment instead of the intended
        // round-robin pool. Different fields still AND together as before.
        const byField = new Map<string, any[]>();
        for (const criterion of criteria) {
            const key = criterion.field;
            if (!byField.has(key)) byField.set(key, []);
            byField.get(key)!.push(criterion);
        }

        for (const [, fieldCriteria] of byField) {
            const anyMatches = fieldCriteria.some((criterion) => this.matchesCriterion(criterion, lead));
            if (!anyMatches) return false;
        }
        return true;
    },

    /** Evaluates a single criterion against a lead. */
    matchesCriterion(criterion: any, lead: any): boolean {
        const leadValue = this.getNestedValue(lead, criterion.field);
        const ruleValue = criterion.value;

        switch (criterion.operator) {
            case 'equals':
                if (typeof leadValue === 'string' && typeof ruleValue === 'string') {
                    return leadValue.trim().toLowerCase() === ruleValue.trim().toLowerCase();
                }
                return leadValue == ruleValue;
            case 'not_equals':
                if (typeof leadValue === 'string' && typeof ruleValue === 'string') {
                    return leadValue.trim().toLowerCase() !== ruleValue.trim().toLowerCase();
                }
                return leadValue != ruleValue;
            case 'contains':
                return typeof leadValue === 'string' && leadValue.toLowerCase().includes(String(ruleValue).toLowerCase());
            case 'greater_than':
            case 'gt':
                return leadValue > ruleValue;
            case 'less_than':
            case 'lt':
                return leadValue < ruleValue;
            case 'in':
                return Array.isArray(ruleValue) ? ruleValue.includes(leadValue) : true;
            default:
                return true;
        }
    },

    /**
     * Get nested value from object using dot notation
     * e.g., getNestedValue(lead, "sourceDetails.campaignName")
     */
    getNestedValue(obj: any, path: string): any {
        if (!obj || !path) return undefined;

        const parts = path.split('.');
        let current = obj;

        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            current = current[part];
        }

        return current;
    },

    /**
     * Helper: Get eligible users for a rule (handling scope + quota)
     */
    async getEligibleUsers(rule: any, organisationId: string, branchId?: string | null): Promise<any[]> {
        const where: any = {
            organisationId: organisationId,
            isActive: true
        };

        const targetBranchId = rule.branchId || branchId;
        console.log(`[DistributionService] Finding users for rule: ${rule.name}. Target Branch: ${targetBranchId || 'Global'}`);
        
        if (targetBranchId) {
            where.branchId = targetBranchId;
        } else {
            // If explicitly global rule and no lead branch, pick from anyone
            // but we might want to prioritize organization-level users here.
        }

        if (rule.targetRole) {
            where.role = rule.targetRole;
        }

        // Handle Scope
        if (rule.distributionScope === 'direct_subordinates') {
            if (rule.createdById) {
                where.reportsToId = rule.createdById;
            } else {
                console.warn('[DistributionService] Rule has direct_subordinates scope but no createdBy user.');
                return [];
            }
        }

        const users = await prisma.user.findMany({
            where,
            include: {
                leadQuotaTracking: {
                    where: {
                        date: getStartOfToday()
                    }
                }
            },
            orderBy: { id: 'asc' }
        });

        // Filter out users who have reached their daily quota or are outside working hours
        return users.filter((user: any) => {
            // 1. Quota Check
            if (user.dailyLeadQuota) {
                const todayCount = user.leadQuotaTracking?.[0]?.leadCount || 0;
                if (todayCount >= user.dailyLeadQuota) {
                    console.log(`[DistributionService] User ${user.id} skipped - quota reached (${todayCount}/${user.dailyLeadQuota})`);
                    return false;
                }
            }

            // 2. Working Hours & Availability Check
            if (!this.isUserAvailable(user)) {
                console.log(`[DistributionService] User ${user.id} skipped - outside working hours or unavailable`);
                return false;
            }

            return true;
        });
    },

    /**
     * Increment user's daily lead count
     */
    async incrementUserLeadCount(userId: string): Promise<void> {
        const today = getStartOfToday();

        await prisma.userLeadQuotaTracker.upsert({
            where: {
                userId_date: {
                    userId,
                    date: today
                }
            },
            update: {
                leadCount: { increment: 1 }
            },
            create: {
                userId,
                date: today,
                leadCount: 1
            }
        });
    },

    /**
     * Find a manager to escalate leads to when all users are at quota.
     * First tries the rule creator's manager, then falls back to any admin.
     */
    async findManagerForRule(rule: any): Promise<string | null> {
        try {
            // 1. Try to find the rule creator's manager
            if (rule.createdById) {
                const creator = await prisma.user.findUnique({
                    where: { id: rule.createdById },
                    select: { reportsToId: true }
                });

                if (creator?.reportsToId) {
                    console.log(`[DistributionService] Found manager ${creator.reportsToId} for escalation`);
                    return creator.reportsToId;
                }
            }

            // 2. Fallback to target manager if defined on rule
            if (rule.targetManagerId) {
                console.log(`[DistributionService] Using rule target manager ${rule.targetManagerId}`);
                return rule.targetManagerId;
            }

            // 3. Fallback to any admin in the organisation
            const admin = await prisma.user.findFirst({
                where: {
                    organisationId: rule.organisationId,
                    role: 'admin',
                    isActive: true
                },
                select: { id: true }
            });

            if (admin) {
                console.log(`[DistributionService] Fallback to admin ${admin.id}`);
                return admin.id;
            }

            console.warn('[DistributionService] No manager or admin found for escalation');
            return null;
        } catch (error) {
            console.error('[DistributionService] Error finding manager:', error);
            return null;
        }
    },

    /**
     * Round Robin Logic: Find next user in the role
     */
    async executeRoundRobin(rule: any, organisationId: string, branchId?: string | null): Promise<string | null> {
        try {
            if (!rule.targetRole) return null;

            // Fetch eligible users using helper
            const users = await this.getEligibleUsers(rule, organisationId, branchId);

            if (users.length === 0) return null;

            // Find index of last assigned user using ALL valid users to prevent skipping
            const where: any = { organisationId, isActive: true };
            if (rule.branchId || branchId) where.branchId = rule.branchId || branchId;
            if (rule.targetRole) where.role = rule.targetRole;
            const allUsers = await prisma.user.findMany({ where, orderBy: { id: 'asc' } });

            let startIndex = 0;
            if (rule.lastAssignedUserId) {
                const lastIndex = allUsers.findIndex((u: any) => u.id === rule.lastAssignedUserId);
                if (lastIndex !== -1) {
                    startIndex = (lastIndex + 1) % allUsers.length;
                }
            }

            let nextUser = null;
            for (let i = 0; i < allUsers.length; i++) {
                const checkIndex = (startIndex + i) % allUsers.length;
                const candidate = allUsers[checkIndex];
                // Check if candidate is in the eligible users list
                if (users.some(u => u.id === candidate.id)) {
                    nextUser = candidate;
                    break;
                }
            }

            if (!nextUser) return null;

            // Update rule state
            await prisma.assignmentRule.update({
                where: { id: rule.id },
                data: { lastAssignedUserId: nextUser.id }
            });

            return nextUser.id;

        } catch (e) {
            console.error('[DistributionService] RR Error:', e);
            return null;
        }
    },

    /**
     * Top Performer Logic: Find user with most Sales (Closed Won Opportunities)
     */
    async executeTopPerformer(rule: any, organisationId: string, branchId?: string | null): Promise<string | null> {
        try {
            if (!rule.targetRole) return null;

            // Fetch eligible users
            const users = await this.getEligibleUsers(rule, organisationId, branchId);

            if (users.length === 0) return null;

            // 30 Days lookback window
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 30);

            // Group By Owner and Sum Amount
            const topPerformer = await prisma.opportunity.groupBy({
                by: ['ownerId'],
                where: {
                    organisationId: organisationId,
                    ownerId: { in: users.map(u => u.id) },
                    stage: 'closed_won',
                    createdAt: { gte: startDate }
                },
                _sum: {
                    amount: true
                },
                orderBy: {
                    _sum: {
                        amount: 'desc'
                    }
                },
                take: 1
            });

            if (topPerformer.length > 0 && topPerformer[0].ownerId) {
                return topPerformer[0].ownerId; // ownerId can be null if not filtered properly, but query has ownerId in list
            }

            // Fallback: If no sales data, pick random or first user
            return users[0].id;

        } catch (e) {
            console.error('[DistributionService] Top Performer Error:', e);
            return null;
        }
    },

    /**
     * Campaign Users: Round-robin among multiple specific users defined for a campaign
     * The assignTo field should be: { users: ["userId1", "userId2", "userId3"] }
     */
    async executeCampaignUsers(rule: any): Promise<string | null> {
        try {
            const assignTo = rule.assignTo as any;
            if (!assignTo || !assignTo.users || !Array.isArray(assignTo.users) || assignTo.users.length === 0) {
                console.warn('[DistributionService] Campaign rule has no users defined');
                return null;
            }

            const userIds: string[] = assignTo.users;
            const today = getStartOfToday();

            // Fetch users with their quota info for today
            const users = await prisma.user.findMany({
                where: {
                    id: { in: userIds },
                    isActive: true
                },
                include: {
                    leadQuotaTracking: {
                        where: { date: today }
                    }
                }
            });

            // Preserve the original order defined in the rule, but only keep users who
            // actually belong to the rule's branch. assignTo.users is a manually curated
            // list and can drift out of sync with the branch the rule was scoped to (e.g.
            // a user added before a branch reassignment, or before the rule's branch was
            // changed) - without this check a stale entry silently receives leads outside
            // its intended branch.
            const orderedUsers = userIds
                .map(id => users.find(u => u.id === id))
                .filter(Boolean)
                .filter((u: any) => !rule.branchId || u.branchId === rule.branchId);

            if (orderedUsers.length === 0) {
                console.warn(`[DistributionService] Campaign rule ${rule.name} has no eligible users in branch ${rule.branchId}`);
                return null;
            }

            let startIndex = 0;
            if (rule.lastAssignedUserId) {
                const lastIndex = orderedUsers.findIndex((u: any) => u.id === rule.lastAssignedUserId);
                if (lastIndex !== -1) {
                    startIndex = (lastIndex + 1) % orderedUsers.length;
                }
            }

            let nextUser = null;
            for (let i = 0; i < orderedUsers.length; i++) {
                const checkIndex = (startIndex + i) % orderedUsers.length;
                const user: any = orderedUsers[checkIndex];
                
                // Check eligibility
                if (user.dailyLeadQuota) {
                    const todayCount = user.leadQuotaTracking?.[0]?.leadCount || 0;
                    if (todayCount >= user.dailyLeadQuota) continue;
                }
                if (!this.isUserAvailable(user)) continue;

                nextUser = user;
                break;
            }

            if (!nextUser) {
                console.log('[DistributionService] All campaign users at quota or unavailable');
                return null;
            }

            // Update rule state
            await prisma.assignmentRule.update({
                where: { id: rule.id },
                data: { lastAssignedUserId: nextUser.id }
            });

            return nextUser.id;

        } catch (e) {
            console.error('[DistributionService] Campaign Users Error:', e);
            return null;
        }
    },

    /**
     * Check if user is currently within their working hours
     */
    isUserAvailable(user: any): boolean {
        // If user is off duty, they are not available
        if (user.isOffDuty) return false;

        // If no working hours defined, assume available 24/7
        if (!user.workingHours) return true;

        try {
            const tz = user.timezone || 'UTC';
            // Get current time in User's timezone
            const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
            const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
            const day = dayNames[nowInTz.getDay()];

            const hours = (user.workingHours as any)[day];
            if (!hours || !hours.start || !hours.end) return false; // Not working this day

            const currentTime = nowInTz.getHours() * 60 + nowInTz.getMinutes();

            const [startH, startM] = hours.start.split(':').map(Number);
            const [endH, endM] = hours.end.split(':').map(Number);

            const startTime = startH * 60 + startM;
            const endTime = endH * 60 + endM;

            return currentTime >= startTime && currentTime <= endTime;
        } catch (err) {
            console.error('[DistributionService] Error checking user availability:', err);
            return true; // Fallback to available if error
        }
    },

    /**
     * Resolve which branch a Meta Page belongs to
     */
    async resolveBranchForMetaPage(organisationId: string, pageId: string): Promise<string | null> {
        try {
            const org = await prisma.organisation.findUnique({
                where: { id: organisationId },
                select: { integrations: true }
            });

            if (!org || !org.integrations) return null;

            const integrations = org.integrations as any;
            const accounts = integrations.metaAccounts || [];
            
            // 1. Try to find branchId in metaAccounts array
            const matchedAccount = accounts.find((acc: any) => acc.pageId === pageId);
            if (matchedAccount?.branchId) return matchedAccount.branchId;

            // 2. Try legacy meta object
            if (integrations.meta?.pageId === pageId && integrations.meta?.branchId) {
                return integrations.meta.branchId;
            }

            return null;
        } catch (error) {
            console.error('[DistributionService] Error resolving branch for Meta page:', error);
            return null;
        }
    },

    /**
     * Resolve owner for a Meta lead (Round Robin or fallback)
     */
    async resolveOwnerForMetaLead(organisationId: string, branchId?: string | null): Promise<string | null> {
        try {
            // Find a rule specifically for Meta leads or use general assignLead
            // For now, we use a simple round-robin among active users in that branch
            const users = await prisma.user.findMany({
                where: {
                    organisationId,
                    branchId: branchId || undefined,
                    isActive: true,
                    role: { in: ['sales_rep', 'manager', 'admin'] }
                },
                orderBy: { id: 'asc' }
            });

            if (users.length === 0) return null;

            // Simple round-robin (fallback if no complex rules match)
            const randomIndex = Math.floor(Math.random() * users.length);
            return users[randomIndex].id;
        } catch (error) {
            console.error('[DistributionService] Error resolving owner for Meta lead:', error);
            return null;
        }
    },

    /**
     * Notify user of new lead assignment — CRM/native (push + in-app) is
     * always attempted first, independent of the WhatsApp text below (which
     * only fires if this user has a phone on file AND the org has WhatsApp
     * connected). Previously the CRM notification was placed AFTER those
     * two WhatsApp preconditions and returned early before ever reaching
     * it, so any rep with no phone number, or any org without WhatsApp
     * configured, silently got no notification at all for auto-assigned
     * leads.
     */
    async notifyUser(userId: string, lead: any, organisationId: string) {
        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { phone: true, firstName: true }
            });

            await NotificationService.send(
                userId,
                'New Lead Assigned (Auto)',
                `You have been auto-assigned a new lead: ${lead.firstName} ${lead.lastName}`,
                'info'
            );

            if (!user?.phone) return;

            // Lazy load WhatsAppService
            const { WhatsAppService } = await import('./whatsAppService');
            const waClient = await WhatsAppService.getClientForOrg(organisationId);

            if (!waClient) return;

            const message = `Hi ${user.firstName}, New Lead Assigned!\n\nName: ${lead.firstName} ${lead.lastName}\nCompany: ${lead.company || 'N/A'}\n\nPlease check the CRM for details.`;

            await waClient.sendTextMessage(user.phone, message);
            console.log(`[DistributionService] WhatsApp notification sent to ${user.phone}`);

        } catch (error) {
            console.error('[DistributionService] Failed to notify user:', error);
        }
    }
};
