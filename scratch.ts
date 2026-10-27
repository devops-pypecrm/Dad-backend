import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const orgs = await prisma.organisation.findMany({
    select: { id: true, name: true, integrations: true }
  });

  let found = false;
  for (const org of orgs) {
    const integrations = org.integrations as any;
    if (!integrations) continue;

    if (integrations.meta?.adAccountId === '1433990511904396') {
      console.log(`Found in Org: ${org.name} (${org.id}) - Legacy Meta Object`);
      console.log(`Ad Account Name: ${integrations.meta.adAccountName || 'Unknown'}`);
      console.log(`Page Name: ${integrations.meta.pageName || 'Unknown'}`);
      found = true;
    }

    if (Array.isArray(integrations.metaAccounts)) {
      for (const acc of integrations.metaAccounts) {
        if (acc.adAccountId === '1433990511904396' || acc.enabledLeadSyncAccounts?.includes('1433990511904396')) {
          console.log(`Found in Org: ${org.name} (${org.id}) - Meta Accounts Array`);
          console.log(`Ad Account Name: ${acc.adAccountName || 'Unknown'}`);
          console.log(`Page Name: ${acc.pageName || 'Unknown'}`);
          found = true;
        }
      }
    }
  }

  if (!found) {
    console.log("Ad account ID 1433990511904396 not found in the database.");
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
