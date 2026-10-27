import { PrismaClient } from '../src/generated/client';

const prisma = new PrismaClient();

async function main() {
  const emails = ['luthfistudymiles@gmail.com', 'hibastudymiles@gmail.com'];
  const phones = ['7658995449', '8547951868'];

  console.log("=== Checking Users ===");
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, role: true, teamId: true, branchId: true, organisationId: true }
  });
  console.dir(users, { depth: null });

  console.log("\n=== Checking Leads ===");
  const leads = await prisma.lead.findMany({
    where: { phone: { in: phones } },
    select: { 
      id: true, 
      firstName: true, 
      phone: true, 
      assignedToId: true, 
      createdById: true, 
      teamId: true, 
      branchId: true, 
      organisationId: true,
      isDeleted: true,
      status: true,
      isReEnquiry: true,
      originalLeadId: true,
      createdAt: true,
      assignedTo: { select: { email: true, firstName: true } },
      createdBy: { select: { email: true, firstName: true } }
    }
  });
  console.dir(leads, { depth: null });
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
