import axios from 'axios';

// Happilee REST API (https://api.happilee.io/api/v1), authenticated with an `x-api-key` header.
// Endpoint shapes taken from Happilee's own WordPress connector (getProjectDetails, getTemplateMessages,
// createContact, sendMessage). Happilee does not publish full public docs, so response parsing is defensive.
const BASE_URL = 'https://api.happilee.io/api/v1';

export class HappileeService {
    constructor(private apiKey: string) {}

    private headers() {
        return { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' };
    }

    private fail(error: any, fallback: string): never {
        const status = error.response?.status;
        if (status === 401 || status === 403) throw new Error('Invalid Happilee API key, or this key does not have API access. Contact Happilee support.');
        throw new Error(error.response?.data?.message || fallback);
    }

    /** Validates the API key and returns the project details. */
    async validate() {
        try {
            const res = await axios.get(`${BASE_URL}/getProjectDetails`, { headers: this.headers(), timeout: 15000 });
            return res.data;
        } catch (error: any) {
            this.fail(error, 'Could not reach Happilee to validate the API key');
        }
    }

    async getTemplates(): Promise<any[]> {
        try {
            const res = await axios.get(`${BASE_URL}/getTemplateMessages`, { headers: this.headers(), timeout: 15000 });
            return Array.isArray(res.data?.data) ? res.data.data : [];
        } catch (error: any) {
            this.fail(error, 'Failed to fetch Happilee templates');
        }
    }

    /** Create or update a contact in Happilee. */
    async createContact(contact: { phone: string; name?: string; email?: string; source?: string }) {
        try {
            const res = await axios.post(`${BASE_URL}/createContact`, contact, { headers: this.headers(), timeout: 15000 });
            return res.data;
        } catch (error: any) {
            this.fail(error, 'Failed to sync contact to Happilee');
        }
    }

    /**
     * Send an approved template. `templateName` is resolved to Happilee's template id; `values` fill the
     * body variables in order ({{1}}, {{2}}, ...).
     */
    async sendTemplate(phone: string, templateName: string, values: string[] = []) {
        const templates = await this.getTemplates();
        const tpl = templates.find(t => t?.template_name === templateName || String(t?.id ?? t?.template_message_id) === templateName);
        if (!tpl) throw new Error(`Template "${templateName}" was not found in your Happilee account.`);
        const templateId = tpl.id ?? tpl.template_message_id ?? tpl._id;

        const body: Record<string, string> = {};
        values.forEach((v, i) => { body[String(i + 1)] = v; });

        try {
            const res = await axios.post(`${BASE_URL}/sendMessage`, {
                candidate_details: { phone_number: phone.replace(/\D/g, '') },
                template_message_id: templateId,
                template_params: [{ name: 'body', value: body }]
            }, { headers: this.headers(), timeout: 20000 });
            if (res.data?.error) throw new Error(res.data.message || 'Happilee rejected the message');
            return { messages: [{ id: res.data?.data?.message_id || res.data?.message_id || res.data?.id }], raw: res.data };
        } catch (error: any) {
            if (error.response) this.fail(error, 'Failed to send message via Happilee');
            throw error;
        }
    }
}
