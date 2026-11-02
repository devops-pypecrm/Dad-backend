import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  
  // The key observation:
  // - hw IDs go up to _413 on Oct 29 (today), then _414 is from Oct 1
  // - String sort: "_41" < "_413" < "_414" alphabetically
  // - So the CALL_LOG_RECONCILED "45 calls queued" are calls from OLD dates being re-sent
  
  // The helper app's CallLogReconciler reads Android's CallLog, which includes ALL historical calls.
  // It should track which calls were already synced and skip them.
  // The "synced" log means the server processed them (found existing row, updated it — still = synced).
  
  // THE ACTUAL BUG: Today's new calls are not showing up in the report.
  // Evidence:
  // 1. Only 1 new row created today (hw _413) despite 130+ CALL_ENDED events
  // 2. But CALL_ENDED duration log DOES confirm the app is detecting calls correctly
  // 3. The bulk syncs of 45/23/10 etc are reconciling OLD calls from the historical CallLog 
  //    (the reconciler scans all calls it hasn't confirmed synced, which after a reinstall = all 400+)
  
  // Why aren't today's NEW calls creating rows?
  // CALL_ENDED triggers real-time recording path. Then CallLogReconciler runs separately.
  // The real-time path calls a different endpoint (not bulk-sync) — let's check
  
  // Check: does the real-time path create a row?
  // Look for calls detected today via CALL_DETECTED or CALL_STATE_CHANGE logs
  const callDetectedLogs = await prisma.helperActivityLog.findMany({
    where: {
      userId,
      event: { in: ['CALL_DETECTED', 'CALL_RINGING'] },
      clientTimestamp: { gte: new Date('2026-10-29T00:00:00Z') }
    },
    orderBy: { clientTimestamp: 'asc' },
    take: 20,
  });
  console.log(`CALL_RINGING/DETECTED logs today: ${callDetectedLogs.length}`);
  
  // How does the real-time path sync? Check if there's a CALL_SYNC or similar event
  const allEventTypes = await prisma.helperActivityLog.groupBy({
    by: ['event'],
    where: { userId },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });
  console.log('\nAll event types for this user:');
  for (const e of allEventTypes) console.log(`  ${e.event}: ${e._count.id}`);

  // The reconciler collects from CallLog and sends bulk-sync
  // Real-time path just detects via PHONE_STATE, then ALSO adds to reconciler queue?
  // Or does real-time path do its own API call?
  
  // Check: are new calls today in the BULK_SYNC_SUCCESS's syncedHardwareIds somehow?
  // We can see hw_413 was created today (the only one). What about hw_414-_500 range?
  const newHwRange = await prisma.interaction.count({
    where: {
      createdById: userId,
      type: 'call',
      hardwareId: { startsWith: `${userId}_` },
      date: { gte: new Date('2026-10-29T00:00:00Z') },
    }
  });
  console.log(`\nCalls with date >= Oct 29 UTC: ${newHwRange}`);
  
  // So the reconciler re-syncs historical calls (already in DB, just updates) while new calls
  // might be failing silently. Let's check if there are any BULK_SYNC_FAILED logs today
  const failLogs = await prisma.helperActivityLog.findMany({
    where: { userId, event: { in: ['BULK_SYNC_FAILED', 'BULK_SYNC_ERROR', 'SYNC_ERROR'] }, clientTimestamp: { gte: new Date('2026-10-28T18:30:00Z') } }
  });
  console.log(`\nSync failure logs today: ${failLogs.length}`);
  for (const l of failLogs) console.log('  ', l);

  // Check if the app was reinstalled recently (hardwareId counter reset)
  // hw _413 today — but old hw went into thousands. This means the phone was RESET or app REINSTALLED.
  // After reinstall, the reconciler sees ALL historical CallLog entries (up to Android's limit, 
  // typically 500 most recent) as "not yet synced" and sends them in batches.
  // The "synced" = the server found existing rows and updated them (no new data = fine).
  // But new calls today made AFTER reinstall = NEW hardwareIds starting from 1 again?
  // No, hw _413 suggests it IS counting up from somewhere. Let me check the range.
  
  const todayHwNumbers = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', createdAt: { gte: new Date('2026-10-28T18:30:00Z') } },
    select: { hardwareId: true, date: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\nAll rows created since IST midnight today (to find hw range):`);
  for (const r of todayHwNumbers) console.log('  ', r);
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
