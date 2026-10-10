import axios from 'axios';
import crypto from 'crypto';
import prisma from '../config/prisma';

interface WhatsAppConfig {
    accessToken: string;
    phoneNumberId: string;
    wabaId?: string; // WhatsApp Business Account ID, optional for sending but good for templates
    appId?: string;
    appSecret?: string;
}

import { decrypt } from '../utils/encryption';
import { WHATSAPP_GRAPH_URL } from '../config/whatsapp';

export class WhatsAppService {
    private baseUrl = WHATSAPP_GRAPH_URL;
    private config: WhatsAppConfig;

    constructor(config: WhatsAppConfig) {
        this.config = config;
    }

    /**
     * Verify WhatsApp Webhook signature
     */
    static verifySignature(payload: string, signature: string, appSecret: string): boolean {
        try {
            if (!signature || !appSecret) return false;

            // Signature is usually sha256=HEX_HASH
            const [algo, hash] = signature.split('=');
            if (algo !== 'sha256' || !hash) return false;

            const expectedHash = crypto
                .createHmac('sha256', appSecret)
                .update(payload)
                .digest('hex');

            return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
        } catch (error) {
            console.error('Signature verification error:', error);
            return false;
        }
    }

    /**
     * Get configured service for an organisation
     */
    static async getClientForOrg(orgId: string): Promise<WhatsAppService | null> {
        // Resolves the org's default connected number (relational account first, legacy JSON as fallback).
        const { resolveWhatsAppCredentials } = await import('./whatsAppCredentials');
        const cred = await resolveWhatsAppCredentials(orgId);
        if (!cred) return null;
        return new WhatsAppService({ accessToken: cred.accessToken, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId });
    }

    /**
     * Make a request to WhatsApp Cloud API with retry logic
     */
    async makeRequest(endpoint: string, accessToken: string, params: any = {}, retries: number = 3) {
        let lastError: any;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.get(`${this.baseUrl}/${endpoint}`, {
                    params: {
                        access_token: accessToken,
                        ...params
                    },
                    timeout: 30000 // 30 second timeout
                });
                return response.data;
            } catch (error: any) {
                lastError = error;
                console.error(`WhatsApp API Error (attempt ${attempt}/${retries}):`, error.response?.data || error.message);

                // Don't retry on client errors (4xx)
                if (error.response?.status >= 400 && error.response?.status < 500) {
                    break;
                }

                // Wait before retrying (exponential backoff)
                if (attempt < retries) {
                    const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw new Error(lastError.response?.data?.error?.message || 'Failed to fetch data from WhatsApp API');
    }

    /**
     * Send a template message
     */
    async sendTemplateMessage(to: string, templateName: string, languageCode: string = 'en_US', components: any[] = []) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                to: to,
                type: 'template',
                template: {
                    name: templateName,
                    language: {
                        code: languageCode
                    },
                    components: components
                }
            };

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Send Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
        }
    }

    /**
     * Send a text message (requires user initiated 24h window)
     */
    async sendTextMessage(to: string, body: string) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: {
                    body: body
                }
            };

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Send Text Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp message');
        }
    }

    /**
     * Send an interactive "reply button" message (up to 3 buttons - Meta's hard limit).
     * Used by the Flow builder's `buttons` node.
     */
    async sendInteractiveButtonsMessage(to: string, bodyText: string, buttons: { id: string; title: string }[]) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: bodyText },
                    action: {
                        buttons: buttons.slice(0, 3).map(b => ({
                            type: 'reply',
                            reply: { id: b.id, title: b.title.slice(0, 20) }
                        }))
                    }
                }
            };

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Send Interactive Buttons Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp interactive message');
        }
    }

    /**
     * Send an interactive "list" message (for more than 3 options - Meta's button limit).
     * Used by the Flow builder's `list` node.
     */
    async sendInteractiveListMessage(
        to: string,
        bodyText: string,
        buttonText: string,
        sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]
    ) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                to,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: bodyText },
                    action: {
                        button: buttonText.slice(0, 20),
                        sections: sections.map(s => ({
                            title: s.title.slice(0, 24),
                            rows: s.rows.slice(0, 10).map(r => ({
                                id: r.id,
                                title: r.title.slice(0, 24),
                                description: r.description?.slice(0, 72)
                            }))
                        }))
                    }
                }
            };

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Send Interactive List Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp interactive message');
        }
    }

    /**
     * Send a media message (image, document, audio, video)
     */
    async sendMediaMessage(to: string, mediaType: 'image' | 'document' | 'audio' | 'video', mediaId: string, caption?: string, filename?: string) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;

            const mediaPayload: any = {
                id: mediaId
            };

            if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
                mediaPayload.caption = caption;
            }

            if (filename && mediaType === 'document') {
                mediaPayload.filename = filename;
            }

            const payload = {
                messaging_product: 'whatsapp',
                to: to,
                type: mediaType,
                [mediaType]: mediaPayload
            };

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Send Media Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to send WhatsApp media message');
        }
    }

    /**
     * Get message status
     */
    async getMessageStatus(messageId: string) {
        try {
            const url = `${this.baseUrl}/${messageId}`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Get Message Status Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to get message status');
        }
    }

    /**
     * Get media URL from media ID
     */
    async getMediaUrl(mediaId: string) {
        try {
            const url = `${this.baseUrl}/${mediaId}`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`
                }
            });

            return response.data.url;
        } catch (error: any) {
            console.error('WhatsApp Get Media URL Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to get media URL');
        }
    }

    /**
     * Download media file
     */
    async downloadMedia(mediaUrl: string) {
        try {
            const response = await axios.get(mediaUrl, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`
                },
                responseType: 'stream'
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Download Media Error:', error.response?.data || error.message);
            throw new Error('Failed to download media file');
        }
    }

    /**
     * Get WhatsApp Business Account templates
     */
    async getTemplates() {
        try {
            if (!this.config.wabaId) {
                throw new Error('WhatsApp Business Account ID not configured');
            }

            const url = `${this.baseUrl}/${this.config.wabaId}/message_templates`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`
                }
            });

            return response.data.data || [];
        } catch (error: any) {
            console.error('WhatsApp Get Templates Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to get templates');
        }
    }

    /**
     * Create a new message template
     */
    async createTemplate(templateData: {
        name: string;
        category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
        language: string;
        components: any[];
    }) {
        try {
            if (!this.config.wabaId) {
                throw new Error('WhatsApp Business Account ID not configured');
            }

            const url = `${this.baseUrl}/${this.config.wabaId}/message_templates`;

            const response = await axios.post(url, templateData, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Create Template Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to create template');
        }
    }

    /**
     * Delete a message template by name (removes every language variant)
     */
    async deleteTemplate(name: string) {
        try {
            if (!this.config.wabaId) {
                throw new Error('WhatsApp Business Account ID not configured');
            }

            const response = await axios.delete(`${this.baseUrl}/${this.config.wabaId}/message_templates`, {
                params: { name },
                headers: { 'Authorization': `Bearer ${this.config.accessToken}` }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Delete Template Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to delete template');
        }
    }

    /**
     * Get phone number information
     */
    async getPhoneNumberInfo() {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Get Phone Info Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to get phone number info');
        }
    }

    /**
     * Mark message as read
     */
    async markMessageAsRead(messageId: string) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;

            const payload = {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            };

            const response = await axios.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Mark Read Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to mark message as read');
        }
    }

    /**
     * Get conversation analytics
     */
    async getConversationAnalytics(startDate: string, endDate: string) {
        try {
            if (!this.config.wabaId) {
                throw new Error('WhatsApp Business Account ID not configured');
            }

            const url = `${this.baseUrl}/${this.config.wabaId}`;

            const response = await axios.get(url, {
                params: {
                    fields: 'conversation_analytics',
                    start: startDate,
                    end: endDate
                },
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`
                }
            });

            return response.data.conversation_analytics || {};
        } catch (error: any) {
            console.error('WhatsApp Analytics Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to get conversation analytics');
        }
    }

    /**
     * Upload media to Meta servers
     */
    async uploadMedia(file: Buffer, fileName: string, mimeType: string) {
        try {
            const url = `${this.baseUrl}/${this.config.phoneNumberId}/media`;

            const formData = new FormData();
            // Use Uint8Array to wrap Buffer for Blob compatibility in Node.js 18+
            formData.append('file', new Blob([new Uint8Array(file)]), fileName);
            formData.append('messaging_product', 'whatsapp');
            formData.append('type', mimeType);

            const response = await axios.post(url, formData, {
                headers: {
                    'Authorization': `Bearer ${this.config.accessToken}`,
                    'Content-Type': 'multipart/form-data'
                }
            });

            return response.data;
        } catch (error: any) {
            console.error('WhatsApp Upload Media Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.error?.message || 'Failed to upload media to WhatsApp');
        }
    }
}
