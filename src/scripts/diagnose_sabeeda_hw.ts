import prisma from '../config/prisma';

async function main() {
  const userId = '82ed6b76-8eb5-446f-9424-6418e91f7649';

  // Latest hardware ID is _413 but helper logs show 80+ calls today
  // The reconciler sends calls found in Android CallLog — if the phone's CallLog 
  // is returning calls from before today (e.g. from past days), they'd sync correctly
  // but land on those old dates, not today.
  
  // Look at ALL interaction rows created in last 3 hours with their actual dates
  const recent = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', createdAt: { gte: new Date(Date.now() - 3 * 60 * 60 * 1000) } },
    select: { hardwareId: true, date: true, createdAt: true, callStatus: true, duration: true },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`Rows created in last 3h: ${recent.length}`);
  for (const r of recent) {
    console.log(`  hw=${r.hardwareId} date=${r.date.toISOString()} createdAt=${r.createdAt.toISOString()} status=${r.callStatus} dur=${r.duration}`);
  }

  // Check what date range the last big sync batch covered
  // BULK_SYNC_SUCCESS 45 calls at 11:13 IST but hw is only at _413
  // That means those 45 were all UPDATES to existing rows (not new)
  
  // Let's look at the hw id range — _413 is the max. If there were truly 100+ new calls today,
  // we'd expect hw in the _414-_513 range.
  const hwCheck = await prisma.interaction.findMany({
    where: { createdById: userId, type: 'call', hardwareId: { gte: '82ed6b76-8eb5-446f-9424-6418e91f7649_400' } },
    select: { hardwareId: true, date: true, createdAt: true },
    orderBy: { hardwareId: 'asc' },
  });
  console.log(`\nAll rows with hw >= _400: ${hwCheck.length}`);
  for (const r of hwCheck) console.log(`  hw=${r.hardwareId} date=${r.date.toISOString()} createdAt=${r.createdAt.toISOString()}`);

  // The real question: what does the bulk-sync endpoint count as "synced"?
  // Read androidController's bulkSync response to see if `results.synced` = new+updated or just new
  console.log('\nNow checking what "synced" means in bulk-sync response...');
  
  // Read the call_log_reconciler on Android side to see what it sends
  // On the server side — find what results object is returned
  // Let's grep the controller for the response shape
}

main().catch(e => console.error(e)).finally(() => process.exit(0));
