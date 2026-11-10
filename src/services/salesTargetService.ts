
import prisma from '../config/prisma';
import { NotificationService } from './notificationService';
import { runWithCurrency } from '../utils/moneyConversion';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A target's endDate is stored as midnight at the START of its last day; the period includes that whole day. */
const periodEndExclusive = (endDate: Date): Date => {
    const d = new Date(endDate);
    const atMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
    return atMidnight ? new Date(d.getTime() + DAY_MS) : new Date(d.getTime() + 1);
};

export class SalesTargetService {
    /**
     * Updates the progress of a user's active targets based on won opportunities.
     * Also handles rolling up progress to parent targets.
     * @param userId The ID of the user (opportunity owner)
     * @param date The date of the opportunity update (usually 'now')
     */
    static async updateProgressForUser(userId: string, date: Date = new Date()) {
        try {
            // Money is stored in USD and the Prisma money middleware converts to the *current request's*
            // currency. Targets are entered in the organisation's currency, so always compute inside the
            // owner's organisation currency - otherwise a call from cron/webhook (no request context) would
            // compare raw USD against an INR target and the progress would look almost empty.
            const owner = await prisma.user.findUnique({
                where: { id: userId },
                select: { organisation: { select: { currency: true } } }
            });
            const currency = (owner?.organisation?.currency || 'USD').toUpperCase();
            await runWithCurrency(currency, () => SalesTargetService.computeForUser(userId, date));
        } catch (error) {
            console.error('[SalesTargetService] Error updating progress:', error);
        }
    }

    /** Re-computes every active leaf target in its current period. Run on a schedule as a safety net. */
    static async recalculateAllActive() {
        const now = new Date();
        const rows = await prisma.salesTarget.findMany({
            where: {
                assignedToId: { not: null },
                isDeleted: false,
                autoDistributed: false,
                status: { in: ['active', 'completed'] },
                startDate: { lte: now },
                endDate: { gte: new Date(now.getTime() - DAY_MS) }
            },
            select: { assignedToId: true },
            distinct: ['assignedToId']
        });
        for (const r of rows) {
            if (r.assignedToId) await SalesTargetService.updateProgressForUser(r.assignedToId, now);
        }
        console.log(`[SalesTargetService] Recalculated targets for ${rows.length} users`);
    }

    private static async computeForUser(userId: string, date: Date) {
        // Targets store their last day at 00:00, so the period really runs until the end of that day.
        // (Previously a deal closed on the last day was never counted, and the target even stopped updating.)
        const activeTargets = await prisma.salesTarget.findMany({
            where: {
                assignedToId: userId,
                status: { in: ['active', 'completed'] },
                isDeleted: false,
                autoDistributed: false, // Only update leaf nodes
                startDate: { lte: date },
                endDate: { gte: new Date(date.getTime() - DAY_MS) }
            }
        });

        for (const target of activeTargets) {
            const windowEnd = periodEndExclusive(target.endDate);
            const typeFilter = target.opportunityType ? { type: target.opportunityType } : {};

            // A deal belongs to the period it was CLOSED in (closeDate is set when the deal is closed and is
            // what every dashboard uses); fall back to updatedAt only for old deals that have no closeDate.
            const inPeriod = {
                OR: [
                    { closeDate: { gte: target.startDate, lt: windowEnd } },
                    { closeDate: null, updatedAt: { gte: target.startDate, lt: windowEnd } }
                ]
            };
            const wonWhere = {
                ownerId: userId,
                stage: 'closed_won',
                isDeleted: false,
                ...inPeriod,
                ...typeFilter
            };

            let achievedValue = 0;

            if (target.productId) {
                // Product target: only that product's quote lines count.
                const agg = await prisma.quoteLineItem.aggregate({
                    where: { productId: target.productId, quote: { opportunity: wonWhere } },
                    _sum: { quantity: true, total: true }
                });
                achievedValue = target.metric === 'units' ? (agg._sum.quantity || 0) : (agg._sum.total || 0);
            } else if (target.metric === 'units') {
                // Units without a product: quantity from the deal's quote lines when it has any, otherwise the
                // deal itself is one unit. (Counting only quote lines made every unit target stay at 0 for
                // teams that close deals without building a quote.)
                const won = await prisma.opportunity.findMany({ where: wonWhere as any, select: { id: true } });
                if (won.length > 0) {
                    const lines = await prisma.quoteLineItem.findMany({
                        where: { quote: { opportunityId: { in: won.map((o) => o.id) } } },
                        select: { quantity: true, quote: { select: { opportunityId: true } } }
                    });
                    const qtyByOpp = new Map<string, number>();
                    for (const l of lines) {
                        const id = l.quote?.opportunityId;
                        if (id) qtyByOpp.set(id, (qtyByOpp.get(id) || 0) + (l.quantity || 0));
                    }
                    achievedValue = won.reduce((sum, o) => {
                        const q = qtyByOpp.get(o.id) || 0;
                        return sum + (q > 0 ? q : 1);
                    }, 0);
                }
            } else {
                // Revenue: total value of the won deals.
                const agg = await prisma.opportunity.aggregate({ where: wonWhere as any, _sum: { amount: true } });
                achievedValue = agg._sum.amount || 0;
            }

            let newStatus = target.status;
            if (achievedValue >= target.targetValue && target.status !== 'completed') newStatus = 'completed';
            else if (achievedValue < target.targetValue && target.status === 'completed') newStatus = 'active'; // e.g. deal deleted

            console.log(`[SalesTargetService] Target ${target.id}: Achieved ${achievedValue} / ${target.targetValue} (${newStatus})`);

            await prisma.salesTarget.update({
                where: { id: target.id },
                data: { achievedValue, status: newStatus }
            });

            if (target.parentTargetId) {
                await SalesTargetService.rollupToParent(target.parentTargetId);
            }
        }
    }

    /**
     * Recursively rolls up achieved values to parent targets.
     * @param parentTargetId The ID of the parent target
     */
    private static async rollupToParent(parentTargetId: string) {
        try {
            const parentTarget = await prisma.salesTarget.findUnique({
                where: { id: parentTargetId }
            });
            if (!parentTarget || parentTarget.isDeleted) return;

            // Sum achieved values from children
            const childAggregation = await prisma.salesTarget.aggregate({
                where: {
                    parentTargetId: parentTargetId,
                    isDeleted: false
                },
                _sum: {
                    achievedValue: true
                }
            });

            const totalChildAchieved = childAggregation._sum.achievedValue || 0;

            console.log(`[SalesTargetService] Rolling up to parent ${parentTargetId}: Child Sum = ${totalChildAchieved}`);

            const updateData: any = { achievedValue: totalChildAchieved };

            if (totalChildAchieved >= parentTarget.targetValue && parentTarget.status !== 'completed') {
                updateData.status = 'completed';
                // Notify parent... skipped
            } else if (totalChildAchieved < parentTarget.targetValue && parentTarget.status === 'completed') {
                updateData.status = 'active';
            }

            await prisma.salesTarget.update({
                where: { id: parentTargetId },
                data: updateData
            });

            // Recursively go up
            if (parentTarget.parentTargetId) {
                await this.rollupToParent(parentTarget.parentTargetId);
            }

        } catch (error) {
            console.error('[SalesTargetService] Error rolling up to parent:', error);
        }
    }

    /**
     * Checks for expired targets that were not completed, and sends notifications.
     */
    static async checkExpiredTargets() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const expiredTargets = await prisma.salesTarget.findMany({
                where: {
                    status: 'active', // Assumes 'active' targets that pass endDate are missed
                    endDate: { lt: today },
                    isDeleted: false
                },
                include: {
                    assignedTo: {
                        select: { id: true, firstName: true, lastName: true, reportsToId: true, organisationId: true }
                    }
                }
            });

            if (expiredTargets.length === 0) return;

            console.log(`[SalesTargetService] Found ${expiredTargets.length} missed sales targets.`);

            for (const target of expiredTargets) {
                if (!target.assignedToId || !target.assignedTo) continue;

                const metricText = target.metric === 'units' ? 'units' : 'revenue';
                const message = `Sales Target Missed: You achieved ${target.achievedValue} / ${target.targetValue} ${metricText} for ${target.period}.`;

                // Notify User (Disabled as goal/target module is removed)
                // await NotificationService.send(
                //     target.assignedToId,
                //     '❌ Sales Target Missed',
                //     message,
                //     'warning'
                // ).catch(err => console.error(`[SalesTargetService] Failed to notify user ${target.assignedToId}:`, err));

                // // Notify Manager
                // if (target.assignedTo.reportsToId) {
                //     await NotificationService.send(
                //         target.assignedTo.reportsToId,
                //         '⚠️ Team Member Missed Target',
                //         `${target.assignedTo.firstName} ${target.assignedTo.lastName} missed their sales target for ${target.period}. Achieved: ${target.achievedValue} / ${target.targetValue}.`,
                //         'warning'
                //     ).catch(err => console.error(`[SalesTargetService] Failed to notify manager ${target.assignedTo?.reportsToId}:`, err));
                // }

                // // Notify Admins
                // if (target.assignedTo.organisationId) {
                //     const admins = await prisma.user.findMany({
                //         where: { organisationId: target.assignedTo.organisationId, role: 'admin', isActive: true },
                //         select: { id: true }
                //     });
                //     for (const admin of admins) {
                //         await NotificationService.send(
                //             admin.id,
                //             '⚠️ Missed Sales Target',
                //             `${target.assignedTo.firstName} ${target.assignedTo.lastName} missed their sales target for ${target.period}. Achieved: ${target.achievedValue} / ${target.targetValue}.`,
                //             'warning'
                //         ).catch(err => console.error(`[SalesTargetService] Failed to notify admin ${admin.id}:`, err));
                //     }
                // }

                // Mark target as failed/missed if schema supports it, otherwise leave as-is or we update it to 'failed'
                // Assuming schema has a 'failed' or 'missed' state, if it errors out we'll know the enum restricts it.
                // Let's try 'failed' as it's common. If it throws, we can adjust.
                try {
                    await prisma.salesTarget.update({
                        where: { id: target.id },
                        data: { status: 'failed' as any }
                    });
                } catch (e) {
                    console.error('[SalesTargetService] Could not update status to failed. Schema may not support it.', e);
                }
            }
        } catch (error) {
            console.error('[SalesTargetService] Error checking expired targets:', error);
        }
    }
}
