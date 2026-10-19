// Instagram API with Instagram Login (business accounts). Configured per platform, not per organisation.
export const IG_GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v21.0';
export const IG_GRAPH = `https://graph.instagram.com/${IG_GRAPH_VERSION}`;
export const IG_OAUTH_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
export const IG_OAUTH_TOKEN = 'https://api.instagram.com/oauth/access_token';

// Least privilege: only what the module uses (basic profile + DMs + comment replies).
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];

// Instagram's messaging window: free-form replies are allowed for 24h after the person's last message.
export const IG_WINDOW_MS = 24 * 60 * 60 * 1000;

export const instagramConfig = () => ({
    appId: process.env.INSTAGRAM_APP_ID || '',
    appSecret: process.env.INSTAGRAM_APP_SECRET || '',
    verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN || '',
    redirectUri: process.env.INSTAGRAM_REDIRECT_URI || `${process.env.SERVER_URL || ''}/api/instagram/callback`,
    clientUrl: process.env.CLIENT_URL || 'http://localhost:5173'
});

export const isInstagramConfigured = () => {
    const c = instagramConfig();
    return !!(c.appId && c.appSecret && c.verifyToken);
};
