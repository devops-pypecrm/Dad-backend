import prisma from '../config/prisma';

async function main() {
    const userId = 'd4986907-a554-4cff-80cb-460d1f73d7e8';
    const istOffset = 5.5 * 60 * 60 * 1000;

    // Today's IST window start (midnight IST) through 09:19 IST (when the only logged call started)
    const now = new Date();
    const istNow = new Date(now.getTime() + istOffset);
    const istStart = new Date(istNow); istStart.setUTCHours(0, 0, 0, 0);
    const startOfDayUTC = new Date(istStart.getTime() - istOffset);
    const cutoffUTC = new Date('2026-10-31T03:49:41.000Z'); // when the one known call started

    const logs = await prisma.helperActivityLog.findMany({
        where: { userId, clientTimestamp: { gte: startOfDayUTC, lte: cutoffUTC } },
        orderBy: { clientTimestamp: 'asc' },
    });
    console.log(`HelperActivityLog entries from midnight IST to the known 09:19 IST call (${logs.length} rows):`);
    for (const l of logs) {
        const istTime = new Date(l.clientTimestamp.getTime() + istOffset).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`  ${istTime} IST [${l.level}] ${l.event} :: ${l.detail ?? ''}`);
    }

    if (logs.length === 0) {
        console.log('\nNo helper activity at all this morning before 09:19 IST.');
        // Check the last log before midnight to see when the app was last definitely alive
        const lastBefore = await prisma.helperActivityLog.findFirst({
            where: { userId, clientTimestamp: { lt: startOfDayUTC } },
            orderBy: { clientTimestamp: 'desc' },
        });
        if (lastBefore) {
            const istTime = new Date(lastBefore.clientTimestamp.getTime() + istOffset).toISOString().replace('T', ' ').slice(0, 19);
            console.log(`Last known activity before midnight IST: ${istTime} IST — ${lastBefore.event} :: ${lastBefore.detail ?? ''}`);
        }
    }
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
