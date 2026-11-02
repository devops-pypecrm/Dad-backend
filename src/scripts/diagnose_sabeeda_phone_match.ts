import prisma from '../config/prisma';

async function main() {
  const orgId = '60ebc5ba-c6ca-496f-812f-39292fa98ea7';

  // Today Sabeeda had 16 CALL_RINGING events but only 1 DB row (hw_413 at 15:49 IST).
  // The other 15 calls exist in CALL_ENDED logs with durations. Let's match them.
  // 
  // CALL_RINGING timestamps today (UTC):
  // 05:19, 06:18, 06:26, 06:48, 07:39, 08:15, 08:26, 08:27, 08:34, 08:41...
  // CALL_ENDED with durations today:
  // 05:21 (134s), 05:39 (26s), 05:40 (36s), 05:41 (37s), 05:44 (150s) — 5 calls before 06:00
  // 06:06 (27s), 06:09 (35s), 06:10 (17s), 06:18 (16s), ...
  //
  // The key question: why aren't these 15 calls landing in the DB?
  // 
  // Hypothesis: Sabeeda's phone numbers DON'T MATCH any CRM lead/contact,
  // AND syncNonCrmContacts is TRUE — so they SHOULD sync.
  // But wait — syncNonCrmContacts IS true. So that's not it.
  //
  // Other hypothesis: the calls ARE being sent in bulk-sync but the server
  // is matching them to EXISTING rows via fuzzy phone match (Phase 3b), 
  // and those existing rows have OLD dates, so the daily report still misses them.
  //
  // Let's check: what calls with those phone numbers exist in DB with old dates?
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  
  // Phone from hw_413 (the one that DID sync today)
  const successfulPhone = '+919220719444';
  const phoneRows = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', phoneNumber: { contains: '9220719444' } },
    select: { hardwareId: true, date: true, createdAt: true, updatedAt: true, callStatus: true, duration: true },
    orderBy: { date: 'desc' },
    take: 5,
  });
  console.log(`Rows for ${successfulPhone}:`);
  for (const r of phoneRows) console.log('  ', r.hardwareId?.split('_').pop(), r.date.toISOString().slice(0,16), r.callStatus, r.duration);
  
  // Now check the CALL_ENDED logs to get today's actual call times
  const endedLogs = await prisma.helperActivityLog.findMany({
    where: { userId, event: 'CALL_ENDED', clientTimestamp: { gte: new Date('2026-10-29T00:00:00Z') } },
    select: { detail: true, clientTimestamp: true },
    orderBy: { clientTimestamp: 'asc' },
  });
  console.log(`\nCALL_ENDED events today (${endedLogs.length} total):`);
  for (const l of endedLogs) console.log(' ', l.detail, '@', l.clientTimestamp.toISOString());
  
  // Check the BULK_SYNC_SUCCESS at 11:13 IST (8:43 UTC) — 45 calls synced
  // These are likely old calls being re-scanned. The 15 new calls that happened after hw_413 
  // haven't synced yet (the sync at 11:13 IST = 05:43 UTC included calls from BEFORE hw_413).
  // 
  // Actually looking at the log timestamps again:
  // - CALL_ENDED at 10:17, 10:18, 10:19, 10:20 IST = before hw_413's createdAt (10:29)
  // - So hw_413 (15:49 IST = 10:19 UTC) was created in the bulk sync at 10:29 UTC
  // - The LATEST bulk sync at 11:13 UTC said 45 synced — but hw_413 was already created.
  // - Those 45 could be the old calls + some of today's new ones.
  
  // The REAL question: do the 45 bulk-synced calls at 11:13 UTC include today's calls?
  // If yes, why didn't new rows get created?
  // Answer: fuzzy match (Phase 3b) matched them to existing rows (same phone, similar time).
  
  // Let's look at what calls happened around 11:13 UTC:
  // CALL_ENDED at 11:14 (128s) — right after the 11:13 bulk sync
  // So the 45 synced at 11:13 were calls that ENDED BEFORE 11:13
  
  // Check: are there rows with date in the 05:00-11:13 UTC window for today?
  const todayEarlyRows = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
      date: { 
        gte: new Date('2026-10-29T05:00:00Z'), // 10:30 IST
        lte: new Date('2026-10-29T11:13:00Z'), // 16:43 IST
      }
    },
    select: { hardwareId: true, date: true, createdAt: true, callStatus: true, duration: true, phoneNumber: true },
    orderBy: { date: 'asc' },
  });
  console.log(`\nRows with date in 10:30-16:43 IST today: ${todayEarlyRows.length}`);
  for (const r of todayEarlyRows) {
    console.log(`  hw=${r.hardwareId?.split('_').pop()} date=${r.date.toISOString().slice(0,16)} ${r.callStatus} ${r.duration}min phone=${r.phoneNumber}`);
  }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
