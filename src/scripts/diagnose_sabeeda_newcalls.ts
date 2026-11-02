import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';
  const orgId = '60ebc5ba-c6ca-496f-812f-39292fa98ea7';

  // 16 CALL_RINGING events today but only 1 DB row created. 
  // The real-time path: RINGING -> ACTIVE -> ENDED -> CallLogReconciler queues it -> BulkSync sends it.
  // BulkSync deduplicates by hw_ID. If today's calls have hw_IDs already in DB (from a new phone
  // where CallLog._ID restarts at small numbers), then the server updates those old rows with 
  // the new data rather than inserting, and the old date stays.
  
  // Check: what hw_IDs would today's 16 calls have?
  // The latest row is hw_413 (created today). The next calls would be hw_414, _415...
  // BUT: if Sabeeda got a new phone and its CallLog._ID starts from 1 again (or low numbers),
  // those calls would have hw_IDs like _1, _2, _3... which COLLIDE with old rows.
  
  // Let's check what the smallest hw numbers look like:
  const smallHwRows = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call' },
    select: { hardwareId: true, date: true, updatedAt: true, createdAt: true, callStatus: true },
    orderBy: [{ hardwareId: 'asc' }], // string sort, so _1, _10, _100, _2...
  });
  
  // Filter numerically for small numbers
  const small = smallHwRows
    .map(r => ({ ...r, num: parseInt(r.hardwareId?.split('_').pop() ?? '0') }))
    .filter(r => r.num >= 1 && r.num <= 50)
    .sort((a, b) => a.num - b.num);
  
  console.log(`HW IDs 1-50 in DB:`);
  for (const r of small) {
    console.log(`  hw=${r.num} date=${r.date.toISOString().slice(0,16)} createdAt=${r.createdAt.toISOString().slice(0,10)} updatedAt=${r.updatedAt?.toISOString()?.slice(0,16)} ${r.callStatus}`);
  }
  
  // Check if any small-hw rows were UPDATED recently (today) — that would confirm new-phone collision
  const recentlyUpdatedSmall = small.filter(r => {
    const updated = r.updatedAt ? new Date(r.updatedAt) : null;
    return updated && updated >= new Date('2026-10-29T00:00:00Z');
  });
  console.log(`\nSmall-hw rows updated today: ${recentlyUpdatedSmall.length}`);
  for (const r of recentlyUpdatedSmall) {
    console.log(`  hw=${r.num} date=${r.date.toISOString().slice(0,16)} updatedAt=${r.updatedAt?.toISOString()?.slice(0,16)}`);
  }
  
  // Check the updatedAt for ALL rows updated today  
  const allUpdatedToday = await prisma.interaction.findMany({
    where: {
      createdById: userId,
      type: 'call',
      updatedAt: { gte: new Date('2026-10-29T00:00:00Z') }
    },
    select: { hardwareId: true, date: true, createdAt: true, updatedAt: true, callStatus: true, duration: true, phoneNumber: true },
    orderBy: { updatedAt: 'desc' },
    take: 60,
  });
  console.log(`\nAll call rows updated today: ${allUpdatedToday.length}`);
  const grouped = new Map<string, number>();
  for (const r of allUpdatedToday) {
    const num = parseInt(r.hardwareId?.split('_').pop() ?? '0');
    const dateStr = r.date.toISOString().slice(0,10);
    grouped.set(dateStr, (grouped.get(dateStr) ?? 0) + 1);
  }
  for (const [date, count] of [...grouped.entries()].sort()) {
    console.log(`  rows with date=${date}: ${count}`);
  }
  
  // Show the 10 most recently updated
  console.log('\nTop 10 most recently updated rows:');
  for (const r of allUpdatedToday.slice(0, 10)) {
    const num = parseInt(r.hardwareId?.split('_').pop() ?? '0');
    console.log(`  hw=${num} date=${r.date.toISOString().slice(0,16)} updatedAt=${r.updatedAt?.toISOString()?.slice(0,16)} ${r.callStatus} ${r.duration}min phone=${r.phoneNumber}`);
  }
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
