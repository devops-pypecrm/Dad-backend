import prisma from '../config/prisma';

async function main() {
    const users = await prisma.user.findMany({
        where: {
            OR: [
                { firstName: { contains: 'sabeeda', mode: 'insensitive' } },
                { lastName: { contains: 'sabeeda', mode: 'insensitive' } },
                { email: { contains: 'sabeeda', mode: 'insensitive' } },
            ],
        },
        select: { id: true, email: true, firstName: true, lastName: true, organisationId: true, role: true, isActive: true, isDeleted: true },
    });
    console.log('Matching users:', users);
    if (users.length === 0) {
        console.log('No user found matching "sabeeda".');
        return;
    }

    for (const user of users) {
        console.log(`\n=== ${user.firstName} ${user.lastName} (${user.email}) id=${user.id} org=${user.organisationId} ===`);

        const org = await prisma.organisation.findUnique({ where: { id: user.organisationId! }, select: { id: true, name: true } });
        console.log('Org:', org);

        const settings = await prisma.callSettings.findUnique({ where: { organisationId: user.organisationId! } });
        console.log('CallSettings:', settings);

        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const totalCalls = await prisma.interaction.count({
            where: { createdById: user.id, type: 'call', date: { gte: sevenDaysAgo } },
        });
        console.log('Total call Interaction rows (last 7 days, by date field):', totalCalls);

        const recent = await prisma.interaction.findMany({
            where: { createdById: user.id, type: 'call' },
            select: {
                id: true, direction: true, duration: true, callStatus: true,
                date: true, createdAt: true, isDeleted: true, hardwareId: true, phoneNumber: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 15,
        });
        console.log(`Most recent 15 call rows (any date, by createdAt) - total ever: ${await prisma.interaction.count({ where: { createdById: user.id, type: 'call' } })}`);
        for (const r of recent) {
            console.log(`  dir=${r.direction} dur=${r.duration} status=${r.callStatus} isDeleted=${r.isDeleted} date=${r.date.toISOString()} createdAt=${r.createdAt.toISOString()} hw=${r.hardwareId} phone=${r.phoneNumber}`);
        }

        // Check the pending/queued sync table if it exists (helper app's server-side retry queue)
        const pendingCount = await prisma.interaction.count({
            where: { createdById: user.id, type: 'call', isDeleted: true },
        });
        console.log('Soft-deleted call rows for this user:', pendingCount);
    }
}

main()
    .catch((e) => console.error(e))
    .finally(() => process.exit(0));
