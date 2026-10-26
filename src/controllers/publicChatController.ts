import { Request, Response } from 'express';
import { generatePublicChatReply, PublicChatTurn } from '../services/publicChatService';

const MAX_MESSAGE_LENGTH = 500;

export const chatWithPublicAssistant = async (req: Request, res: Response) => {
    try {
        const { message, history } = req.body as { message?: string; history?: PublicChatTurn[] };

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ message: 'A message is required' });
        }
        if (message.length > MAX_MESSAGE_LENGTH) {
            return res.status(400).json({ message: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)` });
        }

        const safeHistory = Array.isArray(history)
            ? history.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string')
            : [];

        const reply = await generatePublicChatReply(message.trim(), safeHistory);

        if (!reply) {
            return res.status(200).json({
                reply: "I'm having trouble reaching the AI right now — please try again in a moment, or contact our customer success team.",
                degraded: true,
            });
        }
        res.status(200).json({ reply });
    } catch (error) {
        console.error('[publicChatController] Error:', error);
        res.status(500).json({ message: 'Failed to generate a response' });
    }
};
