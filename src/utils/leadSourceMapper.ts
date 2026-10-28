/**
 * Maps the free-text "source" column of an imported file onto the `LeadSource`
 * enum. The DB rejects anything outside the enum, so a sheet containing
 * "FB Lead Ads" or "Privyr leads" used to fail every row. The original text is
 * returned so callers can keep it in `sourceDetails.originalSource`.
 */
const VALID = new Set([
    'website', 'referral', 'social', 'paid_ad', 'import', 'api', 'manual', 'whatsapp', 'meta_leadgen',
    'cold_call', 'social_media', 'email_campaign', 'meta_ads', 'google_ads', 'facebook_payload',
    'lead_squared', 'zapier', 'other'
]);

// Source cells that actually hold an ad campaign name / campaign id.
const CAMPAIGN_IN_SOURCE = /^(facebook[\s-].*|fb[\s_-]leads?[\s_-].*|\d{12,})$/i;

export interface MappedSource {
    source: string;
    originalSource?: string;
    campaignName?: string;
}

export function mapImportSource(raw: unknown): MappedSource {
    const original = (raw ?? '').toString().trim();
    if (!original) return { source: 'import' };

    const k = original.toLowerCase().replace(/\s+/g, '_');
    if (VALID.has(k)) return { source: k };

    const spaced = original.toLowerCase();
    // Facebook-sourced leads match what the Meta webhook stores.
    if (['fb lead ads', 'facebook / instagram', 'fb', 'ig', 'fb chat', 'facebook', 'instagram'].includes(spaced)) {
        return { source: 'meta_leadgen', originalSource: original };
    }
    if (CAMPAIGN_IN_SOURCE.test(original)) {
        return { source: 'meta_leadgen', originalSource: original, campaignName: original };
    }
    if (spaced.startsWith('whatsapp')) return { source: 'whatsapp', originalSource: original };
    if (spaced.startsWith('website') || ['contact form 7', 'google form'].includes(spaced)) {
        return { source: 'website', originalSource: original };
    }
    if (['reference', 'referral', 'referral sites'].includes(spaced)) return { source: 'referral', originalSource: original };
    if (['other scocial media', 'other social media', 'social media'].includes(spaced)) {
        return { source: 'social_media', originalSource: original };
    }
    if (['walkin', 'walk-in', 'walking customer'].includes(spaced)) return { source: 'manual', originalSource: original };
    return { source: 'other', originalSource: original };
}
