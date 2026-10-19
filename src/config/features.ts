/**
 * Platform features that the Super Admin enables per organisation
 * (Super Admin > Feature Settings). To add a feature, add an entry here and gate its
 * routes with `requireFeature(key)`; the Super Admin screen picks it up automatically.
 */
export interface PlatformFeature {
    key: string;
    label: string;
    description: string;
}

export const PLATFORM_FEATURES: PlatformFeature[] = [
    {
        key: 'whatsapp',
        label: 'WhatsApp Business',
        description: 'Team Inbox, templates, campaigns, chatbots & AI agent, auto responder, lead nurturing and the WhatsApp connection. When off, the organisation sees none of it, nothing is sent or received, and queued automations are stopped.'
    },
    {
        key: 'instagram',
        label: 'Instagram',
        description: 'Shared inbox for Instagram DMs, keyword chatbots with a drag-and-drop workflow builder, and Ask-to-Follow comment bots, plus the Instagram connection. When off, the organisation sees none of it and nothing is sent or received.'
    }
];

export const FEATURE_KEYS = PLATFORM_FEATURES.map(f => f.key);
export const isKnownFeature = (key: string) => FEATURE_KEYS.includes(key);
