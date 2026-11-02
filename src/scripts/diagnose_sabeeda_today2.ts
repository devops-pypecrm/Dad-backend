import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  
  // Check today's IST window
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istStart = new Date(istNow);
  istStart.setUTCHours(0, 0, 0, 0);
  const istEnd = new Date(istNow);
  istEnd.setUTCHours(23, 59, 59, 999);
  const startOfDay = new Date(istStart.getTime() - istOffset);
  const endOfDay = new Date(istEnd.getTime() - istOffset);

  console.log('Server now:', now.toISOString());
  console.log('IST today window (UTC):', startOfDay.toISOString(), '->', endOfDay.toISOString());

  // Check calls synced today by createdAt (what arrived on server today)
  const syncedToday = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', createdAt: { gte: startOfDay } },
    select: { id: true, date: true, createdAt: true, callStatus: true, duration: true, hardwareId: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log(`\nInteraction rows with createdAt >= today IST start: ${syncedToday.length}`);
  for (const r of syncedToday) {
    console.log(`  hw=${r.hardwareId} date=${r.date.toISOString()} createdAt=${r.createdAt.toISOString()} status=${r.callStatus} dur=${r.duration}`);
  }

  // What the daily report actually counts (date field in IST window + not deleted + status != initiated)
  const reportCount = await prisma.interaction.count({
    where: {
      createdById: userId,
      type: 'call',
      date: { gte: startOfDay, lte: endOfDay },
      isDeleted: false,
      callStatus: { not: 'initiated' },
    },
  });
  console.log(`\nDaily report count (date in IST today, not deleted, status!=initiated): ${reportCount}`);

  // Check if calls synced today have old dates (would explain visible sync but not in today's report)
  const recentSynced = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', createdAt: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
    select: { date: true, createdAt: true, callStatus: true, hardwareId: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`\nCalls synced in last 2h (${recentSynced.length} rows): date vs createdAt comparison:`);
  for (const r of recentSynced) {
    const dateIST = new Date(r.date.getTime() + istOffset);
    const inTodayWindow = r.date >= startOfDay && r.date <= endOfDay;
    console.log(`  hw=${r.hardwareId} date(IST)=${dateIST.toISOString()} inToday=${inTodayWindow} status=${r.callStatus}`);
  }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
