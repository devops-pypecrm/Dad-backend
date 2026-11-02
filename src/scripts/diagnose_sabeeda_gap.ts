import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  
  // Yesterday: hw_347-364 in DB. Today: hw_413 in DB. 
  // Gap: hw_365 to hw_412 (48 calls) — where are they?
  
  // Check if any hw in 365-412 range exists in DB
  const gap = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
    },
    select: { hardwareId: true, date: true, createdAt: true, callStatus: true, duration: true },
    orderBy: [{ hardwareId: 'asc' }],
  });
  
  // Filter numerically
  const gapRows = gap.filter(r => {
    const num = parseInt(r.hardwareId?.split('_').pop() ?? '0');
    return num >= 365 && num <= 412;
  });
  console.log(`Rows with hw _365 to _412 (today's missing calls): ${gapRows.length}`);
  for (const r of gapRows) {
    const hwNum = r.hardwareId?.split('_').pop();
    console.log(`  hw=${hwNum} date=${r.date.toISOString().slice(0,16)} status=${r.callStatus}`);
  }
  
  // So the gap rows are missing from DB entirely. The reconciler says "45 synced" but these 48 aren't in DB.
  // That means the reconciler is NOT sending these hw IDs. 
  // WHY? Because the reconciler scans the Android CallLog.
  // Android's CallLog has a default size limit (typically 500 most recent calls).
  // If the phone's CallLog already had 500+ calls BEFORE today, the oldest ones get evicted.
  // hw_365-412 = calls from a time when the phone had older calls filling the buffer.
  // BUT WAIT — hw_413 IS in DB (from today) and hw_364 is from YESTERDAY (in DB).
  // So the gap is hw 365-412 — those might be calls that happened WHEN THE APP WASN'T INSTALLED.
  
  // More likely: hw 365-412 are from Oct 28 between hw_364 (11:52 AM) and hw_413 (today 3:49PM IST).
  // These are calls that happened AFTER the app last synced successfully yesterday.
  
  // Check what date range hw_365-412 would cover based on neighboring entries
  const hw364 = await prisma.interaction.findFirst({
    where: { createdById: userId, hardwareId: `${userId}_364` },
    select: { date: true, createdAt: true }
  });
  const hw413 = await prisma.interaction.findFirst({
    where: { createdById: userId, hardwareId: `${userId}_413` },
    select: { date: true, createdAt: true }
  });
  console.log(`\nhw_364: date=${hw364?.date?.toISOString()} createdAt=${hw364?.createdAt?.toISOString()}`);
  console.log(`hw_413: date=${hw413?.date?.toISOString()} createdAt=${hw413?.createdAt?.toISOString()}`);
  console.log(`\nGap inference: hw_365-412 (48 calls) = calls between ${hw364?.date?.toISOString()} and ${hw413?.date?.toISOString()}`);
  console.log(`These 48 calls are MISSING from the DB — they exist on the phone but never synced.`);
  
  // Check the "45 calls queued" reconciliation — are those the same 45?
  // CALL_LOG_RECONCILED: queued 45 calls at 11:13 IST
  // That IS around the right number (48 gap calls = close to 45)
  // But BULK_SYNC_SUCCESS also says 45 synced — so either:
  // (a) They synced but got deduplicated to existing rows (not new inserts), or
  // (b) The server is returning "synced" for the ones it matched to old rows
  
  // Let's check total calls around the date range of the gap
  // hw_364 was Oct 28 11:52. hw_413 was Oct 29 15:49 IST.
  // So gap = Oct 28 12:00 to Oct 29 15:49 — that's ~28 hours.
  
  const callsInGapWindow = await prisma.interaction.count({
    where: {
      createdById: userId,
      type: 'call',
      date: { 
        gte: new Date('2026-10-28T06:22:00Z'), // hw_364 = 11:52 IST = 06:22 UTC
        lte: new Date('2026-10-29T10:19:00Z')  // hw_413 = 15:49 IST = 10:19 UTC
      }
    }
  });
  console.log(`\nDB rows with date between hw_364 and hw_413 timestamps: ${callsInGapWindow}`);
  
  // The REAL clue: what's the "45 synced" telling us?
  // Looking at CALL_LOG_RECONCILED: "queued 45 call(s) not seen by real-time path"
  // This means: the reconciler scanned the CallLog, found 45 calls it didn't see via PHONE_STATE.
  // These ARE the hw_365-412 + hw_413 (46 total) — matching!
  // BULK_SYNC_SUCCESS says 45 synced — meaning the server accepted them.
  // But only 1 new row (hw_413) was created. That means 44 were MATCHED to existing rows.
  // Existing rows have correct hw_IDs for those entries... wait, that can't be right since we 
  // confirmed they're NOT in the DB.
  
  // ALTERNATIVE: The server matched those 45 calls via PHONE NUMBER + TIME fuzzy match to 
  // EXISTING rows from hw 1-364 era. Wrong rows got updated!
  
  // This would happen if the reconciler is sending OLD calls (low hw IDs, old timestamps) 
  // as if they're new — and the server's fuzzy match finds the correct historical rows and 
  // "updates" them (already correct data, no visible change) while reporting "synced".
  
  // TLDR: The "45 calls queued not seen by real-time path" are genuinely PAST calls that
  // the reconciler found in CallLog and the server already has. They sync fine (as updates).
  // The NEW calls (hw_365-412) are a mystery — are they in the reconciler's queue at all?
  
  console.log('\n--- checking if today\'s new calls have no matching number in CRM ---');
  // Look at CALL_RINGING today's 16 events to see phone numbers
  const ringingLogs = await prisma.helperActivityLog.findMany({
    where: { userId, event: 'CALL_RINGING', clientTimestamp: { gte: new Date('2026-10-29T00:00:00Z') } },
    select: { detail: true, clientTimestamp: true },
    orderBy: { clientTimestamp: 'asc' },
  });
  console.log('CALL_RINGING detail (first 10):');
  for (const l of ringingLogs.slice(0, 10)) console.log('  ', l.detail, '@', l.clientTimestamp.toISOString());
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
