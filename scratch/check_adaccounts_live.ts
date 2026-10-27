import { PrismaClient } from '../src/generated/client';
import { decrypt } from '../src/utils/encryption';
import axios from 'axios';

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organisation.findUnique({
    where: { id: 'ac7ea51b-55f1-45dc-8c4d-4ba40fb9ab8e' },
    select: { integrations: true }
  });
  const integrations: any = org?.integrations || {};
  const acc = integrations.metaAccounts.find((a: any) => a.pageId === '1207896069067700');
  const token = decrypt(acc.userAccessToken || acc.accessToken);

  let url = 'https://graph.facebook.com/v18.0/me/adaccounts';
  let params: any = { access_token: token, fields: 'id,name,account_id,account_status', limit: 25 };
  let page = 1;
  let all: any[] = [];
  while (url) {
    const res = await axios.get(url, { params });
    all.push(...res.data.data);
    console.log(`Page ${page}: ${res.data.data.length} accounts`, res.data.data.map((a: any) => a.id));
    const next = res.data.paging?.next;
    if (next) {
      url = next;
      params = undefined;
      page++;
    } else {
      url = '';
    }
  }
  console.log('\nTotal:', all.length);
  console.log('Contains act_1368355495259832:', all.some(a => a.id === 'act_1368355495259832'));

  // Also try business-scoped lookup
  console.log('\n=== /me/businesses ===');
  try {
    const bres = await axios.get('https://graph.facebook.com/v18.0/me/businesses', { params: { access_token: token, fields: 'id,name' } });
    console.log(JSON.stringify(bres.data.data, null, 2));
    for (const biz of bres.data.data || []) {
      for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
        try {
          const er = await axios.get(`https://graph.facebook.com/v18.0/${biz.id}/${edge}`, { params: { access_token: token, fields: 'id,name,account_id' } });
          console.log(`${biz.name} / ${edge}:`, er.data.data.map((a: any) => a.id));
        } catch (e: any) {
          console.log(`${biz.name} / ${edge}: error`, e.response?.data?.error?.message);
        }
      }
    }
  } catch (e: any) {
    console.log('businesses lookup failed:', e.response?.data?.error?.message);
  }
}

main().catch(e => console.error(e.response?.data || e)).finally(() => prisma.$disconnect());
