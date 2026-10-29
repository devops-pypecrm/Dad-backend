import prisma from '../config/prisma';

async function main() {
    const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';

    const logs = await prisma.helperActivityLog.findMany({
        where: { userId },
        orderBy: { clientTimestamp: 'desc' },
        take: 40,
    });
    console.log(`Most recent ${logs.length} HelperActivityLog rows (total ever: ${await prisma.helperActivityLog.count({ where: { userId } })}):`);
    for (const l of logs) {
        console.log(`  [${l.level}] ${l.event} :: ${l.detail ?? ''}  client=${l.clientTimestamp.toISOString()} received=${l.createdAt.toISOString()}`);
    }
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
