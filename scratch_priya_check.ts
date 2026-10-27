import prisma from './src/config/prisma';

async function main() {
  const user = await prisma.user.findFirst({
    where: {
      firstName: { contains: 'priya', mode: 'insensitive' },
      organisation: { name: { contains: 'edufolio', mode: 'insensitive' } }
    },
    select: { id: true, firstName: true, lastName: true, email: true, organisationId: true, branchId: true }
  });
  console.log('User:', user);
  if (!user) return;

  const totalInteractions = await prisma.interaction.count({
    where: { createdById: user.id, organisationId: user.organisationId, isDeleted: false }
  });
  const callInteractions = await prisma.interaction.count({
    where: { createdById: user.id, organisationId: user.organisationId, isDeleted: false, type: 'call' }
  });
  console.log('Total interactions (createdById):', totalInteractions);
  console.log('Call-type interactions (createdById):', callInteractions);

  const sample = await prisma.interaction.findMany({
    where: { organisationId: user.organisationId, type: 'call', createdById: user.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, createdAt: true, date: true, direction: true, callStatus: true, subject: true, createdById: true }
  });
  console.log('Sample call interactions:', JSON.stringify(sample, null, 2));

  const recordings = await prisma.callRecording.count({
    where: { organisationId: user.organisationId, userId: user.id }
  }).catch((e: any) => `error: ${e.message}`);
  console.log('CallRecording count (userId):', recordings);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
