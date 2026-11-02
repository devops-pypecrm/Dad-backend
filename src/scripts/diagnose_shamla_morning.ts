import prisma from '../config/prisma';

async function main() {
    const userId = 'd4986907-a554-4cff-80cb-460d1f73d7e8';

    const istOffset = 5.5 * 60 * 60 * 1000;
    const now = new Date();
    const istNow = new Date(now.getTime() + istOffset);
    const istStart = new Date(istNow); istStart.setUTCHours(0, 0, 0, 0);
    const istEnd = new Date(istNow); istEnd.setUTCHours(23, 59, 59, 999);
    const startOfDay = new Date(istStart.getTime() - istOffset);
    const endOfDay = new Date(istEnd.getTime() - istOffset);
    console.log('Today (IST) window UTC:', startOfDay.toISOString(), 'to', endOfDay.toISOString());

    const todayCalls = await prisma.interaction.findMany({
        where: { createdById: userId, type: 'call', date: { gte: startOfDay, lte: endOfDay } },
        select: { id: true, direction: true, duration: true, hardwareDuration: true, recordingDuration: true, callStatus: true, date: true, phoneNumber: true },
        orderBy: { date: 'asc' },
    });
    console.log(`\n${todayCalls.length} calls today, earliest first:`);
    for (const c of todayCalls) {
        const istTime = new Date(c.date.getTime() + istOffset).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`  ${istTime} IST | dir=${c.direction} status=${c.callStatus} duration=${c.duration}min (${((c.duration ?? 0) * 60).toFixed(0)}s) hwDur=${c.hardwareDuration}s recDur=${c.recordingDuration}s phone=${c.phoneNumber}`);
    }

    // Also check yesterday in case "this morning" was meant loosely / timezone confusion
    const yStart = new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000);
    const yEnd = new Date(endOfDay.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayCalls = await prisma.interaction.findMany({
        where: { createdById: userId, type: 'call', date: { gte: yStart, lte: yEnd } },
        select: { duration: true, callStatus: true, date: true, phoneNumber: true },
        orderBy: { date: 'asc' },
        take: 3,
    });
    console.log(`\nYesterday's first few calls (for comparison):`);
    for (const c of yesterdayCalls) {
        const istTime = new Date(c.date.getTime() + istOffset).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`  ${istTime} IST | status=${c.callStatus} duration=${c.duration}min phone=${c.phoneNumber}`);
    }
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
