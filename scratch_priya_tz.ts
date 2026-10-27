import prisma from './src/config/prisma';

async function main() {
  const userId = '78b350ab-a756-4bb2-8bbd-0b511e205b63';
  const orgId = '85cc3715-7f8d-4f22-b0b0-a40a502bc6fa';

  console.log('Server local timezone offset (min):', new Date().getTimezoneOffset());
  console.log('Server TZ env:', process.env.TZ);

  // Simulate frontend: today in IST as yyyy-MM-dd, then new Date(str).toISOString()
  const now = new Date();
  // crude IST "today" string the way toISTDateString() would produce (IST = UTC+5:30)
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const todayStr = istNow.toISOString().slice(0, 10); // yyyy-MM-dd
  console.log('Frontend-computed "today" (IST calendar date):', todayStr);

  // What frontend actually sends: new Date(startDate).toISOString() where startDate = todayStr
  const sentStart = new Date(todayStr).toISOString();
  const sentEnd = new Date(todayStr).toISOString();
  console.log('Sent to backend as startDate/endDate:', sentStart, sentEnd);

  // What backend does with it: new Date(str), then setHours(0,0,0,0) / setHours(23,59,59,999) IN SERVER LOCAL TIME
  const backendStart = new Date(sentStart);
  backendStart.setHours(0, 0, 0, 0);
  const backendEnd = new Date(sentEnd);
  backendEnd.setHours(23, 59, 59, 999);
  console.log('Backend-computed range (server-local interpretation):', backendStart.toISOString(), '->', backendEnd.toISOString());

  // The CORRECT IST day boundary for todayStr
  const correctStart = new Date(`${todayStr}T00:00:00.000+05:30`);
  const correctEnd = new Date(`${todayStr}T23:59:59.999+05:30`);
  console.log('Correct IST day boundary:', correctStart.toISOString(), '->', correctEnd.toISOString());

  const buggyCount = await prisma.interaction.count({
    where: {
      createdById: userId, organisationId: orgId, type: 'call', callStatus: { not: 'initiated' },
      date: { gte: backendStart, lte: backendEnd }
    }
  });
  const correctCount = await prisma.interaction.count({
    where: {
      createdById: userId, organisationId: orgId, type: 'call', callStatus: { not: 'initiated' },
      date: { gte: correctStart, lte: correctEnd }
    }
  });
  console.log('Count using BUGGY (server-local) boundary:', buggyCount);
  console.log('Count using CORRECT IST boundary:', correctCount);

  // Show the calls that fall in the gap (correct IST today, but excluded by buggy UTC range)
  const missed = await prisma.interaction.findMany({
    where: {
      createdById: userId, organisationId: orgId, type: 'call', callStatus: { not: 'initiated' },
      date: { gte: correctStart, lte: correctEnd },
      NOT: { date: { gte: backendStart, lte: backendEnd } }
    },
    select: { id: true, date: true, callStatus: true },
    orderBy: { date: 'asc' }
  });
  console.log('Calls missed by the buggy boundary:', missed.length);
  console.log(JSON.stringify(missed.slice(0, 10), null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
