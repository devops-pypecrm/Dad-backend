import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { encrypt, decrypt } from '../utils/encryption';

const GROUP = 'ai_integration';
const KEYS = {
    provider: 'ai_provider',
    apiKey: 'ai_api_key',
    model: 'ai_model',
    enabled: 'ai_enabled'
};

// Masks a secret down to its last 4 characters (e.g. "••••••••ab12") so the
// frontend can show something exists without ever re-sending the real key.
const maskKey = (key: string) => {
    if (!key) return '';
    if (key.length <= 4) return '••••';
    return `${'•'.repeat(Math.min(key.length - 4, 20))}${key.slice(-4)}`;
};

export const getAiSettings = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const rows = await prisma.systemSetting.findMany({ where: { group: GROUP } });
        const map = rows.reduce((acc: Record<string, string>, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});

        const rawKey = map[KEYS.apiKey] ? decrypt(map[KEYS.apiKey]) : '';

        res.json({
            provider: map[KEYS.provider] || 'gemini',
            model: map[KEYS.model] || '',
            enabled: map[KEYS.enabled] === 'true',
            apiKeyMasked: rawKey ? maskKey(rawKey) : '',
            hasApiKey: !!rawKey
        });
    } catch (error) {
        console.error('Get AI settings error:', error);
        res.status(500).json({ message: 'Failed to fetch AI settings' });
    }
};

export const updateAiSettings = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { provider, apiKey, model, enabled } = req.body;

        const updates = [
            prisma.systemSetting.upsert({
                where: { key: KEYS.provider },
                update: { value: String(provider || 'gemini'), group: GROUP },
                create: { key: KEYS.provider, value: String(provider || 'gemini'), group: GROUP }
            }),
            prisma.systemSetting.upsert({
                where: { key: KEYS.model },
                update: { value: String(model || ''), group: GROUP },
                create: { key: KEYS.model, value: String(model || ''), group: GROUP }
            }),
            prisma.systemSetting.upsert({
                where: { key: KEYS.enabled },
                update: { value: String(!!enabled), group: GROUP },
                create: { key: KEYS.enabled, value: String(!!enabled), group: GROUP }
            })
        ];

        // Only touch the stored key if the admin actually typed a new one -
        // leaving the field blank on save means "keep the existing key",
        // so the masked placeholder never has to round-trip as a real secret.
        if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
            const encrypted = encrypt(apiKey.trim());
            updates.push(prisma.systemSetting.upsert({
                where: { key: KEYS.apiKey },
                update: { value: encrypted, group: GROUP },
                create: { key: KEYS.apiKey, value: encrypted, group: GROUP }
            }));
        }

        await prisma.$transaction(updates);

        res.json({ message: 'AI settings updated successfully' });
    } catch (error) {
        console.error('Update AI settings error:', error);
        res.status(500).json({ message: 'Failed to update AI settings' });
    }
};
