import { Request, Response } from 'express';
import prisma from '../config/prisma';

const VALID_SEVERITIES = ['info', 'warning', 'critical', 'update'];
const VALID_AUDIENCES = ['all', 'admins', 'self'];

/**
 * Shared by both the Super Admin panel's "New Broadcast" form and the
 * scripts/broadcast.ts/.sh CLI (which hits POST /api/super-admin/broadcast-
 * notification, the pre-existing route kept for backward compatibility -
 * see the bottom of this file). Creates one Broadcast row plus one
 * Notification row per recipient, linked via `broadcastId`, so acknowledgement
 * can be tracked per-org afterwards.
 */
async function createBroadcastAndNotify({
    title,
    message,
    severity,
    audience,
    createdById,
}: {
    title: string;
    message: string;
    severity: string;
    audience: 'all' | 'admins' | 'self';
    createdById: string;
}) {
    const recipients = audience === 'self'
        ? [{ id: createdById }]
        : await prisma.user.findMany({
            where: {
                isActive: true,
                isDeleted: false,
                ...(audience === 'admins' ? { role: { in: ['admin', 'org_admin', 'organisation_admin'] } } : {})
            },
            select: { id: true }
        });

    const broadcast = await prisma.broadcast.create({
        data: { title, message, severity, audience, createdById, recipientCount: recipients.length }
    });

    if (recipients.length === 0) {
        return { broadcast, count: 0 };
    }

    const crypto = await import('crypto');
    const notificationsData = recipients.map((recipient) => ({
        id: crypto.randomUUID(),
        recipientId: recipient.id,
        title,
        message,
        type: 'popup',
        severity,
        broadcastId: broadcast.id,
        isRead: false,
        createdAt: new Date(),
        updatedAt: new Date()
    }));

    await prisma.notification.createMany({ data: notificationsData });

    const { getIO } = await import('../socket');
    const io = getIO();
    if (io) {
        notificationsData.forEach((notif) => io.to(notif.recipientId).emit('notification', notif));
    }

    return { broadcast, count: recipients.length };
}

/**
 * @route   POST /api/super-admin/broadcasts
 * @desc    New endpoint backing the Super Admin panel's broadcast composer.
 * @access  Super admin only
 */
export const sendBroadcast = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const { title, message } = req.body;
        const audience: 'admins' | 'all' | 'self' =
            req.body.audience === 'all' ? 'all' : req.body.audience === 'self' ? 'self' : 'admins';
        const severity = VALID_SEVERITIES.includes(req.body.severity) ? req.body.severity : 'info';

        if (!title || !message) {
            return res.status(400).json({ message: 'Title and message are required' });
        }

        const { broadcast, count } = await createBroadcastAndNotify({ title, message, severity, audience, createdById: user.id });

        if (count === 0) {
            return res.json({ success: true, broadcastId: broadcast.id, count: 0, message: `No ${audience === 'all' ? 'active users' : 'organisation administrators'} found` });
        }

        const audienceLabel = audience === 'all' ? 'users' : audience === 'self' ? '(you only, test mode)' : 'admins';
        res.json({ success: true, broadcastId: broadcast.id, count, message: `Broadcast successfully sent to ${count} ${audienceLabel}` });
    } catch (error) {
        console.error('sendBroadcast Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * @route   GET /api/super-admin/broadcasts
 * @desc    List past broadcasts with aggregate read/pending counts.
 * @access  Super admin only
 */
export const getAllBroadcasts = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const broadcasts = await prisma.broadcast.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: {
                createdBy: { select: { firstName: true, lastName: true } },
                _count: { select: { notifications: true } }
            }
        });

        const readCounts = await prisma.notification.groupBy({
            by: ['broadcastId'],
            where: { broadcastId: { in: broadcasts.map((b) => b.id) }, isRead: true },
            _count: { id: true }
        });
        const readCountByBroadcast = new Map(readCounts.map((r) => [r.broadcastId, r._count.id]));

        const result = broadcasts.map((b) => {
            const readCount = readCountByBroadcast.get(b.id) || 0;
            return {
                id: b.id,
                title: b.title,
                message: b.message,
                severity: b.severity,
                audience: b.audience,
                createdAt: b.createdAt,
                createdBy: b.createdBy ? `${b.createdBy.firstName} ${b.createdBy.lastName || ''}`.trim() : null,
                recipientCount: b._count.notifications,
                readCount,
                pendingCount: b._count.notifications - readCount
            };
        });

        res.json({ broadcasts: result });
    } catch (error) {
        console.error('getAllBroadcasts Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * @route   GET /api/super-admin/broadcasts/:id/stats
 * @desc    Per-organisation acknowledgement breakdown for one broadcast -
 *          which orgs are fully acknowledged, and which specific users in
 *          each org still haven't seen it.
 * @access  Super admin only
 */
export const getBroadcastStats = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const { id } = req.params;
        const broadcast = await prisma.broadcast.findUnique({ where: { id } });
        if (!broadcast) {
            return res.status(404).json({ message: 'Broadcast not found' });
        }

        const notifications = await prisma.notification.findMany({
            where: { broadcastId: id },
            select: {
                isRead: true,
                recipient: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        organisationId: true,
                        organisation: { select: { id: true, name: true } }
                    }
                }
            }
        });

        const orgMap = new Map<string, {
            organisationId: string;
            organisationName: string;
            total: number;
            acknowledged: number;
            pendingUsers: { id: string; name: string; email: string }[];
        }>();

        for (const n of notifications) {
            const orgId = n.recipient.organisationId || 'unknown';
            const orgName = n.recipient.organisation?.name || 'No Organisation';
            if (!orgMap.has(orgId)) {
                orgMap.set(orgId, { organisationId: orgId, organisationName: orgName, total: 0, acknowledged: 0, pendingUsers: [] });
            }
            const entry = orgMap.get(orgId)!;
            entry.total += 1;
            if (n.isRead) {
                entry.acknowledged += 1;
            } else {
                entry.pendingUsers.push({
                    id: n.recipient.id,
                    name: `${n.recipient.firstName} ${n.recipient.lastName || ''}`.trim(),
                    email: n.recipient.email
                });
            }
        }

        const organisations = Array.from(orgMap.values())
            .map((o) => ({ ...o, fullyAcknowledged: o.acknowledged === o.total }))
            .sort((a, b) => a.organisationName.localeCompare(b.organisationName));

        res.json({
            broadcast: { id: broadcast.id, title: broadcast.title, message: broadcast.message, severity: broadcast.severity, audience: broadcast.audience, createdAt: broadcast.createdAt },
            totalRecipients: notifications.length,
            totalAcknowledged: notifications.filter((n) => n.isRead).length,
            fullyAcknowledgedOrgCount: organisations.filter((o) => o.fullyAcknowledged).length,
            totalOrgCount: organisations.length,
            organisations
        });
    } catch (error) {
        console.error('getBroadcastStats Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * @route   POST /api/super-admin/broadcast-notification
 * @desc    Legacy route - kept so scripts/broadcast.ts/.sh (and anything else
 *          already calling this URL) keeps working unchanged. Delegates to
 *          the same underlying logic as `sendBroadcast` above, so broadcasts
 *          sent via the CLI show up in the Super Admin panel's list too.
 * @access  Super admin only
 */
export const broadcastToOrgAdmins = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user.isSuperAdmin) {
            return res.status(403).json({ message: 'Access denied. Super admin only.' });
        }

        const { title, message } = req.body;
        const audience: 'admins' | 'all' | 'self' = VALID_AUDIENCES.includes(req.body.audience) ? req.body.audience : 'admins';
        const severity = VALID_SEVERITIES.includes(req.body.severity) ? req.body.severity : 'info';

        if (!title || !message) {
            return res.status(400).json({ message: 'Title and message are required' });
        }

        const { count } = await createBroadcastAndNotify({ title, message, severity, audience, createdById: user.id });
        const audienceLabel = audience === 'all' ? 'users' : audience === 'self' ? '(you only, test mode)' : 'admins';
        res.json({ success: true, count, message: count === 0 ? `No ${audience === 'all' ? 'active users' : 'organisation administrators'} found` : `Broadcast successfully sent to ${count} ${audienceLabel}` });
    } catch (error) {
        console.error('broadcastToOrgAdmins Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
