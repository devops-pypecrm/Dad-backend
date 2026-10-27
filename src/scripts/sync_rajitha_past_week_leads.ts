import axios from 'axios';
import prisma from '../config/prisma';
import { decrypt } from '../utils/encryption';
import { DistributionService } from '../services/distributionService';
import { DuplicateLeadService } from '../services/duplicateLeadService';
import { NotificationService } from '../services/notificationService';
import { LeadSource } from '../generated/client';

const TARGET_EMAIL = 'rajithaworldpassport@gmail.com';
const TARGET_AD_ACCOUNT = '1368355495259832'; // act_1368355495259832 (Worldpassport Skill Academy)
const SKILL_BRANCH_ID = '1611b3f8-833b-4edf-a70a-f511c37b3cad'; // Skill branch

async function main() {
    console.log('=====================================================');
    console.log(' Starting Meta Lead Backfill for Past 1 Week');
    console.log(` Target User: ${TARGET_EMAIL}`);
    console.log(` Target Ad Account: ${TARGET_AD_ACCOUNT}`);
    console.log('=====================================================\n');

    const user = await prisma.user.findFirst({
        where: { email: { equals: TARGET_EMAIL, mode: 'insensitive' } },
        include: { organisation: true }
    });

    if (!user || !user.organisationId) {
        console.error(`User with email ${TARGET_EMAIL} not found.`);
        return;
    }

    const org = user.organisation;
    if (!org) {
        console.error('Organisation not found for user.');
        return;
    }

    console.log(`Org: ${org.name} (${org.id})`);

    const integrations = (org.integrations as any) || {};
    const meta = integrations.meta;

    if (!meta || !meta.accessToken) {
        console.error('Meta integration / accessToken not found on organisation.');
        return;
    }

    const pageToken = decrypt(meta.accessToken);
    const userToken = meta.userAccessToken;
    const pageId = meta.pageId || '1207896069067700';

    // 1 week ago
    const oneWeekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sinceTimestamp = Math.floor(oneWeekAgoMs / 1000);
    console.log(`Fetching leads created since: ${new Date(oneWeekAgoMs).toISOString()} (timestamp: ${sinceTimestamp})\n`);

    // 1. Get all active forms for the page
    console.log(`Fetching forms for Page: ${pageId}...`);
    const formsRes = await axios.get(`https://graph.facebook.com/v18.0/${pageId}/leadgen_forms`, {
        params: {
            access_token: pageToken,
            fields: 'id,name,status,leads_count',
            limit: 100
        }
    });

    const forms = formsRes.data.data || [];
    console.log(`Found ${forms.length} forms on page.`);

    // 2. Fetch all leads across all forms within the 1-week window
    const allFetchedLeads: any[] = [];
    for (const form of forms) {
        try {
            let nextUrl: string | undefined = `https://graph.facebook.com/v18.0/${form.id}/leads?fields=id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id&filtering=[{"field":"time_created","operator":"GREATER_THAN","value":${sinceTimestamp}}]&limit=100&access_token=${pageToken}`;
            let formLeadCount = 0;

            while (nextUrl) {
                const res: { data: { data?: any[]; paging?: { next?: string } } } = await axios.get(nextUrl);
                const data = res.data.data || [];
                for (const l of data) {
                    l.form_name = form.name;
                    allFetchedLeads.push(l);
                    formLeadCount++;
                }
                nextUrl = res.data.paging?.next;
            }

            if (formLeadCount > 0) {
                console.log(`  Form "${form.name}" (${form.id}): ${formLeadCount} leads in past 7 days.`);
            }
        } catch (formErr: any) {
            console.error(`  Error fetching leads for form ${form.name} (${form.id}):`, formErr.response?.data?.error?.message || formErr.message);
        }
    }

    console.log(`\nTotal Meta leads fetched in past 7 days across forms: ${allFetchedLeads.length}`);

    // Sort chronologically (oldest to newest)
    allFetchedLeads.sort((a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime());

    // Cache of campaign -> ad_account_id to avoid repeated API calls
    const campaignAccountMap = new Map<string, string>();
    const getCampaignAdAccount = async (campaignId: string): Promise<string | null> => {
        if (!campaignId) return null;
        if (campaignAccountMap.has(campaignId)) return campaignAccountMap.get(campaignId)!;
        try {
            const cRes = await axios.get(`https://graph.facebook.com/v18.0/${campaignId}?fields=id,account_id`, {
                params: { access_token: userToken || pageToken }
            });
            const actId = String(cRes.data.account_id).replace('act_', '');
            campaignAccountMap.set(campaignId, actId);
            return actId;
        } catch {
            return null;
        }
    };

    let totalSkippedDb = 0;
    let totalSkippedDup = 0;
    let totalSkippedAccount = 0;
    let totalProcessed = 0;

    const processedList: any[] = [];
    const skippedDupList: any[] = [];

    console.log('\n--- Processing Leads ---');

    for (let i = 0; i < allFetchedLeads.length; i++) {
        const metaLead = allFetchedLeads[i];
        const leadgenId = metaLead.id;

        // Check Ad Account
        if (metaLead.campaign_id) {
            const accId = await getCampaignAdAccount(metaLead.campaign_id);
            if (accId && accId !== TARGET_AD_ACCOUNT) {
                console.log(`[${i + 1}/${allFetchedLeads.length}] Lead ${leadgenId} skipped — belongs to account ${accId}, not ${TARGET_AD_ACCOUNT}`);
                totalSkippedAccount++;
                continue;
            }
        }

        // Check if lead already exists by metaLeadgenId
        const existingInDb = await prisma.lead.findFirst({
            where: {
                organisationId: org.id,
                sourceDetails: { path: ['metaLeadgenId'], equals: leadgenId }
            }
        });

        if (existingInDb) {
            totalSkippedDb++;
            continue;
        }

        // Parse fields
        const fieldMap: Record<string, string> = {};
        const rawFormFields: { label: string; value: string }[] = [];
        (metaLead.field_data || []).forEach((field: any) => {
            if (field.values && field.values.length > 0) {
                fieldMap[field.name.toLowerCase()] = field.values[0];
                rawFormFields.push({ label: field.name, value: field.values[0] });
            }
        });

        const getField = (keys: string[]) => {
            for (const key of keys) {
                if (fieldMap[key]) return fieldMap[key];
            }
            return '';
        };

        const NAME_KEYS = ['full name', 'full_name', 'name', 'first_name', 'first name'];
        const PHONE_KEYS = ['phone', 'phone number', 'phone_number', 'mobile', 'mobile number'];
        const EMAIL_KEYS = ['email', 'email address', 'email_address'];
        const CITY_KEYS = ['city', 'location'];
        const COMPANY_KEYS = ['company', 'organization', 'company name'];
        const RECOGNIZED_KEYS = new Set([...NAME_KEYS, ...PHONE_KEYS, ...EMAIL_KEYS, ...CITY_KEYS, ...COMPANY_KEYS]);

        const fullName = getField(NAME_KEYS);
        const phone = getField(PHONE_KEYS);
        const email = getField(EMAIL_KEYS);
        const city = getField(CITY_KEYS);
        const company = getField(COMPANY_KEYS);
        const campaignName = metaLead.campaign_name || metaLead.ad_name || metaLead.form_name || 'Meta Lead';

        const unrecognizedFields = rawFormFields.filter((f) => !RECOGNIZED_KEYS.has(f.label.toLowerCase()));
        const unrecognizedSummary = unrecognizedFields.map((f) => `${f.label}: ${f.value}`).join('; ');

        // Check duplicate by phone/email
        // Per user request: DO NOT fetch as re-enquiry. If duplicate exists, skip it!
        const duplicateCheck = await DuplicateLeadService.checkDuplicate(
            phone,
            email,
            org.id,
            SKILL_BRANCH_ID
        );

        if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
            totalSkippedDup++;
            skippedDupList.push({
                leadgenId,
                name: fullName || 'Meta Lead',
                phone,
                email,
                matchedExistingId: duplicateCheck.existingLead.id,
                createdTime: metaLead.created_time
            });
            console.log(`[${i + 1}/${allFetchedLeads.length}] Lead ${leadgenId} (${fullName || phone}) skipped — duplicate exists in CRM (ID: ${duplicateCheck.existingLead.id}), skipping re-enquiry.`);
            continue;
        }

        // Prepare lead data for creation
        const crmData = {
            firstName: fullName || 'Meta Lead',
            lastName: '',
            phone: phone || '',
            email: email || undefined,
            company: company || undefined,
            enquiryAbout: [city, unrecognizedSummary].filter(Boolean).join(' | ') || undefined,
            organisationId: org.id,
            branchId: SKILL_BRANCH_ID,
            source: LeadSource.meta_leadgen,
            createdAt: new Date(metaLead.created_time), // Set creation date to original Meta submission time
            sourceDetails: {
                metaLeadgenId: leadgenId,
                metaFormId: metaLead.form_id,
                metaPageId: pageId,
                metaAdId: metaLead.ad_id,
                adName: metaLead.ad_name,
                campaignId: metaLead.campaign_id,
                campaignName: campaignName,
                metaCreatedTime: metaLead.created_time,
                adAccountId: TARGET_AD_ACCOUNT,
                formFields: rawFormFields,
                syncedVia: 'manual_backfill_past_week'
            }
        };

        try {
            const newLead = await prisma.lead.create({
                data: crmData
            });

            // Assign lead based on active assignment rules
            const assignedToId = await DistributionService.assignLead(newLead, org.id);

            // Fetch assigned user details for logging
            let assignedUserName = 'Unassigned';
            if (assignedToId) {
                const assignedUser = await prisma.user.findUnique({
                    where: { id: assignedToId },
                    select: { firstName: true, lastName: true, email: true }
                });
                if (assignedUser) {
                    assignedUserName = `${assignedUser.firstName || ''} ${assignedUser.lastName || ''} (${assignedUser.email})`.trim();
                }
            }

            totalProcessed++;
            processedList.push({
                leadId: newLead.id,
                leadgenId,
                name: crmData.firstName,
                phone: crmData.phone,
                campaign: campaignName,
                assignedTo: assignedUserName,
                createdTime: metaLead.created_time
            });

            console.log(`[${i + 1}/${allFetchedLeads.length}] SUCCESS: Lead ${newLead.id} created | ${crmData.firstName} | ${crmData.phone} | Campaign: "${campaignName}" -> Assigned to: ${assignedUserName}`);
        } catch (createErr: any) {
            console.error(`[${i + 1}/${allFetchedLeads.length}] ERROR creating lead ${leadgenId}:`, createErr.message);
        }
    }

    // Send admin notification
    if (totalProcessed > 0) {
        const admins = await prisma.user.findMany({
            where: { organisationId: org.id, role: { in: ['admin', 'super_admin'] }, isActive: true },
            select: { id: true }
        });
        for (const admin of admins) {
            await NotificationService.send(
                admin.id,
                'Meta Leads Synced',
                `Successfully synced and assigned ${totalProcessed} lost Meta leads from the past week.`,
                'info'
            );
        }
    }

    console.log('\n=====================================================');
    console.log(' SYNC SUMMARY');
    console.log('=====================================================');
    console.log(`Total Leads on Meta (past 7 days):    ${allFetchedLeads.length}`);
    console.log(`Skipped (Already in DB by Meta ID):    ${totalSkippedDb}`);
    console.log(`Skipped (Duplicate Phone/Email):       ${totalSkippedDup}`);
    console.log(`Skipped (Other Ad Accounts):           ${totalSkippedAccount}`);
    console.log(`Successfully Created & Assigned:       ${totalProcessed}`);
    console.log('=====================================================\n');

    if (totalProcessed > 0) {
        console.log('List of newly synced and assigned leads:');
        processedList.forEach((p, idx) => {
            console.log(`  ${idx + 1}. [${p.createdTime}] ${p.name} (${p.phone}) | Campaign: "${p.campaign}" -> Assigned: ${p.assignedTo}`);
        });
    }

    if (skippedDupList.length > 0) {
        console.log('\nList of duplicate leads skipped (not re-enquired):');
        skippedDupList.forEach((d, idx) => {
            console.log(`  ${idx + 1}. [${d.createdTime}] ${d.name} (${d.phone}) -> Matched existing lead: ${d.matchedExistingId}`);
        });
    }
}

main()
    .catch((err) => {
        console.error('Fatal execution error:', err);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
