import { cronPrisma } from '../config/prisma';
import { NotificationService } from './notificationService';

/**
 * Enforces each AssignmentRule's "Lead Rotation Policy (SLA)" settings
 * (enableRotation / timeLimitMinutes / rotationType). Previously these
 * fields existed on the model and in the UI but nothing ever read them -
 * this is the missing enforcement half.
 *
 * A lead is "not acted upon" if no Interaction has been logged against it
 * since it was last assigned to its current owner. "Assigned at" is the
 * most recent LeadHistory row for the lead (every reassignment writes one
 * - see distributionService.ts), falling back to Lead.createdAt for a
 * lead that has never been reassigned.
 */
export const LeadRotationService = {
    async runRotationCheck() {
        const rules = await cronPrisma.assignmentRule.findMany({
            where: {
                isActive: true,
                isDeleted: false,
                enableRotation: true,
                timeLimitMinutes: { gt: 0 }
            }
        });

        for (const rule of rules) {
            try {
                await this.processRule(rule);
            } catch (error) {
                console.error(`[LeadRotation] Error processing rule ${rule.id} (${rule.name}):`, error);
            }
        }
    },

    async processRule(rule: any) {
        // Rotation only makes sense for leads with a live owner today - other
        // entities aren't wired to this concept.
        if (rule.entity !== 'Lead') return;

        const cutoff = new Date(Date.now() - rule.timeLimitMinutes * 60 * 1000);

        const where: any = {
            organisationId: rule.organisationId,
            isDeleted: false,
            assignedToId: { not: null }
        };
        if (rule.branchId) where.branchId = rule.branchId;

        const leads = await cronPrisma.lead.findMany({
            where,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                assignedToId: true,
                createdAt: true,
                history: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
                interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } }
            }
        });

        for (const lead of leads) {
            const assignedAt = lead.history[0]?.createdAt ?? lead.createdAt;
            if (assignedAt > cutoff) continue; // still inside the grace period

            const lastActivity = lead.interactions[0]?.date;
            if (lastActivity && lastActivity > assignedAt) continue; // already acted upon since assignment

            const newOwnerId = await this.pickRotationTarget(rule, lead.assignedToId as string);
            if (!newOwnerId || newOwnerId === lead.assignedToId) continue;

            await this.rotateLead(lead, newOwnerId, rule);
        }
    },

    /**
     * The round-robin pool a "Round Robin" rule assigns new leads from
     * (assignTo.users for multi-user round robin, assignTo.value for a
     * single specific user) - rotation picks from the SAME pool, not a
     * separate list.
     */
    getPoolUserIds(rule: any): string[] {
        const assignTo = rule.assignTo as any;
        if (!assignTo) return [];
        if (Array.isArray(assignTo.users)) return assignTo.users;
        if (assignTo.value) return [assignTo.value];
        return [];
    },

    async pickRotationTarget(rule: any, currentOwnerId: string): Promise<string | null> {
        if (rule.rotationType === 'manager') {
            const owner = await cronPrisma.user.findUnique({
                where: { id: currentOwnerId },
                select: { reportsToId: true }
            });
            if (owner?.reportsToId) return owner.reportsToId;
            // No manager on file - fall through to the random logic below.
        }

        const poolIds = this.getPoolUserIds(rule);
        const otherPoolMembers = poolIds.filter(id => id !== currentOwnerId);

        let candidateIds: string[];
        if (otherPoolMembers.length > 0) {
            // The round-robin pool has other members besides the current
            // owner - rotate among them.
            candidateIds = otherPoolMembers;
        } else {
            // Pool is empty, or only contained the current owner (the
            // "single user selected" case) - go outside the pool instead of
            // starving the lead of a next owner.
            const outsiders = await cronPrisma.user.findMany({
                where: {
                    organisationId: rule.organisationId,
                    isActive: true,
                    id: { notIn: [...poolIds, currentOwnerId] },
                    ...(rule.branchId ? { branchId: rule.branchId } : {})
                },
                select: { id: true }
            });
            candidateIds = outsiders.map(u => u.id);
        }

        if (candidateIds.length === 0) return null;
        return candidateIds[Math.floor(Math.random() * candidateIds.length)];
    },

    async rotateLead(lead: any, newOwnerId: string, rule: any) {
        const oldOwnerId = lead.assignedToId as string;

        await cronPrisma.$transaction([
            cronPrisma.lead.update({
                where: { id: lead.id },
                data: {
                    assignedToId: newOwnerId,
                    previousOwnerId: oldOwnerId,
                    rotationViolation: true,
                    violationTime: new Date()
                }
            }),
            cronPrisma.leadHistory.create({
                data: {
                    leadId: lead.id,
                    oldOwnerId,
                    newOwnerId,
                    changedById: newOwnerId,
                    reason: `Auto-rotated via SLA rule "${rule.name}" - not acted upon within ${rule.timeLimitMinutes} minutes`
                }
            })
        ]);

        console.log(`[LeadRotation] Rotated lead ${lead.id} from ${oldOwnerId} to ${newOwnerId} (rule: ${rule.name})`);

        try {
            await NotificationService.send(
                newOwnerId,
                'Lead Reassigned (SLA Rotation)',
                `A lead (${lead.firstName} ${lead.lastName || ''}) was reassigned to you because the previous owner did not act on it in time.`,
                'info'
            );
        } catch (error) {
            console.error('[LeadRotation] Failed to notify new owner:', error);
        }
    }
};
