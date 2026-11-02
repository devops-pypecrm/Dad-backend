import { Request, Response } from 'express';
import prisma from '../config/prisma';

// Strictly private, per-user WhatsApp message templates for the mobile
// app's "send via WhatsApp" quick action. Every handler below scopes by
// `userId: req.user.id` ONLY — never by organisationId, never with an
// admin/super_admin bypass. This is intentional: the whole point of this
// feature is that nobody else, including an org admin, can see another
// user's templates. Do not "fix" this to add org-wide visibility.

export const listTemplates = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.id;

        const templates = await prisma.whatsAppPersonalTemplate.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' }
        });

        return res.json(templates);
    } catch (error) {
        console.error('[WhatsAppPersonalTemplate] listTemplates error:', error);
        return res.status(500).json({ message: 'Failed to load templates' });
    }
};

export const createTemplate = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const { title, body } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ message: 'Title is required' });
        }
        if (!body || typeof body !== 'string' || !body.trim()) {
            return res.status(400).json({ message: 'Message body is required' });
        }

        const template = await prisma.whatsAppPersonalTemplate.create({
            data: {
                organisationId: user.organisationId,
                userId: user.id,
                title: title.trim(),
                body: body.trim()
            }
        });

        return res.status(201).json(template);
    } catch (error) {
        console.error('[WhatsAppPersonalTemplate] createTemplate error:', error);
        return res.status(500).json({ message: 'Failed to create template' });
    }
};

export const updateTemplate = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.id;
        const { id } = req.params;
        const { title, body } = req.body;

        // Scoping the WHERE by userId (not just id) means a template that
        // belongs to someone else returns 404 here rather than ever
        // reaching an ownership check after the fact — there is no window
        // where another user's template data is read into this process at
        // all.
        const existing = await prisma.whatsAppPersonalTemplate.findFirst({
            where: { id, userId }
        });
        if (!existing) {
            return res.status(404).json({ message: 'Template not found' });
        }

        const template = await prisma.whatsAppPersonalTemplate.update({
            where: { id },
            data: {
                ...(title !== undefined && typeof title === 'string' && title.trim() ? { title: title.trim() } : {}),
                ...(body !== undefined && typeof body === 'string' && body.trim() ? { body: body.trim() } : {})
            }
        });

        return res.json(template);
    } catch (error) {
        console.error('[WhatsAppPersonalTemplate] updateTemplate error:', error);
        return res.status(500).json({ message: 'Failed to update template' });
    }
};

export const deleteTemplate = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.id;
        const { id } = req.params;

        const existing = await prisma.whatsAppPersonalTemplate.findFirst({
            where: { id, userId }
        });
        if (!existing) {
            return res.status(404).json({ message: 'Template not found' });
        }

        await prisma.whatsAppPersonalTemplate.delete({ where: { id } });

        return res.status(204).send();
    } catch (error) {
        console.error('[WhatsAppPersonalTemplate] deleteTemplate error:', error);
        return res.status(500).json({ message: 'Failed to delete template' });
    }
};
