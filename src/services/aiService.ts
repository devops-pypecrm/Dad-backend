import axios from 'axios';
import { prisma } from '../config/prisma';
import { decrypt } from '../utils/encryption';

const GROUP = 'ai_integration';

const DEFAULT_MODELS: Record<string, string> = {
    gemini: 'gemini-2.0-flash',
    groq: 'llama-3.1-8b-instant'
};

interface AiConfig {
    provider: string;
    apiKey: string;
    model: string;
    enabled: boolean;
}

// Settings are stored in SystemSetting (group ai_integration), not env vars,
// so the key can be changed from Super Admin > AI Integration without a
// redeploy. Re-read on every call rather than caching - this endpoint is
// called at most a few times per dashboard load, not hot-path traffic.
async function getAiConfig(): Promise<AiConfig> {
    const rows = await prisma.systemSetting.findMany({ where: { group: GROUP } });
    const map = rows.reduce((acc: Record<string, string>, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});

    const provider = map['ai_provider'] || 'gemini';
    const rawKey = map['ai_api_key'] ? decrypt(map['ai_api_key']) : '';

    return {
        provider,
        apiKey: rawKey,
        model: map['ai_model'] || DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini,
        enabled: map['ai_enabled'] === 'true'
    };
}

async function callGemini(apiKey: string, model: string, prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const { data } = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
    }, { timeout: 15000 });

    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function callGroq(apiKey: string, model: string, prompt: string): Promise<string> {
    const { data } = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5
    }, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000
    });

    return data?.choices?.[0]?.message?.content?.trim() || '';
}

// Returns null (never throws) when AI isn't configured/enabled or the
// provider call fails, so callers can always fall back to the plain
// computed-numbers view instead of breaking the page.
export async function generateInsight(prompt: string): Promise<string | null> {
    try {
        const config = await getAiConfig();
        if (!config.enabled || !config.apiKey) return null;

        if (config.provider === 'groq') {
            return await callGroq(config.apiKey, config.model, prompt) || null;
        }
        return await callGemini(config.apiKey, config.model, prompt) || null;
    } catch (error: any) {
        console.error('AI insight generation failed:', error?.response?.data || error.message);
        return null;
    }
}

export async function isAiConfigured(): Promise<boolean> {
    const config = await getAiConfig();
    return config.enabled && !!config.apiKey;
}
