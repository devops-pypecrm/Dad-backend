import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istStart = new Date(istNow); istStart.setUTCHours(0,0,0,0);
  const istEnd = new Date(istNow); istEnd.setUTCHours(23,59,59,999);
  const startOfDay = new Date(istStart.getTime() - istOffset);
  const endOfDay = new Date(istEnd.getTime() - istOffset);

  // BULK_SYNC_SUCCESS logs say 4 calls + 6 calls + 23 calls synced today but only 1 row exists?
  // The helper logs show "4 call(s) synced" at 09:27 IST - but only 1 row in DB.
  // Hypothesis: those calls were UPDATES to existing rows (reconciled via hardwareId dedup), 
  // not NEW inserts. The "synced" count in the log = rows upserted/updated, not newly created.

  // Let's look at rows whose createdAt is BEFORE today but date falls in today's window,
  // meaning they were created as placeholders earlier and their date got set to today's call time.
  const olderRowsWithTodayDate = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
      date: { gte: startOfDay, lte: endOfDay },
      createdAt: { lt: startOfDay },
    },
    select: { id: true, date: true, createdAt: true, callStatus: true, duration: true, hardwareId: true },
    orderBy: { date: 'desc' },
  });
  console.log(`Rows with date=today but createdAt=before today (pre-created placeholder): ${olderRowsWithTodayDate.length}`);
  for (const r of olderRowsWithTodayDate) console.log('  ', r);

  // Now check: what does the helper log count vs what actually has date in today's window
  // The CALL_LOG_RECONCILED logs mentioned "queued 4/6/23 calls not seen by real-time path"
  // These are calls found in Android CallLog but NOT matched via real-time PHONE_STATE.
  // They go through dedup. If they match existing rows, they UPDATE not INSERT.

  // Count all calls regardless of isDeleted or status for today
  const allTodayCalls = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', date: { gte: startOfDay, lte: endOfDay } },
    select: { date: true, createdAt: true, callStatus: true, duration: true, hardwareId: true, isDeleted: true },
    orderBy: { date: 'desc' },
  });
  console.log(`\nAll call rows with date in today IST window (including deleted): ${allTodayCalls.length}`);
  for (const r of allTodayCalls) console.log('  ', r);

  // Check: are yesterday's calls actually abundant? Maybe she's confusing yesterday vs today
  const istYesterdayStart = new Date(startOfDay.getTime() - 24*60*60*1000);
  const istYesterdayEnd = new Date(startOfDay.getTime() - 1);
  const yesterdayCalls = await prisma.interaction.count({
    where: { createdById: userId, type: 'call', date: { gte: istYesterdayStart, lte: istYesterdayEnd }, isDeleted: false, callStatus: { not: 'initiated' } }
  });
  console.log(`\nYesterday's call count (report would show): ${yesterdayCalls}`);

  // What is the most recent hardware id number (to understand how many calls total)
  const latestHw = await prisma.interaction.findFirst({
    where: { createdById: userId, type: 'call' },
    orderBy: { createdAt: 'desc' },
    select: { hardwareId: true, createdAt: true }
  });
  console.log(`Latest hw id: ${latestHw?.hardwareId} at ${latestHw?.createdAt?.toISOString()}`);

  // Check if there are bulk sync success logs that say more calls than are in DB
  const logsToday = await prisma.helperActivityLog.findMany({
    where: { userId, clientTimestamp: { gte: startOfDay }, event: { in: ['BULK_SYNC_SUCCESS', 'CALL_LOG_RECONCILED', 'CALL_ENDED'] } },
    orderBy: { clientTimestamp: 'asc' },
    select: { event: true, detail: true, clientTimestamp: true },
  });
  console.log(`\nKey helper logs for today (${logsToday.length} total):`);
  for (const l of logsToday) console.log(`  [${l.event}] ${l.detail ?? ''} @ ${l.clientTimestamp.toISOString()}`);
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
