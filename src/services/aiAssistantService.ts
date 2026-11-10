import axios from 'axios';
import prisma from '../config/prisma';
import knowledgeBase from '../data/trainingKnowledgeBase.json';

const GEMINI_MODEL = 'gemini-3.6-flash';

export interface AssistantTurn { role: 'user' | 'assistant'; text: string }

const snapshotCache = new Map<string, { at: number; data: any }>();

/** Read-only, organisation-scoped snapshot (cached for 60s so follow-up questions don't re-query). */
export async function buildOrgSnapshot(organisationId: string) {
    const hit = snapshotCache.get(organisationId);
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const data = await computeSnapshot(organisationId);
    snapshotCache.set(organisationId, { at: Date.now(), data });
    return data;
}

async function computeSnapshot(organisationId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const base = { organisationId, isDeleted: false };
    const [leadsByStatus, oppsByStage, newLeadsMonth, overdueFollowUps, openTasks, users, wonMonth] = await Promise.all([
        prisma.lead.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
        prisma.opportunity.groupBy({ by: ['stage'], where: base, _count: { _all: true }, _sum: { amount: true } }),
        prisma.lead.count({ where: { ...base, createdAt: { gte: monthStart } } }),
        prisma.followUp.count({ where: { ...base, dueDate: { lt: now }, status: { notIn: ['completed', 'cancelled'] as any } } }),
        prisma.task.count({ where: { ...base, status: { not: 'completed' as any } } }),
        prisma.user.count({ where: { organisationId, isActive: true } }),
        prisma.opportunity.aggregate({ where: { ...base, stage: 'closed_won', closeDate: { gte: monthStart } }, _count: { _all: true }, _sum: { amount: true } }),
    ]);
    return {
        asOf: now.toISOString(),
        activeUsers: users,
        leadsByStatus: Object.fromEntries(leadsByStatus.map((r: any) => [r.status, r._count._all])),
        newLeadsThisMonth: newLeadsMonth,
        opportunitiesByStage: Object.fromEntries(oppsByStage.map((r: any) => [r.stage, { count: r._count._all, totalAmount: r._sum.amount || 0 }])),
        wonThisMonth: { count: wonMonth._count._all, totalAmount: wonMonth._sum.amount || 0 },
        overdueFollowUps,
        openTasks,
    };
}

function buildRequest(message: string, history: AssistantTurn[], snapshot: any, voice: boolean) {
    const system = `You are the PypeCRM AI Assistant for an organisation admin. Help them understand their CRM data and how the product works.
Use LIVE DATA for numbers about their business — never invent figures; if the data doesn't cover the question, say so and point to the right page (Reports, Leads, Opportunities, Sales Targets).
Use the KNOWLEDGE BASE for how-to/product questions. Be concise and direct.
${voice
  ? 'This reply will be read aloud: plain spoken sentences only, no markdown, no lists, no symbols, under 60 words.'
  : 'Formatting: plain text, **bold** sparingly, "- " or "1. " lists; no headers, tables, code blocks or emoji.'}

LIVE DATA (this organisation only):
${JSON.stringify(snapshot)}

KNOWLEDGE BASE:
${JSON.stringify(knowledgeBase)}`;
    const contents = [
        ...history.slice(-8).map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
        { role: 'user', parts: [{ text: message }] },
    ];
    return { system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.4, maxOutputTokens: voice ? 300 : 700, thinkingConfig: { thinkingBudget: 0 } } };
}

/** Streams the reply token-by-token; resolves true if any text was produced. */
export async function streamAssistantReply(message: string, history: AssistantTurn[], organisationId: string, voice: boolean, onText: (t: string) => void): Promise<boolean> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return false;
    const snapshot = await buildOrgSnapshot(organisationId).catch(() => null);
    const body = buildRequest(message, history, snapshot, voice);
    let got = false;
    try {
        const r = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`,
            body, { responseType: 'stream', timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );
        let buf = '';
        await new Promise<void>((resolve, reject) => {
            r.data.on('data', (chunk: Buffer) => {
                buf += chunk.toString('utf8');
                let i: number;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                    if (!line.startsWith('data:')) continue;
                    try {
                        const j = JSON.parse(line.slice(5));
                        const t = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
                        if (t) { got = true; onText(t); }
                    } catch { /* partial json */ }
                }
            });
            r.data.on('end', resolve);
            r.data.on('error', reject);
        });
    } catch (e) {
        console.error('[aiAssistant] stream failed:', (e as any).response?.status || (e as Error).message);
    }
    return got;
}

export async function generateAssistantReply(message: string, history: AssistantTurn[], organisationId: string, voice: boolean): Promise<string | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    const snapshot = await buildOrgSnapshot(organisationId).catch(() => null);

    const system = `You are the PypeCRM AI Assistant for an organisation admin. Help them understand their CRM data and how the product works.
Use LIVE DATA for numbers about their business — never invent figures; if the data doesn't cover the question, say so and point to the right page (Reports, Leads, Opportunities, Sales Targets).
Use the KNOWLEDGE BASE for how-to/product questions. Be concise and direct.
${voice
  ? 'This reply will be read aloud: plain spoken sentences only, no markdown, no lists, no symbols, under 80 words.'
  : 'Formatting: plain text, **bold** sparingly, "- " or "1. " lists; no headers, tables, code blocks or emoji.'}

LIVE DATA (this organisation only):
${JSON.stringify(snapshot)}

KNOWLEDGE BASE:
${JSON.stringify(knowledgeBase)}`;

    const contents = [
        ...history.slice(-12).map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] })),
        { role: 'user', parts: [{ text: message }] },
    ];
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const r = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
                { system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.4, maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } } },
                { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
            );
            return r.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
        } catch (e) {
            const status = (e as any).response?.status;
            if (attempt === 3 || ![429, 503].includes(status)) return null;
            await new Promise((res) => setTimeout(res, 800 * attempt));
        }
    }
    return null;
}
