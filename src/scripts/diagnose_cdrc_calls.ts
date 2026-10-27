import prisma from '../config/prisma';

async function main() {
    const user = await prisma.user.findFirst({
        where: { email: 'bm@cdrc.online' },
        select: { id: true, email: true, firstName: true, lastName: true, organisationId: true, role: true, isActive: true },
    });
    console.log('User:', user);
    if (!user) {
        console.log('No user found with that email.');
        return;
    }

    const org = await prisma.organisation.findUnique({
        where: { id: user.organisationId! },
        select: { id: true, name: true },
    });
    console.log('Org:', org);

    const settings = await prisma.callSettings.findUnique({
        where: { organisationId: user.organisationId! },
    });
    console.log('CallSettings:', settings);

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const totalInteractionsToday = await prisma.interaction.count({
        where: {
            organisationId: user.organisationId!,
            type: 'call',
            createdAt: { gte: startOfToday },
        },
    });
    console.log('Total type=call Interaction rows today (any user, by createdAt):', totalInteractionsToday);

    const userInteractionsToday = await prisma.interaction.findMany({
        where: {
            organisationId: user.organisationId!,
            type: 'call',
            createdAt: { gte: startOfToday },
        },
        select: {
            id: true,
            createdById: true,
            direction: true,
            duration: true,
            callStatus: true,
            createdAt: true,
            date: true,
            isDeleted: true,
            hardwareId: true,
            callSessionId: true,
            phoneNumber: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });
    console.log(`Sample of ${userInteractionsToday.length} call Interaction rows today:`);
    for (const i of userInteractionsToday) {
        console.log(`  createdBy=${i.createdById} dir=${i.direction} dur=${i.duration} status=${i.callStatus} isDeleted=${i.isDeleted} date=${i.date.toISOString()} createdAt=${i.createdAt.toISOString()} hw=${i.hardwareId}`);
    }

    // The ACTUAL filter getDailyReport uses: `date` field (not createdAt) + isDeleted:false.
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const istStartOfDay = new Date(istNow);
    istStartOfDay.setUTCHours(0, 0, 0, 0);
    const istEndOfDay = new Date(istNow);
    istEndOfDay.setUTCHours(23, 59, 59, 999);
    const reportStartOfDay = new Date(istStartOfDay.getTime() - istOffset);
    const reportEndOfDay = new Date(istEndOfDay.getTime() - istOffset);
    console.log('Report day window (UTC):', reportStartOfDay.toISOString(), 'to', reportEndOfDay.toISOString());

    const realReportCount = await prisma.interaction.count({
        where: {
            organisationId: user.organisationId!,
            type: 'call',
            callStatus: { not: 'initiated' },
            date: { gte: reportStartOfDay, lte: reportEndOfDay },
            isDeleted: false,
        },
    });
    console.log('Rows the REAL getDailyReport query would actually count (date field + isDeleted:false):', realReportCount);

    // What getDailyReport's query would actually see (type:'call', callStatus != 'initiated')
    const reportVisibleToday = await prisma.interaction.count({
        where: {
            organisationId: user.organisationId!,
            type: 'call',
            callStatus: { not: 'initiated' },
            createdAt: { gte: startOfToday },
        },
    });
    console.log('Interaction rows that WOULD pass the daily-report filter (callStatus != initiated):', reportVisibleToday);

    const distinctCallStatuses = await prisma.interaction.groupBy({
        by: ['callStatus'],
        where: { organisationId: user.organisationId!, type: 'call', createdAt: { gte: startOfToday } },
        _count: { id: true },
    });
    console.log('Breakdown by callStatus today:', distinctCallStatuses);
}

main()
    .catch((e) => console.error(e))
    .finally(() => process.exit(0));
