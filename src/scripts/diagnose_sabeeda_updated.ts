import prisma from '../config/prisma';

async function main() {
    const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';

    const recentlyUpdated = await prisma.interaction.findMany({
        where: { createdById: userId, type: 'call', updatedAt: { gte: new Date('2026-10-29T00:00:00Z') } },
        select: { id: true, date: true, createdAt: true, updatedAt: true, callStatus: true, duration: true, hardwareId: true, phoneNumber: true },
        orderBy: { updatedAt: 'desc' },
    });
    console.log(`Rows updated today (regardless of date/createdAt): ${recentlyUpdated.length}`);
    for (const r of recentlyUpdated) {
        console.log(`  id=${r.id} date=${r.date.toISOString()} createdAt=${r.createdAt.toISOString()} updatedAt=${r.updatedAt.toISOString()} status=${r.callStatus} dur=${r.duration} hw=${r.hardwareId} phone=${r.phoneNumber}`);
    }
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
