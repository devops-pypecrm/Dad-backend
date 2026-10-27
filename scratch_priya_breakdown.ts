import prisma from './src/config/prisma';

async function main() {
  const userId = '78b350ab-a756-4bb2-8bbd-0b511e205b63';
  const orgId = '85cc3715-7f8d-4f22-b0b0-a40a502bc6fa';
  const start = new Date('2026-10-15T00:00:00.000Z');
  const end = new Date('2026-10-15T23:59:59.999Z');

  const allCallsToday = await prisma.interaction.findMany({
    where: { createdById: userId, organisationId: orgId, type: 'call', date: { gte: start, lte: end } },
    select: { id: true, callStatus: true, direction: true, date: true, createdAt: true, hardwareId: true, callSessionId: true, isDeleted: true },
    orderBy: { date: 'asc' }
  });
  console.log('Total type=call interactions today (any status, any isDeleted):', allCallsToday.length);

  const byStatus: Record<string, number> = {};
  for (const c of allCallsToday) {
    byStatus[c.callStatus || 'null'] = (byStatus[c.callStatus || 'null'] || 0) + 1;
  }
  console.log('Breakdown by callStatus:', byStatus);

  const deletedCount = allCallsToday.filter(c => c.isDeleted).length;
  console.log('isDeleted=true count:', deletedCount);

  // Also check other interaction types that might represent calls (e.g. type != 'call' but subject mentions call)
  const nonCallButCallLike = await prisma.interaction.count({
    where: { createdById: userId, organisationId: orgId, date: { gte: start, lte: end }, NOT: { type: 'call' }, subject: { contains: 'Call', mode: 'insensitive' } }
  });
  console.log('Non-"call"-type but call-like subject today:', nonCallButCallLike);

  // Check for duplicate hardwareIds (healed/merged calls) to see if coalescing reduced count
  const withHw = allCallsToday.filter(c => c.hardwareId);
  const uniqueHw = new Set(withHw.map(c => c.hardwareId));
  console.log('Calls with hardwareId:', withHw.length, 'unique hardwareIds:', uniqueHw.size);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
