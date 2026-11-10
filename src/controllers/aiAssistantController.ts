import { Request, Response } from 'express';
import { generateAssistantReply, streamAssistantReply, AssistantTurn } from '../services/aiAssistantService';
import { getOrgId } from '../utils/hierarchyUtils';
import { isOrgAdmin } from '../utils/roleUtils';

export const chatWithAssistant = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!isOrgAdmin(user)) return res.status(403).json({ message: 'AI Assistant is available to admins only' });
        const organisationId = getOrgId(user);
        if (!organisationId) return res.status(400).json({ message: 'No organisation' });

        const { message, history, voice } = req.body as { message?: string; history?: AssistantTurn[]; voice?: boolean };
        if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ message: 'A message is required' });
        if (message.length > 2000) return res.status(400).json({ message: 'Message is too long (max 2000 characters)' });

        const safe = Array.isArray(history) ? history.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string') : [];
        const reply = await generateAssistantReply(message.trim(), safe, organisationId, !!voice);
        if (!reply) return res.status(200).json({ reply: "I'm having trouble reaching the AI service right now — please try again in a moment.", degraded: true });
        res.json({ reply });
    } catch (e) {
        console.error('[aiAssistantController]', e);
        res.status(500).json({ message: 'Failed to generate a response' });
    }
};

/** Server-sent events: `data: {"t":"text"}` chunks, then `data: {"done":true}`. */
export const streamWithAssistant = async (req: Request, res: Response) => {
    const user = (req as any).user;
    if (!isOrgAdmin(user)) return res.status(403).json({ message: 'AI Assistant is available to admins only' });
    const organisationId = getOrgId(user);
    if (!organisationId) return res.status(400).json({ message: 'No organisation' });
    const { message, history, voice } = req.body as { message?: string; history?: AssistantTurn[]; voice?: boolean };
    if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ message: 'A message is required' });
    if (message.length > 2000) return res.status(400).json({ message: 'Message is too long (max 2000 characters)' });
    const safe = Array.isArray(history) ? history.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string') : [];

    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = (o: object) => { res.write(`data: ${JSON.stringify(o)}\n\n`); (res as any).flush?.(); };
    try {
        const ok = await streamAssistantReply(message.trim(), safe, organisationId, !!voice, (t) => send({ t }));
        if (!ok) send({ t: "I'm having trouble reaching the AI service right now — please try again in a moment.", degraded: true });
    } catch (e) {
        console.error('[aiAssistantController] stream', e);
        send({ t: 'Something went wrong — please try again.' });
    }
    send({ done: true });
    res.end();
};
