
import { Request, Response } from 'express';
import prisma from '../config/prisma';

export const getNotifications = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;

        if (!user || !user.id) {
            return res.status(401).json({ message: 'Not authorized' });
        }

        const userId = user.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const type = req.query.type as string; // 'info', 'warning', etc.
        const isRead = req.query.isRead; // 'true', 'false', or undefined

        const whereClause: any = { recipientId: userId };

        if (type && type !== 'all') {
            whereClause.type = type;
        }

        if (isRead === 'true') {
            whereClause.isRead = true;
        } else if (isRead === 'false') {
            whereClause.isRead = false;
        }

        // Excludes notifications whose originating broadcast has been
        // withdrawn (Broadcast.active = false) from the unread feed, so a
        // super admin can stop a popup from still surfacing to users who
        // haven't seen it yet without touching any Notification row —
        // ordinary (non-broadcast) notifications have broadcastId null and
        // are unaffected by this clause.
        whereClause.OR = [
            { broadcastId: null },
            { broadcast: { active: true } }
        ];

        const notifications = await prisma.notification.findMany({
            where: whereClause,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: (page - 1) * limit
        });

        const total = await prisma.notification.count({ where: whereClause });
        // Same withdrawn-broadcast exclusion as whereClause above — otherwise
        // the unread badge could count a notification that will never
        // actually be shown (its popup was withdrawn), which reads as the
        // badge being "stuck".
        const unreadCount = await prisma.notification.count({
            where: {
                recipientId: userId,
                isRead: false,
                OR: [{ broadcastId: null }, { broadcast: { active: true } }]
            }
        });

        res.json({
            notifications,
            unreadCount,
            total,
            totalPages: Math.ceil(total / limit),
            currentPage: page
        });
    } catch (error) {
        console.error('getNotifications Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

export const markAsRead = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await prisma.notification.update({
            where: { id },
            data: { isRead: true }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('markAsRead Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

export const markAllAsRead = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user.id;
        await prisma.notification.updateMany({
            where: { recipientId: userId, isRead: false },
            data: { isRead: true }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('markAllAsRead Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Broadcast notification to all users in the organisation (Organisation Admin Only)
export const broadcastNotification = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user || user.role !== 'admin') {
            return res.status(403).json({ message: 'Access denied. Organisation admin only.' });
        }

        const { title, message } = req.body;
        if (!title || !message) {
            return res.status(400).json({ message: 'Title and message are required' });
        }

        const organisationId = user.organisationId;
        if (!organisationId) {
            return res.status(400).json({ message: 'User is not associated with an organisation' });
        }

        // Fetch all active, non-deleted users in the admin's organisation
        const orgUsers = await prisma.user.findMany({
            where: {
                organisationId,
                isActive: true,
                isDeleted: false
            },
            select: { id: true }
        });

        if (orgUsers.length === 0) {
            return res.json({ success: true, count: 0, message: 'No users found in this organisation' });
        }

        const crypto = await import('crypto');

        // Prepare notifications data with pre-generated UUIDs
        const notificationsData = orgUsers.map(orgUser => ({
            id: crypto.randomUUID(),
            recipientId: orgUser.id,
            title,
            message,
            type: 'popup',
            isRead: false,
            createdAt: new Date(),
            updatedAt: new Date()
        }));

        // Batch insert
        await prisma.notification.createMany({
            data: notificationsData
        });

        // Real-time emission via Socket.io
        const { getIO } = await import('../socket');
        const io = getIO();
        if (io) {
            notificationsData.forEach(notif => {
                io.to(notif.recipientId).emit('notification', notif);
            });
        }

        res.json({ success: true, count: orgUsers.length, message: `Broadcast successfully sent to ${orgUsers.length} users` });
    } catch (error) {
        console.error('broadcastNotification Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
