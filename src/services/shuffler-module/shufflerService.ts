import prisma from '../../config/prisma';
// Trigger restart

export const runShuffler = async () => {
    try {

        const now = new Date();
        const currentHour = now.getHours().toString().padStart(2, '0');
        const currentMinute = now.getMinutes().toString().padStart(2, '0');
        const currentTimeString = `${currentHour}:${currentMinute}`;
        
        // Get all organisations that might have a shuffler config
        const orgs = await prisma.organisation.findMany({
            where: {
                isDeleted: false,
                status: 'active'
            }
        });

        for (const org of orgs) {
            if (!org.shufflerConfig) continue;

            const config = org.shufflerConfig as any;
            if (!config.isAutoShufflingOn) continue;
            if (!config.statuses || config.statuses.length === 0) continue;

            // Check if it's the right time to shuffle for this org
            if (config.shuffleTime !== currentTimeString) continue;

            console.log(`[ShufflerCron] Scheduled shuffle starting for Org: ${org.name} at ${currentTimeString}`);

            const timeFrameType = config.timeFrameType || 'days_before';
            
            // Interval calculation for Auto Schedule
            if (timeFrameType === 'days_before') {
                const intervalDays = parseInt(config.shuffleBeforeDays) || 0;
                if (config.lastShuffledAt && intervalDays > 0) {
                    const lastRun = new Date(config.lastShuffledAt);
                    const nextRun = new Date(lastRun);
                    nextRun.setDate(nextRun.getDate() + intervalDays);
                    nextRun.setHours(0,0,0,0);
                    
                    const today = new Date();
                    today.setHours(0,0,0,0);
                    
                    if (today < nextRun) {
                        continue; // Skip this org today
                    }
                }
            }

            let dateCondition: any = {};

            if (timeFrameType === 'date_range' && config.fromDate && config.toDate) {
                dateCondition = { gte: new Date(config.fromDate), lte: new Date(config.toDate) };
            } else if (timeFrameType === 'backwards_from_date' && config.backwardsDate) {
                dateCondition = { lt: new Date(config.backwardsDate) };
            }
            // For 'days_before', we no longer filter by age, it's just a schedule interval, so dateCondition remains empty.

            // Only apply minimum lead age filter in Auto Shuffler (as requested)
            if (config.minLeadAgeDays && config.minLeadAgeDays > 0) {
                const cutoffDate = new Date();
                cutoffDate.setDate(cutoffDate.getDate() - config.minLeadAgeDays);
                dateCondition.lt = cutoffDate;
            }

            let activeUsersWhere: any = {
                organisationId: org.id,
                isActive: true,
                isOffDuty: false,
                role: { notIn: ['super_admin', 'admin'] }
            };

            if (config.selectAllUsers) {
                if (!config.selectAllBranches && config.branches && config.branches.length > 0) {
                    activeUsersWhere.branchId = { in: config.branches };
                }
            } else {
                if (!config.users || config.users.length === 0) {
                    console.log(`[ShufflerService] No users selected for shuffling in Org: ${org.name}`);
                    continue;
                }
                activeUsersWhere.id = { in: config.users };
            }

            const activeUsers = await prisma.user.findMany({
                where: activeUsersWhere,
                select: { id: true, teamId: true, branchId: true },
                orderBy: { id: 'asc' }
            });

            if (activeUsers.length === 0) {
                console.log(`[ShufflerService] No active users available to receive leads in Org: ${org.name}`);
                continue;
            }

            const activeUserIds = activeUsers.map(u => u.id);

            const excludedStatuses = ['closed_won', 'closed_lost', 'Closed Won', 'Closed Lost', 'closed won', 'closed lost'];
            const validStatuses = config.statuses.filter((s: string) => !excludedStatuses.includes(s) && !excludedStatuses.includes(s.toLowerCase()));

            // Find eligible leads
            // Only shuffle leads that are currently owned by the selected users
            const eligibleLeads = await prisma.lead.findMany({
                where: {
                    organisationId: org.id,
                    isDeleted: false,
                    status: { in: validStatuses },
                    createdAt: Object.keys(dateCondition).length > 0 ? dateCondition : undefined,
                    assignedToId: { in: activeUserIds }
                },
                select: { id: true, assignedToId: true },
                orderBy: { id: 'asc' }
            });

            if (eligibleLeads.length === 0) {
                console.log(`[ShufflerService] No eligible leads found for Org: ${org.name}`);
                continue;
            }

            // Fetch past owners for eligible leads to ensure a strict cycle per lead
            let lastAssignedIndex = activeUsers.findIndex((u: any) => u.id === config.lastAssignedUserId);
            if (lastAssignedIndex === -1) lastAssignedIndex = -1; // Will start at 0

            let reassignedCount = 0;

            let slots: any[] = [];
            let nextIndex = lastAssignedIndex;
            for (let i = 0; i < eligibleLeads.length; i++) {
                nextIndex = (nextIndex + 1) % activeUsers.length;
                slots.push(activeUsers[nextIndex]);
            }

            // Resolve collisions where a slot matches the lead's current owner
            if (activeUsers.length > 1) {
                for (let i = 0; i < eligibleLeads.length; i++) {
                    if (eligibleLeads[i].assignedToId === slots[i].id) {
                        for (let j = 0; j < eligibleLeads.length; j++) {
                            if (i !== j && eligibleLeads[i].assignedToId !== slots[j].id && eligibleLeads[j].assignedToId !== slots[i].id) {
                                let temp = slots[i];
                                slots[i] = slots[j];
                                slots[j] = temp;
                                break;
                            }
                        }
                    }
                }
            }



            for (let i = 0; i < eligibleLeads.length; i++) {
                const lead = eligibleLeads[i];
                const targetUser = slots[i];

                if (targetUser.id !== lead.assignedToId) {
                    await prisma.lead.update({
                        where: { id: lead.id },
                        data: { 
                            assignedToId: targetUser.id, 
                            status: 'shuffled_lead',
                            teamId: targetUser.teamId || null,
                            branchId: targetUser.branchId || null,
                            previousOwnerId: lead.assignedToId
                        }
                    });

                    // Reassign active follow-ups and tasks to the new user
                    await prisma.followUp.updateMany({
                        where: { leadId: lead.id, isDeleted: false, status: { notIn: ['completed'] } },
                        data: { assignedToId: targetUser.id, createdById: targetUser.id }
                    });

                    await prisma.task.updateMany({
                        where: { leadId: lead.id, isDeleted: false, status: { notIn: ['completed'] } },
                        data: { assignedToId: targetUser.id, createdById: targetUser.id }
                    });

                    // No-op for the usual case (a shuffled lead hasn't converted yet), but
                    // guards against a stray already-converted lead silently leaving its
                    // Opportunity/Account/Contact attributed to the pre-shuffle owner.
                    await prisma.opportunity.updateMany({
                        where: { leadId: lead.id, isDeleted: false },
                        data: { ownerId: targetUser.id, previousOwnerId: lead.assignedToId }
                    });
                    await prisma.account.updateMany({
                        where: { leadId: lead.id, isDeleted: false },
                        data: { ownerId: targetUser.id, previousOwnerId: lead.assignedToId }
                    });
                    await prisma.contact.updateMany({
                        where: { leadId: lead.id, isDeleted: false },
                        data: { ownerId: targetUser.id, previousOwnerId: lead.assignedToId }
                    });

                    // Log history. Was using fieldName/oldValue/newValue
                    // (plain strings, no FK) instead of oldOwnerId/newOwnerId
                    // like every other writer - harmless for storage, but it
                    // meant the per-lead Ownership History tab and the
                    // org-wide Lead Transfer Log couldn't resolve owner
                    // names for shuffler-caused transfers (their `oldOwner`/
                    // `newOwner` include relies on those FK columns).
                    await prisma.leadHistory.create({
                        data: {
                            leadId: lead.id,
                            oldOwnerId: lead.assignedToId,
                            newOwnerId: targetUser.id,
                            changedById: null, // System action - scheduled auto-shuffle
                            reason: `Auto-shuffled by system (scheduled shuffler for "${org.name}")`
                        }
                    });

                    // Send Notification to new owner
                    await prisma.notification.create({
                        data: {
                            title: 'New Lead Assigned',
                            message: `A lead has been automatically reassigned to you by the Shuffler.`,
                            type: 'info',
                            relatedResource: 'lead',
                            relatedId: lead.id,
                            recipientId: targetUser.id,
                            organisationId: org.id
                        }
                    });

                    reassignedCount++;
                }
            }

            // After all assignments, update the lastAssignedIndex for the next run
            lastAssignedIndex = nextIndex;

            // Save the persistent round-robin pointer and the last run time
            const updatedConfig: any = { 
                ...(org.shufflerConfig as Record<string, any>), 
                lastShuffledAt: new Date().toISOString() 
            };
            
            if (lastAssignedIndex !== -1 && activeUsers[lastAssignedIndex]) {
                updatedConfig.lastAssignedUserId = activeUsers[lastAssignedIndex].id;
            }
            
            await prisma.organisation.update({
                where: { id: org.id },
                data: { shufflerConfig: updatedConfig }
            });

            console.log(`[ShufflerService] Successfully reassigned ${reassignedCount} leads in Org: ${org.name}`);
        }
    } catch (error) {
        console.error('[ShufflerService] Error during shuffle execution:', error);
    }
};

export const forceShuffleOrg = async (organisationId: string, triggeredById?: string) => {
    try {
        console.log(`[ShufflerService] Force starting shuffle check for Org: ${organisationId}`);

        const org = await prisma.organisation.findUnique({
            where: { id: organisationId, isDeleted: false }
        });

        if (!org) {
            return { success: false, message: 'Organization not found or inactive.' };
        }

        if (!org.shufflerConfig) {
            return { success: false, message: 'No shuffler config found for this organization.' };
        }

        // Resolved once up front so the LeadHistory reason below is
        // self-contained (names the triggering admin inline).
        const triggeringAdmin = triggeredById
            ? await prisma.user.findUnique({ where: { id: triggeredById }, select: { firstName: true, lastName: true } })
            : null;
        const forceShuffleReason = triggeringAdmin
            ? `Manual shuffle triggered by ${triggeringAdmin.firstName || ''} ${triggeringAdmin.lastName || ''}`.trim()
            : `Manual shuffle triggered for "${org.name}"`;

        const config = org.shufflerConfig as any;
        
        if (!config.statuses || config.statuses.length === 0) {
            return { success: false, message: 'No lead statuses configured for shuffling.' };
        }

        if (!config.selectAllUsers && (!config.users || config.users.length === 0)) {
            return { success: false, message: 'No users selected for shuffling. Please select users first.' };
        }

        const timeFrameType = config.timeFrameType || 'days_before';
        let dateCondition: any = undefined; // Undefined means it will be ignored in where clause if not set

        if (timeFrameType === 'date_range' && config.fromDate && config.toDate) {
            dateCondition = { gte: new Date(config.fromDate), lte: new Date(config.toDate) };
        } else if (timeFrameType === 'backwards_from_date' && config.backwardsDate) {
            dateCondition = { lt: new Date(config.backwardsDate) };
        }
        // For 'days_before' (Auto Schedule Interval), we no longer filter leads by age.

        // Find eligible active users in the org
        let activeUsersWhere: any = {
            organisationId: org.id,
            isActive: true,
            isOffDuty: false,
            role: { notIn: ['super_admin', 'admin'] }
        };

        if (config.selectAllUsers) {
            if (!config.selectAllBranches && config.branches && config.branches.length > 0) {
                activeUsersWhere.branchId = { in: config.branches };
            }
        } else {
            activeUsersWhere.id = { in: config.users };
        }

        const activeUsers = await prisma.user.findMany({
            where: activeUsersWhere,
            select: { id: true, teamId: true, branchId: true },
            orderBy: { id: 'asc' }
        });

        if (activeUsers.length === 0) {
            return { success: false, message: 'No active non-admin users available to receive leads.' };
        }

        const activeUserIds = activeUsers.map(u => u.id);

        const excludedStatuses = ['closed_won', 'closed_lost', 'Closed Won', 'Closed Lost', 'closed won', 'closed lost'];
        const validStatuses = config.statuses.filter((s: string) => !excludedStatuses.includes(s) && !excludedStatuses.includes(s.toLowerCase()));

        let leadWhereCondition: any = {
            organisationId: org.id,
            isDeleted: false,
            status: { in: validStatuses },
            assignedToId: { in: activeUserIds }
        };

        if (dateCondition) {
            leadWhereCondition.createdAt = dateCondition;
        }

        // Find eligible leads
        const eligibleLeads = await prisma.lead.findMany({
            where: leadWhereCondition,
            select: { id: true, assignedToId: true },
            orderBy: { id: 'asc' }
        });

        if (eligibleLeads.length === 0) {
            return { success: true, message: 'No eligible leads found for selected statuses and time frame.' };
        }

        // Initialize activeJob in shufflerConfig
        const initialConfig: any = { 
            ...config,
            activeJob: {
                status: "IN_PROGRESS",
                totalLeads: eligibleLeads.length,
                processedLeads: 0,
                startTime: new Date().toISOString()
            }
        };
        await prisma.organisation.update({
            where: { id: org.id },
            data: { shufflerConfig: initialConfig }
        });

        let lastAssignedIndex = activeUsers.findIndex((u: any) => u.id === config.lastAssignedUserId);
        if (lastAssignedIndex === -1) lastAssignedIndex = -1;

        let reassignedCount = 0;

        let slots: any[] = [];
        let nextIndex = lastAssignedIndex;
        for (let i = 0; i < eligibleLeads.length; i++) {
            nextIndex = (nextIndex + 1) % activeUsers.length;
            slots.push(activeUsers[nextIndex]);
        }

        // Resolve collisions where a slot matches the lead's current owner
        if (activeUsers.length > 1) {
            for (let i = 0; i < eligibleLeads.length; i++) {
                if (eligibleLeads[i].assignedToId === slots[i].id) {
                    for (let j = 0; j < eligibleLeads.length; j++) {
                        if (i !== j && eligibleLeads[i].assignedToId !== slots[j].id && eligibleLeads[j].assignedToId !== slots[i].id) {
                            let temp = slots[i];
                            slots[i] = slots[j];
                            slots[j] = temp;
                            break;
                        }
                    }
                }
            }
        }

        for (let i = 0; i < eligibleLeads.length; i++) {
            const lead = eligibleLeads[i];
            const targetUser = slots[i];

            if (targetUser.id !== lead.assignedToId) {
                await prisma.lead.update({
                    where: { id: lead.id },
                    data: { 
                        assignedToId: targetUser.id, 
                        status: 'shuffled_lead',
                        teamId: targetUser.teamId || null,
                        branchId: targetUser.branchId || null,
                        previousOwnerId: lead.assignedToId
                    }
                });

                // Reassign active follow-ups and tasks to the new user
                await prisma.followUp.updateMany({
                    where: { leadId: lead.id, isDeleted: false, status: { notIn: ['completed'] } },
                    data: { assignedToId: targetUser.id, createdById: targetUser.id }
                });
                
                await prisma.task.updateMany({
                    where: { leadId: lead.id, isDeleted: false, status: { notIn: ['completed'] } },
                    data: { assignedToId: targetUser.id, createdById: targetUser.id }
                });

                // Log history. Same oldOwnerId/newOwnerId fix as the
                // scheduled path above, plus this now actually records who
                // triggered it (changedById was always null before, even
                // though a real admin clicked "Shuffle Now").
                await prisma.leadHistory.create({
                    data: {
                        leadId: lead.id,
                        oldOwnerId: lead.assignedToId,
                        newOwnerId: targetUser.id,
                        changedById: triggeredById || null,
                        reason: forceShuffleReason
                    }
                });

                // Send Notification to new owner
                await prisma.notification.create({
                    data: {
                        title: 'New Lead Assigned',
                        message: `A lead has been reassigned to you by the manual Shuffler.`,
                        type: 'info',
                        relatedResource: 'lead',
                        relatedId: lead.id,
                        recipientId: targetUser.id,
                        organisationId: org.id
                    }
                });

                reassignedCount++;

                // Update progress every 50 leads
                if (reassignedCount % 50 === 0) {
                    const currentOrg = await prisma.organisation.findUnique({
                        where: { id: org.id },
                        select: { shufflerConfig: true }
                    });
                    if (currentOrg && currentOrg.shufflerConfig) {
                        const curConfig = currentOrg.shufflerConfig as any;
                        if (curConfig.activeJob) {
                            curConfig.activeJob.processedLeads = reassignedCount;
                            await prisma.organisation.update({
                                where: { id: org.id },
                                data: { shufflerConfig: curConfig }
                            });
                        }
                    }
                }
            }
        }

        // Save the persistent round-robin pointer
        lastAssignedIndex = nextIndex;

        console.log(`[ShufflerService] Force successfully reassigned ${reassignedCount} leads in Org: ${org.name}`);
        // Save the persistent round-robin pointer and manual run time
        const updatedConfig: any = { 
            ...(org.shufflerConfig as Record<string, any>), 
            lastShuffledAt: new Date().toISOString(),
            activeJob: {
                status: "COMPLETED",
                totalLeads: eligibleLeads.length,
                processedLeads: reassignedCount,
                endTime: new Date().toISOString()
            }
        };
        
        if (lastAssignedIndex !== -1 && activeUsers[lastAssignedIndex]) {
            updatedConfig.lastAssignedUserId = activeUsers[lastAssignedIndex].id;
        }
        
        await prisma.organisation.update({
            where: { id: org.id },
            data: { shufflerConfig: updatedConfig }
        });

        return { success: true, message: `Shuffled ${reassignedCount} leads successfully.` };
    } catch (error) {
        console.error('[ShufflerService] Error during force shuffle execution:', error);
        
        // Try to mark job as FAILED
        try {
            const org = await prisma.organisation.findUnique({ where: { id: organisationId } });
            if (org && org.shufflerConfig) {
                const config = org.shufflerConfig as any;
                if (config.activeJob) {
                    config.activeJob.status = "FAILED";
                    await prisma.organisation.update({
                        where: { id: organisationId },
                        data: { shufflerConfig: config }
                    });
                }
            }
        } catch (e) {}

        return { success: false, message: 'Failed to execute shuffle. Check server logs.' };
    }
};

export const getShuffleCountOrg = async (organisationId: string, customConfig?: any) => {
    try {
        const org = await prisma.organisation.findUnique({
            where: { id: organisationId, isDeleted: false }
        });

        const config = customConfig || (org?.shufflerConfig as any);
        if (!org || !config) {
            return { success: false, message: 'No valid shuffler config found.', count: 0 };
        }

        
        if (!config.statuses || config.statuses.length === 0) {
            return { success: false, message: 'No lead statuses configured for shuffling.', count: 0 };
        }

        if (!config.selectAllUsers && (!config.users || config.users.length === 0)) {
            return { success: false, message: 'No users selected for shuffling.', count: 0 };
        }

        const timeFrameType = config.timeFrameType || 'days_before';
        let dateCondition: any = undefined;

        if (timeFrameType === 'date_range' && config.fromDate && config.toDate) {
            dateCondition = { gte: new Date(config.fromDate), lte: new Date(config.toDate) };
        } else if (timeFrameType === 'backwards_from_date' && config.backwardsDate) {
            dateCondition = { lt: new Date(config.backwardsDate) };
        }

        let activeUsersWhere: any = {
            organisationId: org.id,
            isActive: true,
            isOffDuty: false,
            role: { notIn: ['super_admin', 'admin'] }
        };

        if (config.selectAllUsers) {
            if (!config.selectAllBranches && config.branches && config.branches.length > 0) {
                activeUsersWhere.branchId = { in: config.branches };
            }
        } else {
            activeUsersWhere.id = { in: config.users };
        }

        const activeUsers = await prisma.user.findMany({
            where: activeUsersWhere,
            select: { id: true }
        });

        if (activeUsers.length === 0) {
            return { success: false, message: 'No active non-admin users available.', count: 0 };
        }

        const activeUserIds = activeUsers.map(u => u.id);
        const excludedStatuses = ['closed_won', 'closed_lost', 'Closed Won', 'Closed Lost', 'closed won', 'closed lost'];
        const validStatuses = config.statuses.filter((s: string) => !excludedStatuses.includes(s) && !excludedStatuses.includes(s.toLowerCase()));

        let leadWhereCondition: any = {
            organisationId: org.id,
            isDeleted: false,
            status: { in: validStatuses },
            assignedToId: { in: activeUserIds }
        };

        if (dateCondition) {
            leadWhereCondition.createdAt = dateCondition;
        }

        const eligibleLeadsCount = await prisma.lead.count({
            where: leadWhereCondition
        });

        const statusCounts = await prisma.lead.groupBy({
            by: ['status'],
            where: leadWhereCondition,
            _count: { _all: true }
        });

        const countsByStatus = statusCounts.reduce((acc, curr) => {
            acc[curr.status] = curr._count._all;
            return acc;
        }, {} as Record<string, number>);

        return { success: true, count: eligibleLeadsCount, countsByStatus, message: 'Count retrieved' };
    } catch (error) {
        console.error('[ShufflerService] Error during shuffle count execution:', error);
        return { success: false, message: 'Failed to count leads', count: 0 };
    }
};
