import { Request, Response } from 'express';
import { generateInsight } from '../services/aiService';

const PROMPT_INSTRUCTIONS: Record<string, string> = {
    'user-trend': 'You are a CRM analyst. Given this call-activity data for a sales team, write a short (2-3 sentence) plain-English insight about how their call conversations are trending over time - call out any notable increase/decrease, connection-rate pattern, or standout day/user. Be specific with numbers from the data. Do not use markdown formatting.',
    'business-trend': 'You are a CRM analyst. Given this lead-source and conversion data for a business, write a short (2-3 sentence) plain-English business insight - call out which campaign/lead source is performing best or worst, and one actionable recommendation. Be specific with numbers from the data. Do not use markdown formatting.'
};

// Builds a plain-English fallback (no LLM) purely from the numbers already
// computed on the frontend, so the insight card still shows something useful
// when no AI key is configured yet - mirrors the existing rule-based
// getAiInsights endpoint elsewhere in this codebase.
function computeFallbackInsight(type: string, summary: any): string {
    try {
        if (type === 'user-trend' && Array.isArray(summary?.callActivity) && summary.callActivity.length > 0) {
            const points = summary.callActivity;
            const totalCalls = points.reduce((s: number, p: any) => s + (p.total || 0), 0);
            const totalConnected = points.reduce((s: number, p: any) => s + (p.connected || 0), 0);
            const rate = totalCalls > 0 ? Math.round((totalConnected / totalCalls) * 100) : 0;
            const best = [...points].sort((a, b) => (b.total || 0) - (a.total || 0))[0];
            return `Your team logged ${totalCalls} calls in this range with a ${rate}% connection rate (${totalConnected} connected). The busiest day was ${best?.date || 'N/A'} with ${best?.total || 0} calls.`;
        }
        if (type === 'business-trend' && Array.isArray(summary?.leadSources) && summary.leadSources.length > 0) {
            const sorted = [...summary.leadSources].sort((a: any, b: any) => (b.count || 0) - (a.count || 0));
            const top = sorted[0];
            const totalLeads = sorted.reduce((s: number, l: any) => s + (l.count || 0), 0);
            const sharePct = totalLeads > 0 ? Math.round((top.count / totalLeads) * 100) : 0;
            return `"${top.source}" is your top-performing lead source, bringing in ${top.count} of ${totalLeads} leads (${sharePct}%). Consider allocating more budget toward it and reviewing lower-performing sources.`;
        }
        return 'Not enough data yet to generate an insight for this range.';
    } catch {
        return 'Not enough data yet to generate an insight for this range.';
    }
}

export const getTrendInsight = async (req: Request, res: Response) => {
    try {
        // GET + query param, not POST - the frontend never fetches/sends the
        // CSRF token this router's verifyCSRFToken middleware requires on
        // mutating methods, so a POST here would 403 in practice. GET is
        // exempt, and this call has no side effects, so it's the correct verb anyway.
        const type = req.query.type as string;
        let summary: any = {};
        try {
            summary = req.query.summary ? JSON.parse(req.query.summary as string) : {};
        } catch {
            summary = {};
        }
        if (!type || !PROMPT_INSTRUCTIONS[type]) {
            return res.status(400).json({ message: 'Invalid insight type' });
        }

        const prompt = `${PROMPT_INSTRUCTIONS[type]}\n\nData:\n${JSON.stringify(summary || {})}`;
        const aiText = await generateInsight(prompt);

        if (aiText) {
            return res.json({ insight: aiText, source: 'ai' });
        }

        return res.json({ insight: computeFallbackInsight(type, summary), source: 'computed' });
    } catch (error) {
        console.error('getTrendInsight error:', error);
        res.status(500).json({ message: 'Failed to generate insight' });
    }
};
