import { ContactLinkService } from './contactLinkService';
import prisma from '../config/prisma';
import { DistributionService } from './distributionService';
import { NotificationService } from './notificationService';
import { GeoLocationService } from './geoLocationService';
import { logger } from '../utils/logger';

/**
 * Zapier Webhook Service
 * Processes incoming lead data from Zapier (e.g. Facebook Lead Ads via Zapier)
 * 
 * The webhook URL format: /api/public/zapier/webhook/:orgId
 * Authentication: via apiKey query param matching org's zapier integration apiKey
 */
export const ZapierWebhookService = {

    /**
     * Validate the incoming webhook request against the org's Zapier API key
     */
    async validateRequest(orgId: string, apiKey: string): Promise<{ valid: boolean; org?: any }> {
        try {
            const org = await prisma.organisation.findFirst({
                where: { id: orgId, isDeleted: false }
            });

            if (!org) {
                return { valid: false };
            }

            const integrations = (org.integrations as any) || {};
            const zapierConfig = integrations.zapier;

            if (!zapierConfig?.connected || !zapierConfig?.apiKey) {
                return { valid: false };
            }

            if (zapierConfig.apiKey !== apiKey) {
                return { valid: false };
            }

            return { valid: true, org };
        } catch (error) {
            logger.error('Zapier webhook validation error', error, 'ZapierWebhook');
            return { valid: false };
        }
    },

    /**
     * Process an incoming lead payload from Zapier
     * Zapier sends a flat JSON object with field names from the Facebook Lead Ad form
     */
    async processLead(org: any, payload: any): Promise<{ success: boolean; leadId?: string; isReEnquiry?: boolean }> {
        try {
            logger.webhook('Zapier', 'process_lead', undefined, { orgId: org.id, payload });

            // Flexible field mapping: support common Facebook Lead Ads field names
            const getField = (keys: string[]) => {
                for (const key of keys) {
                    // Check exact match first
                    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') return payload[key];
                    // Check case-insensitive
                    const lower = key.toLowerCase();
                    for (const [k, v] of Object.entries(payload)) {
                        if (k.toLowerCase() === lower && v !== undefined && v !== null && v !== '') return v;
                    }
                }
                return null;
            };

            // Build full name fallback
            const fullName = getField(['full_name', 'fullname', 'name', 'full name']) || '';
            const nameParts = fullName.trim().split(/\s+/);

            const firstName = getField(['first_name', 'firstname', 'first name', 'fname']) || nameParts[0] || 'Zapier';
            const lastName = getField(['last_name', 'lastname', 'last name', 'lname']) || nameParts.slice(1).join(' ') || 'Lead';
            const email = getField(['email', 'email_address', 'e-mail', 'e_mail']);
            const rawPhone = getField(['phone_number', 'phone', 'mobile_number', 'mobile_phone', 'contact_number', 'mobile', 'tel']);
            const company = getField(['company_name', 'company', 'organization', 'organisation', 'business']);
            const jobTitle = getField(['job_title', 'position', 'designation', 'role', 'title']);
            const country = getField(['country', 'location', 'region']);
            const city = getField(['city', 'town']);
            const source = getField(['source', 'lead_source', 'lead source', 'utm_source']);
            const campaignName = getField(['campaign_name', 'campaignname', 'campaign', 'utm_campaign', 'ad_name', 'form_name']);

            // Geo detection from phone
            let geoData = null;
            if (rawPhone) {
                geoData = GeoLocationService.detectCountryFromPhone(rawPhone.toString());
            }

            // Sanitize phone
            let cleanPhone = rawPhone ? rawPhone.toString().replace(/\D/g, '') : '';

            // Resolve status
            const integrations = (org.integrations as any) || {};
            let leadStatus = getField(['status', 'lead_status']) || 'new';
            if (leadStatus === 'new' && org.leadStatuses && Array.isArray(org.leadStatuses)) {
                const statuses = org.leadStatuses as any[];
                const configuredDefault = statuses.find((s) => s.isDefault);
                if (configuredDefault) {
                    leadStatus = configuredDefault.id;
                }
            }

            // Determine branch from Zapier config
            const zapierConfig = integrations.zapier || {};

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
                source: source || 'zapier',
                sourceDetails: {
                    zapier: true,
                    campaignName: campaignName || undefined,
                    rawPayload: payload,
                    receivedAt: new Date().toISOString()
                },
                status: leadStatus,
                organisationId: org.id,
                branchId: zapierConfig.branchId || null
            };

            if (await ContactLinkService.isBlocked(org.id, crmData.phone)) {
                console.log('[ZapierWebhook] Number is blocked - lead dropped.');
                return { success: true, blocked: true } as any;
            }

            // Check for duplicates
            const { DuplicateLeadService } = await import('./duplicateLeadService');
            const duplicateCheck = await DuplicateLeadService.checkDuplicate(crmData.phone, crmData.email, org.id);

            if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
                console.log(`[ZapierWebhook] Duplicate lead detected (${duplicateCheck.existingLead.id}). Handling as re-enquiry.`);
                await DuplicateLeadService.handleReEnquiry(
                    duplicateCheck.existingLead,
                    {
                        firstName: crmData.firstName,
                        lastName: crmData.lastName,
                        email: crmData.email,
                        phone: crmData.phone,
                        company: crmData.company,
                        source: 'zapier',
                        sourceDetails: crmData.sourceDetails
                    },
                    org.id
                );
                return { success: true, leadId: duplicateCheck.existingLead.id, isReEnquiry: true };
            }

            // Create the lead
            const lead = await prisma.lead.create({
                data: crmData
            });

            console.log(`[ZapierWebhook] Created lead ${lead.id} from Zapier for org ${org.id}`);

            // Trigger distribution
            try {
                await DistributionService.assignLead(lead, org.id);
            } catch (distErr) {
                console.warn('[ZapierWebhook] Distribution failed:', distErr);
            }

            // AI Scoring
            try {
                const { LeadScoringService } = await import('./leadScoringService');
                LeadScoringService.scoreLead(lead.id).catch(console.error);
            } catch (scoreErr) {
                console.warn('[ZapierWebhook] Scoring failed:', scoreErr);
            }

            // Notify admins
            try {
                const admins = await prisma.user.findMany({
                    where: {
                        organisationId: org.id,
                        role: { in: ['admin', 'super_admin'] },
                        isActive: true
                    },
                    select: { id: true }
                });

                for (const admin of admins) {
                    await NotificationService.send(
                        admin.id,
                        'New Zapier Lead',
                        `New lead via Zapier: ${firstName} ${lastName}`,
                        'info'
                    );
                }
            } catch (notifyErr) {
                console.warn('[ZapierWebhook] Notification failed:', notifyErr);
            }

            return { success: true, leadId: lead.id };

        } catch (error: any) {
            console.error('[ZapierWebhook] Error processing lead:', error.message);
            logger.error('Zapier lead processing error', error, 'ZapierWebhook', undefined, org.id);
            throw error;
        }
    }
};

export default ZapierWebhookService;
