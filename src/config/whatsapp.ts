// Single place for the Cloud API version so it can be bumped without code changes.
export const WHATSAPP_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
export const WHATSAPP_GRAPH_URL = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`;

// Meta's customer-service window: free-form messages are only allowed for 24h
// after the customer's last inbound message.
export const WINDOW_MS = 24 * 60 * 60 * 1000;

// Words a customer can send to stop business-initiated messages (and to resume).
export const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'opt out', 'optout', 'stop all'];
export const OPT_IN_KEYWORDS = ['start', 'subscribe', 'unstop', 'resume'];

// Daily unique-recipient limits per Meta messaging tier (business-initiated conversations).
export const TIER_LIMITS: Record<string, number> = {
    TIER_50: 50,
    TIER_250: 250,
    TIER_1K: 1000,
    TIER_2K: 2000,
    TIER_10K: 10000,
    TIER_100K: 100000,
    TIER_UNLIMITED: Number.MAX_SAFE_INTEGER
};
