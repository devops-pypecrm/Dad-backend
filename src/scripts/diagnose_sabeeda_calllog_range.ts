import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  
  // The CALL_LOG_RECONCILED logs show "45 calls queued" being re-sent repeatedly.
  // These are existing rows being updated by the reconciler (they land in DB, server counts as synced).
  // But new calls today (after hw_413) are NOT creating rows.
  
  // Key insight: only 16 CALL_RINGING events today vs 130+ CALL_ENDED events.
  // That gap is SUSPICIOUS — CALL_ENDED events include call-log-reconciliation synthetic events
  // not just real-time call detection. The 16 CALL_RINGING = 16 real-time detected calls today.
  
  // Let's see what hardwareId the reconciler is sending for today's calls.
  // The reconciler reads Android CallLog._ID as the hardwareId. 
  // hw_413 = CallLog._ID 413. If today's new calls have _IDs above 413, they should be new rows.
  
  // BUT: the reconciler only sends calls that are "not yet marked as synced" in the app's local DB.
  // After a REINSTALL (likely what happened), the local sync-status DB is empty.
  // So it'd be treating ALL historical calls as unsynced and re-sending them.
  // Meanwhile, it queries CallLog for up to N=500 most recent calls.
  // If the phone's CallLog has 500+ entries, the earliest in the batch might be old, 
  // and today's newest calls (highest _IDs) are included but the server already has them by fuzzy match.
  
  // Check the exact date range of calls the reconciler is sending (from hw IDs in today's bulk syncs)
  // We can infer this from what the server already has: look at what BULK_SYNC_SUCCESS logs map to
  
  // Better: look at recent Interaction rows created in last week to understand hw numbering
  const oct28to29 = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
      createdAt: { gte: new Date('2026-10-27T00:00:00Z') }
    },
    select: { hardwareId: true, date: true, createdAt: true, callStatus: true, duration: true },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  console.log(`Rows created since Oct 27 (last 30):`)
  for (const r of oct28to29) {
    console.log(`  hw=${r.hardwareId?.split('_').pop()} date=${r.date.toISOString().slice(0,16)} createdAt=${r.createdAt.toISOString().slice(0,16)} ${r.callStatus} ${r.duration}min`);
  }
  
  // Check: what is the max hw number across ALL rows for this user?
  // (need to sort numerically not lexicographically)
  const allHwIds = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call' },
    select: { hardwareId: true },
  });
  const nums = allHwIds
    .map(r => parseInt(r.hardwareId?.split('_').pop() ?? '0'))
    .filter(n => !isNaN(n));
  const maxHw = Math.max(...nums);
  const minHw = Math.min(...nums.filter(n => n > 0));
  console.log(`\nHardwareId numeric range: ${minHw} to ${maxHw} (${allHwIds.length} total rows)`);
  
  // The "45 calls queued" sync is the reconciler re-sending historical calls within Android's 
  // CallLog window. Let's check: are the server-side Interaction rows for these old calls 
  // actually getting UPDATED (different updatedAt vs createdAt)?
  const oldUpdated = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
      updatedAt: { gte: new Date('2026-10-29T05:00:00Z') }, // updated today
      createdAt: { lt: new Date('2026-10-28T18:30:00Z') }, // but created before today
    },
    select: { hardwareId: true, date: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });
  console.log(`\nOld rows UPDATED today (reconciler touching past data): ${oldUpdated.length}`);
  for (const r of oldUpdated) {
    const hwNum = r.hardwareId?.split('_').pop();
    console.log(`  hw=${hwNum} date=${r.date.toISOString().slice(0,10)} updatedAt=${r.updatedAt?.toISOString().slice(0,16)}`);
  }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
