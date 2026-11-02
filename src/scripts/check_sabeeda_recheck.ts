import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istStart = new Date(istNow); istStart.setUTCHours(0, 0, 0, 0);
  const istEnd = new Date(istNow); istEnd.setUTCHours(23, 59, 59, 999);
  const startOfDay = new Date(istStart.getTime() - istOffset);
  const endOfDay = new Date(istEnd.getTime() - istOffset);

  // Check how many calls Sabeeda has in today's report window right now
  const todayCalls = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
      date: { gte: startOfDay, lte: endOfDay },
      isDeleted: false,
      callStatus: { not: 'initiated' },
    },
    select: { id: true, date: true, duration: true, callStatus: true, phoneNumber: true, hardwareId: true },
    orderBy: { date: 'desc' }
  });

  console.log(`Sabeeda calls in today IST window: ${todayCalls.length}`);
  for (const c of todayCalls) {
    console.log(`  id=${c.id} date=${c.date.toISOString()} dur=${c.duration} status=${c.callStatus} phone=${c.phoneNumber} hw=${c.hardwareId}`);
  }

  // Check if any recent helperActivityLogs have arrived in the last 15 mins
  const recentLogs = await prisma.helperActivityLog.findMany({
    where: { userId, createdAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log(`\nLogs in last 15 mins: ${recentLogs.length}`);
  for (const l of recentLogs) {
    console.log(`  [${l.level}] ${l.event} detail=${l.detail} @ ${l.createdAt.toISOString()}`);
  }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
