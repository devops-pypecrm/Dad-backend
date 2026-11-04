import prisma from '../config/prisma';

export type IncentiveConfig = {
    enabled: boolean;
    calculationType: 'percentage' | 'fixed';
    value: number;
    minimumDealAmount: number;
    defaultStatus: 'pending' | 'approved';
};

export const DEFAULT_INCENTIVE_CONFIG: IncentiveConfig = {
    enabled: false,
    calculationType: 'percentage',
    value: 5,
    minimumDealAmount: 0,
    defaultStatus: 'pending',
};

export const normalizeIncentiveConfig = (raw: unknown): IncentiveConfig => {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<IncentiveConfig>;
    return {
        enabled: value.enabled === true,
        calculationType: value.calculationType === 'fixed' ? 'fixed' : 'percentage',
        value: Number.isFinite(Number(value.value)) ? Math.max(0, Number(value.value)) : 5,
        minimumDealAmount: Number.isFinite(Number(value.minimumDealAmount)) ? Math.max(0, Number(value.minimumDealAmount)) : 0,
        defaultStatus: value.defaultStatus === 'approved' ? 'approved' : 'pending',
    };
};

export async function calculateIncentiveForOpportunity(opportunityId: string, createdById?: string) {
    const opportunity = await prisma.opportunity.findUnique({
        where: { id: opportunityId },
        select: { id: true, name: true, amount: true, stage: true, ownerId: true, organisationId: true, closeDate: true, isDeleted: true },
    });
    if (!opportunity || opportunity.isDeleted || opportunity.stage !== 'closed_won' || !opportunity.ownerId) return null;

    const organisation = await prisma.organisation.findUnique({ where: { id: opportunity.organisationId }, select: { incentiveConfig: true } });
    const config = normalizeIncentiveConfig(organisation?.incentiveConfig);
    if (!config.enabled || config.value <= 0 || opportunity.amount < config.minimumDealAmount) return null;

    const existing = await prisma.commission.findFirst({
        where: { organisationId: opportunity.organisationId, dealId: opportunity.id, source: 'automatic', isDeleted: false },
    });
    if (existing) return existing;

    const amount = config.calculationType === 'percentage'
        ? Math.round((opportunity.amount * config.value / 100) * 100) / 100
        : Math.round(config.value * 100) / 100;
    if (amount <= 0) return null;

    try {
        return await prisma.commission.create({
            data: {
            userId: opportunity.ownerId,
            amount,
            currency: 'INR',
            status: config.defaultStatus,
            type: 'incentive',
            source: 'automatic',
            calculationBase: opportunity.amount,
            calculationRate: config.value,
            description: config.calculationType === 'percentage'
                ? `${config.value}% incentive for won deal: ${opportunity.name}`
                : `Fixed incentive for won deal: ${opportunity.name}`,
            dealId: opportunity.id,
            date: opportunity.closeDate || new Date(),
            organisationId: opportunity.organisationId,
            createdById,
            },
        });
    } catch (error: any) {
        if (error?.code === 'P2002') {
            return prisma.commission.findFirst({
                where: { organisationId: opportunity.organisationId, dealId: opportunity.id, source: 'automatic', isDeleted: false },
            });
        }
        throw error;
    }
}

export async function calculateHistoricalIncentives(organisationId: string, createdById: string) {
    const opportunities = await prisma.opportunity.findMany({
        where: { organisationId, stage: 'closed_won', ownerId: { not: null }, isDeleted: false },
        select: { id: true },
    });
    let created = 0;
    let skipped = 0;
    for (const opportunity of opportunities) {
        const before = await prisma.commission.count({ where: { organisationId, dealId: opportunity.id, source: 'automatic', isDeleted: false } });
        await calculateIncentiveForOpportunity(opportunity.id, createdById);
        if (before === 0) {
            const after = await prisma.commission.count({ where: { organisationId, dealId: opportunity.id, source: 'automatic', isDeleted: false } });
            if (after > 0) created += 1; else skipped += 1;
        } else skipped += 1;
    }
    return { evaluated: opportunities.length, created, skipped };
}
