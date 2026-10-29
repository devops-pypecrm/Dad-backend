import prisma from '../config/prisma';

async function main() {
    const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
    const now = new Date();
    console.log('Server "now":', now.toISOString());

    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const istStart = new Date(istNow); istStart.setUTCHours(0, 0, 0, 0);
    const istEnd = new Date(istNow); istEnd.setUTCHours(23, 59, 59, 999);
    const startOfDay = new Date(istStart.getTime() - istOffset);
    const endOfDay = new Date(istEnd.getTime() - istOffset);
    console.log('IST "today" window (UTC):', startOfDay.toISOString(), 'to', endOfDay.toISOString());

    const todayCalls = await prisma.interaction.findMany({
        where: { createdById: userId, type: 'call', date: { gte: startOfDay, lte: endOfDay } },
        select: { id: true, date: true, createdAt: true, callStatus: true, duration: true },
        orderBy: { date: 'desc' },
    });
    console.log(`Calls with date in today's IST window: ${todayCalls.length}`);
    for (const c of todayCalls) console.log(' ', c);

    const latestSyncTime = await prisma.interaction.findFirst({
        where: { createdById: userId, type: 'call' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
    });
    console.log('Most recent sync (any call) createdAt:', latestSyncTime?.createdAt?.toISOString());

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    console.log('Role string:', JSON.stringify(user?.role));
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
