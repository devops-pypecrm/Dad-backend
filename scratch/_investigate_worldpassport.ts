import { PrismaClient } from '../src/generated/client';

const prisma = new PrismaClient();
const ORG = 'ac7ea51b-55f1-45dc-8c4d-4ba40fb9ab8e';

async function main() {
  const users = await prisma.user.findMany({
    where: {
      organisationId: ORG,
      OR: [
        { firstName: { contains: 'shekh', mode: 'insensitive' } },
        { lastName: { contains: 'shekh', mode: 'insensitive' } },
        { firstName: { contains: 'shilp', mode: 'insensitive' } },
        { lastName: { contains: 'shilp', mode: 'insensitive' } },
      ],
    },
    select: { id: true, firstName: true, lastName: true, email: true, role: true },
  });
  console.log('=== USERS ===');
  console.log(JSON.stringify(users, null, 2));

  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const jobs = await prisma.importJob.findMany({
    where: { organisationId: ORG, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('=== IMPORT JOBS (last 6h) ===');
  console.log(JSON.stringify(jobs, null, 2));

  const leads = await prisma.lead.findMany({
    where: {
      organisationId: ORG,
      lastEnquiryDate: { gte: since },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      reEnquiryCount: true,
      isReEnquiry: true,
      lastEnquiryDate: true,
      assignedToId: true,
      previousOwnerId: true,
      sourceDetails: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { lastEnquiryDate: 'desc' },
  });
  console.log('=== LEADS (lastEnquiryDate in last 6h) ===');
  console.log(JSON.stringify(leads, null, 2));

  if (leads.length) {
    const histories = await prisma.leadHistory.findMany({
      where: { leadId: { in: leads.map((l) => l.id) } },
      orderBy: { createdAt: 'desc' },
    });
    console.log('=== LEAD HISTORY ===');
    console.log(JSON.stringify(histories, null, 2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
