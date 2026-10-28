import { ContactLinkService } from './contactLinkService';
import prisma from '../config/prisma';
import { DistributionService } from './distributionService';
import { NotificationService } from './notificationService';
import { GeoLocationService } from './geoLocationService';

/**
 * Meta Payload Service
 * Handles direct lead data payloads from Meta Ads (via 3rd party tools or custom webhooks)
 */
export const MetaPayloadService = {

    /**
     * Validate the incoming webhook request
     */
    async validateRequest(orgId: string, apiKey: string): Promise<{ valid: boolean; org?: any }> {
        try {
            const org = await prisma.organisation.findFirst({
                where: { id: orgId, isDeleted: false }
            });

            if (!org) return { valid: false };

            const integrations = (org.integrations as any) || {};
            const config = integrations.facebook_payload;

            if (!config?.connected || !config?.apiKey) return { valid: false };
            if (config.apiKey !== apiKey) return { valid: false };

            return { valid: true, org };
        } catch (error) {
            console.error('[MetaPayload] Validation error:', error);
            return { valid: false };
        }
    },

    /**
     * Process an incoming lead payload
     */
    async processLead(org: any, payload: any): Promise<{ success: boolean; leadId?: string; isReEnquiry?: boolean }> {
        try {
            // Flexible field mapping
            const getField = (keys: string[]) => {
                for (const key of keys) {
                    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') return payload[key];
                    const lower = key.toLowerCase();
                    for (const [k, v] of Object.entries(payload)) {
                        if (k.toLowerCase() === lower && v !== undefined && v !== null && v !== '') return v;
                    }
                }
                return null;
            };

            const fullName = getField(['full_name', 'fullname', 'name', 'full name']) || '';
            const nameParts = fullName.trim().split(/\s+/);

            const firstName = getField(['first_name', 'firstname', 'first name', 'fname']) || nameParts[0] || 'Meta';
            const lastName = getField(['last_name', 'lastname', 'last name', 'lname']) || nameParts.slice(1).join(' ') || 'Payload';
            const email = getField(['email', 'email_address', 'e-mail', 'e_mail']);
            const rawPhone = getField(['phone_number', 'phone', 'mobile_number', 'mobile_phone', 'contact_number', 'mobile', 'tel']);
            const company = getField(['company_name', 'company', 'organization', 'organisation', 'business']);
            const jobTitle = getField(['job_title', 'position', 'designation', 'role', 'title']);
            const country = getField(['country', 'location', 'region']);
            const city = getField(['city', 'town']);
            const source = getField(['source', 'lead_source', 'lead source', 'utm_source']) || 'meta_leadgen';
            const campaignName = getField(['campaign_name', 'campaignname', 'campaign', 'utm_campaign']);
            const adName = getField(['ad_name', 'adname', 'ad', 'utm_content']);

            let geoData = null;
            if (rawPhone) {
                geoData = GeoLocationService.detectCountryFromPhone(rawPhone.toString());
            }

            const cleanPhone = rawPhone ? rawPhone.toString().replace(/\D/g, '') : '';
            const integrations = (org.integrations as any) || {};
            const config = integrations.facebook_payload || {};

            let leadStatus = getField(['status', 'lead_status']) || 'new';
            if (leadStatus === 'new' && org.leadStatuses && Array.isArray(org.leadStatuses)) {
                const statuses = org.leadStatuses as any[];
                const configuredDefault = statuses.find((s) => s.isDefault);
                if (configuredDefault) leadStatus = configuredDefault.id;
            }

            const crmData: any = {
                firstName,
                lastName,
                email: email || undefined,
                phone: cleanPhone,
                company: company || undefined,
                jobTitle: jobTitle || undefined,
                country: geoData?.country || country || undefined,
                countryCode: geoData?.countryCode || undefined,
                phoneCountryCode: geoData?.phoneCountryCode || undefined,
                city: city || undefined,
                source: source,
                sourceDetails: {
                    metaPayload: true,
                    campaignName: campaignName,
                    adName: adName,
                    rawPayload: payload,
                    receivedAt: new Date().toISOString()
                },
                status: leadStatus,
                organisationId: org.id,
                branchId: config.branchId || null
            };

            if (await ContactLinkService.isBlocked(org.id, crmData.phone)) {
                console.log('[MetaPayload] Number is blocked - lead dropped.');
                return { success: true, blocked: true } as any;
            }

            const { DuplicateLeadService } = await import('./duplicateLeadService');
            const duplicateCheck = await DuplicateLeadService.checkDuplicate(crmData.phone, crmData.email, org.id);

            if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
                await DuplicateLeadService.handleReEnquiry(
                    duplicateCheck.existingLead,
                    {
                        firstName: crmData.firstName,
                        lastName: crmData.lastName,
                        email: crmData.email,
                        phone: crmData.phone,
                        company: crmData.company,
                        source: source,
                        sourceDetails: crmData.sourceDetails
                    },
                    org.id
                );
                return { success: true, leadId: duplicateCheck.existingLead.id, isReEnquiry: true };
            }

            const lead = await prisma.lead.create({
                data: crmData
            });

            try {
                await DistributionService.assignLead(lead, org.id);
            } catch (distErr) {
                console.warn('[MetaPayload] Distribution failed:', distErr);
            }

            // AI Scoring (Async)
            try {
                const { LeadScoringService } = await import('./leadScoringService');
                LeadScoringService.scoreLead(lead.id).catch(console.error);
            } catch (scoreErr) {
                console.warn('[MetaPayload] Scoring failed:', scoreErr);
            }

            // Notifications
            try {
                const admins = await prisma.user.findMany({
                    where: { organisationId: org.id, role: { in: ['admin', 'super_admin'] }, isActive: true },
                    select: { id: true }
                });

                for (const admin of admins) {
                    await NotificationService.send(
                        admin.id,
                        'New Meta Ads Lead',
                        `Lead received: ${firstName} ${lastName}`,
                        'info'
                    );
                }
            } catch (notifyErr) {
                console.warn('[MetaPayload] Notification failed:', notifyErr);
            }

            return { success: true, leadId: lead.id };
        } catch (error: any) {
            console.error('[MetaPayload] Error processing lead:', error.message);
            throw error;
        }
    }
};

export default MetaPayloadService;
