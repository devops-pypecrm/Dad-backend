import { Request, Response } from 'express';
import { metaService } from '../services/metaService';
import { MetaIntegrationService } from '../services/metaIntegrationService';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';

// Type extension for Request to include user (handled by authMiddleware usually, but explicit here for safety)
interface AuthRequest extends Request {
    user?: {
        id: string;
        organisationId: string;
    };
}

import { decrypt } from '../utils/encryption';
import { resolveMetaTokenForAdAccount } from '../utils/metaAccountResolver';

// `adAccountId`, when given, resolves the token from whichever connected Meta Page
// actually has access to that specific ad account — an org can have several connected
// Pages, each scoped to a different set of ad accounts, so always using the single
// legacy integrations.meta token fails for every ad account except the one belonging
// to whichever Page was connected/reconnected most recently.
export const getMetaConfig = async (req: AuthRequest, adAccountId?: string) => {
    if (!req.user?.organisationId) {
        throw new Error('User not authenticated or missing organisation');
    }

    const org = await prisma.organisation.findUnique({
        where: { id: req.user.organisationId }
    });

    if (!org) throw new Error('Organisation not found');

    const integrations = org.integrations as any;
    const metaConfig = integrations?.meta;

    if (adAccountId) {
        const resolvedToken = await resolveMetaTokenForAdAccount(req.user.organisationId, adAccountId);
        if (resolvedToken) {
            return { ...metaConfig, accessToken: resolvedToken, adAccountId };
        }
    }

    // Ads/Insights Graph API calls (campaigns, insights, ad creation) require a
    // User (or System User) access token with ads_read/ads_management — a Page
    // token cannot query ad-account-level endpoints like /act_.../insights and
    // Facebook will reject it. Prefer userAccessToken, falling back to the page
    // token only if no user token is stored.
    const tokenToUse = metaConfig?.userAccessToken || metaConfig?.accessToken;

    if (!tokenToUse) {
        throw new Error('Meta integration not configured. Please connect your Facebook account in Settings → Integrations.');
    }

    // Decrypt the token before using it
    return {
        ...metaConfig,
        accessToken: decrypt(tokenToUse)
    };
};

export const getCampaigns = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req);
        const campaigns = await metaService.getCampaigns(config);
        res.json(campaigns);
    } catch (error: any) {
        console.error('Error in getCampaigns:', error);
        // Return empty array instead of 500 error
        res.status(200).json({
            message: error.message || 'Unable to fetch campaigns',
            campaigns: [],
            error: true
        });
    }
};

// Powers the Leads list's campaign filter (shown once the Source filter is set
// to Meta Ads). Lead has no campaign FK - only `sourceDetails` Json (see
// analyticsController.ts's getLeadCampaigns, which does the same distinct-
// name scan) - so this just lists every campaign that has actually produced
// a lead for this org, straight from that data.
//
// Deliberately does NOT cross-reference Meta's live API for "is this
// campaign currently ACTIVE": that was tried before and caused this filter
// to go empty for any org running more than one connected ad account (the
// live lookup only ever checked one of them, so it never matched the
// campaigns that had actually produced leads on the others) - and even with
// that fixed, a lead-gen campaign is routinely paused once its run ends, so
// gating on "still active today" would hide most of the campaigns a rep
// actually wants to filter by.
export const getActiveLeadCampaigns = async (req: AuthRequest, res: Response) => {
    try {
        const orgId = req.user?.organisationId;
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const leads = await prisma.lead.findMany({
            where: {
                organisationId: orgId,
                isDeleted: false,
                source: 'meta_leadgen' as any,
                sourceDetails: { not: null as any }
            },
            select: { sourceDetails: true },
            take: 2000,
            orderBy: { createdAt: 'desc' }
        });

        const seenByCampaignId = new Map<string, string>();
        leads.forEach(l => {
            const details = l.sourceDetails as any;
            const campaignId = details?.campaignId;
            if (typeof campaignId === 'string' && campaignId.trim()) {
                seenByCampaignId.set(campaignId, details?.campaignName || campaignId);
            }
        });

        res.json(
            Array.from(seenByCampaignId.entries())
                .map(([id, name]) => ({ id, name }))
                .sort((a, b) => a.name.localeCompare(b.name))
        );
    } catch (error: any) {
        console.error('Error in getActiveLeadCampaigns:', error);
        res.status(500).json({ message: error.message || 'Unable to fetch active campaigns' });
    }
};

export const getAdSets = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req);
        const { campaignId } = req.query;
        const adSets = await metaService.getAdSets(config, campaignId as string);
        res.json(adSets);
    } catch (error: any) {
        console.error('Error in getAdSets:', error);
        res.status(200).json({
            message: error.message || 'Unable to fetch ad sets',
            adSets: [],
            error: true
        });
    }
};

export const getAds = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req);
        const { adSetId } = req.query;
        const ads = await metaService.getAds(config, adSetId as string);
        res.json(ads);
    } catch (error: any) {
        console.error('Error in getAds:', error);
        res.status(200).json({
            message: error.message || 'Unable to fetch ads',
            ads: [],
            error: true
        });
    }
};

export const getInsights = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req, req.query.accountId as string | undefined);
        if (req.query.accountId) {
            config.adAccountId = req.query.accountId as string;
        }
        const { level, startDate, endDate } = req.query;
        const dateRange = startDate && endDate ? { since: startDate as string, until: endDate as string } : undefined;
        const insights = await metaService.getInsights(config, level as any, dateRange);
        res.json(insights);
    } catch (error: any) {
        console.error('Error in getInsights:', error);
        res.status(200).json({
            message: error.message || 'Unable to fetch insights',
            insights: [],
            error: true
        });
    }
};

export const testConnection = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req);
        const result = await metaService.testConnection(config);
        res.json(result);
    } catch (error: any) {
        console.error('Error in testConnection:', error);
        res.status(200).json({
            success: false,
            message: error.message || 'Unable to test connection',
            error: true
        });
    }
};

export const syncCampaigns = async (req: AuthRequest, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const campaigns = await MetaIntegrationService.syncCampaigns(orgId);
        res.json({
            message: `Successfully synced ${campaigns.length} campaigns`,
            campaigns
        });
    } catch (error: any) {
        console.error('Error in syncCampaigns:', error);
        res.status(200).json({
            message: error.message || 'Unable to sync campaigns',
            campaigns: [],
            error: true
        });
    }
};

export const getCampaignInsights = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req, req.query.accountId as string | undefined);
        if (req.query.accountId) {
            config.adAccountId = req.query.accountId as string;
        }
        const insights = await metaService.getInsights(config, 'campaign');
        res.json(insights);
    } catch (error: any) {
        console.error('Error in getCampaignInsights:', error);
        res.status(200).json({
            message: error.message || 'Unable to fetch campaign insights',
            insights: [],
            error: true
        });
    }
};

export const getAccountInsights = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req, req.query.accountId as string | undefined);
        if (req.query.accountId) {
            config.adAccountId = req.query.accountId as string;
        }
        const { startDate, endDate } = req.query;
        const dateRange = startDate && endDate ? { since: startDate as string, until: endDate as string } : undefined;
        const insights = await metaService.getInsights(config, 'account', dateRange);
        res.json(insights);
    } catch (error: any) {
        console.error('Error in getAccountInsights:', error);
        res.status(200).json({
            message: error.message || 'Unable to fetch account insights',
            insights: [],
            error: true
        });
    }
};

export const createFullAd = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req);
        const { campaign, adSet, creative, ad } = req.body;

        console.log('[createFullAd] Payload received:', JSON.stringify({ campaign, adSet: { ...adSet, targeting: '...' }, creative: { ...creative, imageUrl: creative?.imageUrl ? '...' : undefined }, ad }, null, 2));

        // 1. Create Campaign
        console.log('[createFullAd] Step 1: Creating campaign...');
        const campaignResult = await metaService.createCampaign(config, campaign);
        const campaignId = campaignResult.id;
        console.log('[createFullAd] Campaign created:', campaignId);

        // 2. Create Ad Set
        console.log('[createFullAd] Step 2: Creating ad set with daily_budget:', adSet.dailyBudget);
        const adSetResult = await metaService.createAdSet(config, {
            ...adSet,
            campaignId
        });
        const adSetId = adSetResult.id;
        console.log('[createFullAd] Ad Set created:', adSetId);

        // 3. Create Creative
        console.log('[createFullAd] Step 3: Creating creative... pageId from config:', config.pageId, 'from body:', creative?.pageId);
        let imageHash = creative.imageHash;
        if (creative.imageUrl && !imageHash) {
            const uploadResult = await metaService.uploadImage(config, creative.imageUrl);
            imageHash = uploadResult.images[Object.keys(uploadResult.images)[0]].hash;
        }

        const creativeResult = await metaService.createAdCreative(config, {
            ...creative,
            pageId: creative.pageId || config.pageId, // Use org's stored pageId as fallback
            imageHash
        });
        const creativeId = creativeResult.id;
        console.log('[createFullAd] Creative created:', creativeId);

        // 4. Create Ad
        console.log('[createFullAd] Step 4: Creating ad...');
        const adResult = await metaService.createAd(config, {
            ...ad,
            adSetId,
            creativeId
        });

        res.status(201).json({
            success: true,
            campaignId,
            adSetId,
            creativeId,
            adId: adResult.id
        });
    } catch (error: any) {
        console.error('Error in createFullAd:', error?.response?.data || error.message || error);
        // Return Meta's actual error message for better user feedback
        const metaError = error?.response?.data?.error;
        const userMessage = metaError?.error_user_msg || metaError?.message || error.message || 'Failed to create ad';
        res.status(500).json({ message: userMessage });
    }
};

export const uploadAdImage = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getMetaConfig(req);
        const { imageUrl } = req.body;

        if (!imageUrl) {
            return res.status(400).json({ message: 'imageUrl is required' });
        }

        const result = await metaService.uploadImage(config, imageUrl);
        res.json(result);
    } catch (error: any) {
        console.error('Error in uploadAdImage:', error);
        res.status(500).json({ message: error.message });
    }
};

export const sendConversionEvent = async (req: AuthRequest, res: Response) => {
    try {
        const { data } = req.body;
        const organisationId = req.user?.organisationId;

        if (!organisationId) {
            return res.status(401).json({ message: 'Organisation not identified' });
        }

        if (!data || !Array.isArray(data)) {
            return res.status(400).json({ message: 'Payload must contain a "data" array of events' });
        }

        const { MetaConversionService } = await import('../services/metaConversionService');
        
        // Map the Meta-style payload to our service structure
        const events = data.map((evt: any) => ({
            eventName: evt.event_name,
            eventTime: evt.event_time,
            actionSource: evt.action_source,
            userData: {
                email: evt.user_data?.em?.[0], // Handle both array and single string
                phone: evt.user_data?.ph?.[0],
                leadId: evt.user_data?.lead_id,
                externalId: evt.user_data?.external_id?.[0],
                clientUserAgent: evt.user_data?.client_user_agent,
                clientIp: evt.user_data?.client_ip_address,
            },
            customData: evt.custom_data,
            eventSourceUrl: evt.event_source_url
        }));

        await MetaConversionService.sendEvent(organisationId, events);

        res.json({ success: true, message: `${events.length} conversion event(s) sent to Meta` });
    } catch (error: any) {
        console.error('Error in sendConversionEvent:', error);
        res.status(500).json({ message: error.message });
    }
};
