import { Request, Response } from 'express';
import { Prisma } from '../generated/client';
import prisma from '../config/prisma';
import { deliverPush, isPushConfigured } from '../config/firebaseAdmin';
import { recordPushLogs, tokenSuffix } from '../services/pushAuditService';

/**
 * Notification Audit panel API (Super Admin only, cross-tenant).
 *
 * Everything here is READ-ONLY except the explicit "test push" and "remove device" actions.
 * Three data sources are joined:
 *   - Notification      the in-app rows (what the bell shows). NOTE: NotificationService.send()
 *                       does not stamp organisationId on these rows, so org filtering goes
 *                       through the recipient's organisation, never Notification.organisationId.
 *   - UserDevice        registered FCM tokens (+ legacy User.fcmToken mirror).
 *   - PushDeliveryLog   one row per push attempt/skip, written by NotificationService.pushToUser.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The app re-registers its token on every launch, so a device unseen this long has not been opened. */
const STALE_DEVICE_DAYS = 7;

const requireSuperAdmin = (req: Request, res: Response): boolean => {
    if (!(req as any).user?.isSuperAdmin) {
        res.status(403).json({ message: 'Access denied. Super admin only.' });
        return false;
    }
    return true;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const paging = (q: Record<string, any>, defLimit = 50) => {
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || defLimit));
    return { page, limit, skip: (page - 1) * limit };
};

const dateRange = (q: Record<string, any>): { gte?: Date; lte?: Date } | undefined => {
    const from = str(q.from) ? new Date(q.from) : undefined;
    const to = str(q.to) ? new Date(q.to) : undefined;
    const range: { gte?: Date; lte?: Date } = {};
    if (from && !isNaN(from.getTime())) range.gte = from;
    if (to && !isNaN(to.getTime())) range.lte = to;
    return range.gte || range.lte ? range : undefined;
};

const fullName = (u?: { firstName?: string | null; lastName?: string | null } | null) =>
    u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() : '';

/** Resolve user + org display info for a set of user ids (logs keep plain ids, no FK). */
async function userInfoMap(userIds: string[]) {
    const unique = Array.from(new Set(userIds));
    if (unique.length === 0) return new Map<string, any>();
    const users = await prisma.user.findMany({
        where: { id: { in: unique } },
        select: {
            id: true, firstName: true, lastName: true, email: true, role: true, organisationId: true,
            organisation: { select: { name: true } }
        }
    });
    return new Map(users.map((u) => [u.id, {
        id: u.id, name: fullName(u), email: u.email, role: u.role,
        organisationId: u.organisationId, organisationName: u.organisation?.name ?? null
    }]));
}

// GET /api/super-admin/notification-audit/organisations
export const getAuditOrganisations = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const orgs = await prisma.organisation.findMany({
            where: { isDeleted: false },
            select: { id: true, name: true },
            orderBy: { name: 'asc' }
        });
        res.json({ organisations: orgs });
    } catch (error) {
        console.error('getAuditOrganisations Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/notification-audit/users-lookup?organisationId=&search=
// Lightweight user picker for the filter bars.
export const lookupAuditUsers = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const organisationId = str(req.query.organisationId);
        const search = str(req.query.search);
        const users = await prisma.user.findMany({
            where: {
                isDeleted: false,
                ...(organisationId ? { organisationId } : {}),
                ...(search ? { OR: [
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } }
                ] } : {})
            },
            select: { id: true, firstName: true, lastName: true, email: true, organisation: { select: { name: true } } },
            orderBy: { firstName: 'asc' },
            take: 100
        });
        res.json({ users: users.map((u) => ({ id: u.id, name: fullName(u), email: u.email, organisationName: u.organisation?.name ?? null })) });
    } catch (error) {
        console.error('lookupAuditUsers Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/notification-audit/summary?organisationId=&hours=24
export const getAuditSummary = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const organisationId = str(req.query.organisationId);
        const hours = Math.min(24 * 30, Math.max(1, parseInt(req.query.hours as string, 10) || 24));
        const since = new Date(Date.now() - hours * 3600 * 1000);
        const staleBefore = new Date(Date.now() - STALE_DEVICE_DAYS * DAY_MS);

        const userWhere: Prisma.UserWhereInput = { isDeleted: false, isActive: true, ...(organisationId ? { organisationId } : {}) };
        const logWhere: Prisma.PushDeliveryLogWhereInput = { createdAt: { gte: since }, ...(organisationId ? { organisationId } : {}) };
        const orgSql = organisationId ? Prisma.sql`AND u."organisationId" = ${organisationId}` : Prisma.empty;
        const orgLogSql = organisationId ? Prisma.sql`AND "organisationId" = ${organisationId}` : Prisma.empty;
        const bucket = hours <= 48 ? 'hour' : 'day';

        const [
            activeUsers, usersWithDevice, usersWithLegacyOnly, pushDisabledUsers,
            deviceCount, staleDevices, notifCount, unreadCount,
            logStatus, topErrors, notifSeries, pushSeries
        ] = await Promise.all([
            prisma.user.count({ where: userWhere }),
            prisma.user.count({ where: { ...userWhere, devices: { some: {} } } }),
            prisma.user.count({ where: { ...userWhere, devices: { none: {} }, fcmToken: { not: null } } }),
            prisma.user.count({ where: { ...userWhere, notificationPreferences: { path: ['pushNotifications'], equals: false } } }),
            prisma.userDevice.count({ where: organisationId ? { user: { organisationId } } : {} }),
            prisma.userDevice.count({ where: { lastSeenAt: { lt: staleBefore }, ...(organisationId ? { user: { organisationId } } : {}) } }),
            prisma.notification.count({ where: { createdAt: { gte: since }, ...(organisationId ? { recipient: { organisationId } } : {}) } }),
            prisma.notification.count({ where: { isRead: false, ...(organisationId ? { recipient: { organisationId } } : {}) } }),
            prisma.pushDeliveryLog.groupBy({ by: ['status'], where: logWhere, _count: { _all: true } }),
            prisma.pushDeliveryLog.groupBy({
                by: ['errorCode', 'status'],
                where: { ...logWhere, errorCode: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { errorCode: 'desc' } },
                take: 10
            }),
            prisma.$queryRaw<{ t: Date; n: bigint }[]>(Prisma.sql`
                SELECT date_trunc(${bucket}, n."createdAt") AS t, COUNT(*) AS n
                FROM "Notification" n JOIN "User" u ON u.id = n."recipientId"
                WHERE n."createdAt" >= ${since} ${orgSql}
                GROUP BY 1 ORDER BY 1`),
            prisma.$queryRaw<{ t: Date; status: string; n: bigint }[]>(Prisma.sql`
                SELECT date_trunc(${bucket}, "createdAt") AS t, status, COUNT(*) AS n
                FROM "PushDeliveryLog"
                WHERE "createdAt" >= ${since} ${orgLogSql}
                GROUP BY 1, 2 ORDER BY 1`)
        ]);

        const statusCount = (s: string) => logStatus.find((r) => r.status === s)?._count._all ?? 0;

        // Merge both series onto one timeline.
        const timeline = new Map<string, { t: string; notifications: number; sent: number; failed: number; skipped: number }>();
        const slot = (d: Date) => {
            const k = d.toISOString();
            if (!timeline.has(k)) timeline.set(k, { t: k, notifications: 0, sent: 0, failed: 0, skipped: 0 });
            return timeline.get(k)!;
        };
        notifSeries.forEach((r) => { slot(r.t).notifications = Number(r.n); });
        pushSeries.forEach((r) => { (slot(r.t) as any)[r.status] = Number(r.n); });

        res.json({
            windowHours: hours,
            bucket,
            fcmConfigured: isPushConfigured(),
            users: {
                active: activeUsers,
                withDevice: usersWithDevice,
                withoutDevice: Math.max(0, activeUsers - usersWithDevice - usersWithLegacyOnly),
                legacyTokenOnly: usersWithLegacyOnly,
                pushDisabled: pushDisabledUsers
            },
            devices: { total: deviceCount, stale: staleDevices, staleAfterDays: STALE_DEVICE_DAYS },
            notifications: { inWindow: notifCount, unreadTotal: unreadCount },
            push: { sent: statusCount('sent'), failed: statusCount('failed'), skipped: statusCount('skipped') },
            topErrors: topErrors.map((r) => ({ errorCode: r.errorCode, status: r.status, count: r._count._all })),
            timeline: Array.from(timeline.values()).sort((a, b) => a.t.localeCompare(b.t))
        });
    } catch (error) {
        console.error('getAuditSummary Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

type Health = 'healthy' | 'failing' | 'no_device' | 'push_disabled' | 'stale_device' | 'untested' | 'inactive';

// GET /api/super-admin/notification-audit/users?organisationId=&search=&state=&page=&limit=
// state: all | no_device | has_device | push_disabled | failing | stale
export const getAuditUsers = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const organisationId = str(req.query.organisationId);
        const search = str(req.query.search);
        const state = str(req.query.state) || 'all';
        const userId = str(req.query.userId);
        const includeInactive = req.query.includeInactive === 'true';
        const { page, limit, skip } = paging(req.query);
        const since = new Date(Date.now() - DAY_MS);
        const staleBefore = new Date(Date.now() - STALE_DEVICE_DAYS * DAY_MS);

        const and: Prisma.UserWhereInput[] = [];
        if (search) {
            and.push({ OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } }
            ] });
        }
        if (state === 'no_device') and.push({ devices: { none: {} }, fcmToken: null });
        if (state === 'has_device') and.push({ OR: [{ devices: { some: {} } }, { fcmToken: { not: null } }] });
        if (state === 'push_disabled') and.push({ notificationPreferences: { path: ['pushNotifications'], equals: false } });
        if (state === 'stale') and.push({ devices: { some: {} }, NOT: { devices: { some: { lastSeenAt: { gte: staleBefore } } } } });
        if (state === 'failing') {
            const failing = await prisma.pushDeliveryLog.groupBy({
                by: ['userId'], where: { status: 'failed', createdAt: { gte: since } }
            });
            and.push({ id: { in: failing.map((f) => f.userId) } });
        }

        const where: Prisma.UserWhereInput = {
            isDeleted: false,
            ...(includeInactive || userId ? {} : { isActive: true }),
            ...(userId ? { id: userId } : {}),
            ...(organisationId ? { organisationId } : {}),
            ...(and.length ? { AND: and } : {})
        };

        const [total, users] = await Promise.all([
            prisma.user.count({ where }),
            prisma.user.findMany({
                where,
                orderBy: [{ organisation: { name: 'asc' } }, { firstName: 'asc' }],
                skip,
                take: limit,
                select: {
                    id: true, firstName: true, lastName: true, email: true, role: true, isActive: true,
                    lastLogin: true, fcmToken: true, fcmTokenUpdatedAt: true, notificationPreferences: true,
                    organisationId: true, organisation: { select: { name: true } },
                    devices: { select: { id: true, platform: true, createdAt: true, lastSeenAt: true } }
                }
            })
        ]);

        const ids = users.map((u) => u.id);
        const [notif24, unread, logs24, lastLogs] = ids.length === 0 ? [[], [], [], []] : await Promise.all([
            prisma.notification.groupBy({ by: ['recipientId'], where: { recipientId: { in: ids }, createdAt: { gte: since } }, _count: { _all: true } }),
            prisma.notification.groupBy({ by: ['recipientId'], where: { recipientId: { in: ids }, isRead: false }, _count: { _all: true } }),
            prisma.pushDeliveryLog.groupBy({ by: ['userId', 'status'], where: { userId: { in: ids }, createdAt: { gte: since } }, _count: { _all: true } }),
            prisma.$queryRaw<{ userId: string; status: string; errorCode: string | null; createdAt: Date }[]>(Prisma.sql`
                SELECT DISTINCT ON ("userId") "userId", status, "errorCode", "createdAt"
                FROM "PushDeliveryLog" WHERE "userId" = ANY(${ids}::text[])
                ORDER BY "userId", "createdAt" DESC`)
        ]);

        const n24 = new Map(notif24.map((r: any) => [r.recipientId, r._count._all]));
        const unr = new Map(unread.map((r: any) => [r.recipientId, r._count._all]));
        const lastBy = new Map(lastLogs.map((r: any) => [r.userId, r]));
        const pushBy = (uid: string, s: string) => (logs24 as any[]).find((r) => r.userId === uid && r.status === s)?._count._all ?? 0;

        const rows = users.map((u) => {
            const prefs = u.notificationPreferences as any;
            const pushDisabled = prefs?.pushNotifications === false;
            const deviceCount = u.devices.length + (u.fcmToken && u.devices.length === 0 ? 1 : 0);
            const lastSeen = u.devices.reduce<Date | null>((m, d) => (!m || d.lastSeenAt > m ? d.lastSeenAt : m), null)
                ?? u.fcmTokenUpdatedAt ?? null;
            const last = lastBy.get(u.id) as any;

            let health: Health;
            if (!u.isActive) health = 'inactive';
            else if (pushDisabled) health = 'push_disabled';
            else if (deviceCount === 0) health = 'no_device';
            else if (last?.status === 'failed') health = 'failing';
            else if (lastSeen && lastSeen < staleBefore) health = 'stale_device';
            else if (!last) health = 'untested';
            else health = 'healthy';

            return {
                id: u.id,
                name: fullName(u),
                email: u.email,
                role: u.role,
                isActive: u.isActive,
                organisationId: u.organisationId,
                organisationName: u.organisation?.name ?? null,
                lastLogin: u.lastLogin,
                pushDisabled,
                deviceCount,
                lastDeviceSeen: lastSeen,
                notifications24h: n24.get(u.id) ?? 0,
                unread: unr.get(u.id) ?? 0,
                push24h: { sent: pushBy(u.id, 'sent'), failed: pushBy(u.id, 'failed'), skipped: pushBy(u.id, 'skipped') },
                lastPush: last ? { status: last.status, errorCode: last.errorCode, at: last.createdAt } : null,
                health
            };
        });

        res.json({ users: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
    } catch (error) {
        console.error('getAuditUsers Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/notification-audit/users/:id
export const getAuditUserDetail = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const { id } = req.params;
        const user = await prisma.user.findUnique({
            where: { id },
            select: {
                id: true, firstName: true, lastName: true, email: true, role: true, isActive: true, lastLogin: true,
                notificationPreferences: true, fcmToken: true, fcmTokenUpdatedAt: true,
                organisationId: true, organisation: { select: { name: true } },
                devices: { orderBy: { lastSeenAt: 'desc' } }
            }
        });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const [notifications, logs, unread, total] = await Promise.all([
            prisma.notification.findMany({
                where: { recipientId: id }, orderBy: { createdAt: 'desc' }, take: 25,
                select: { id: true, title: true, message: true, type: true, isRead: true, createdAt: true }
            }),
            prisma.pushDeliveryLog.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
            prisma.notification.count({ where: { recipientId: id, isRead: false } }),
            prisma.notification.count({ where: { recipientId: id } })
        ]);

        const registered = new Set(user.devices.map((d) => d.token));
        res.json({
            user: {
                id: user.id, name: fullName(user), email: user.email, role: user.role, isActive: user.isActive,
                lastLogin: user.lastLogin, organisationId: user.organisationId, organisationName: user.organisation?.name ?? null,
                notificationPreferences: user.notificationPreferences,
                pushDisabled: (user.notificationPreferences as any)?.pushNotifications === false
            },
            devices: [
                ...user.devices.map((d) => ({
                    id: d.id, tokenSuffix: tokenSuffix(d.token), platform: d.platform,
                    createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, legacy: false
                })),
                ...(user.fcmToken && !registered.has(user.fcmToken)
                    ? [{ id: null, tokenSuffix: tokenSuffix(user.fcmToken), platform: null, createdAt: user.fcmTokenUpdatedAt, lastSeenAt: user.fcmTokenUpdatedAt, legacy: true }]
                    : [])
            ],
            counts: { notifications: total, unread },
            notifications,
            logs
        });
    } catch (error) {
        console.error('getAuditUserDetail Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/notification-audit/notifications
// Live view of the Notification table. Filters: organisationId, userId, type, isRead, search, from, to.
export const getAuditNotifications = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const organisationId = str(req.query.organisationId);
        const userId = str(req.query.userId);
        const type = str(req.query.type);
        const search = str(req.query.search);
        const isRead = req.query.isRead === 'true' ? true : req.query.isRead === 'false' ? false : undefined;
        const { page, limit, skip } = paging(req.query);

        const where: Prisma.NotificationWhereInput = {
            ...(userId ? { recipientId: userId } : {}),
            ...(organisationId ? { recipient: { organisationId } } : {}),
            ...(type ? { type } : {}),
            ...(isRead !== undefined ? { isRead } : {}),
            ...(dateRange(req.query) ? { createdAt: dateRange(req.query) } : {}),
            ...(search ? { OR: [
                { title: { contains: search, mode: 'insensitive' } },
                { message: { contains: search, mode: 'insensitive' } }
            ] } : {})
        };

        const [total, rows] = await Promise.all([
            prisma.notification.count({ where }),
            prisma.notification.findMany({
                where, orderBy: { createdAt: 'desc' }, skip, take: limit,
                select: { id: true, title: true, message: true, type: true, severity: true, isRead: true, createdAt: true, recipientId: true, relatedResource: true, relatedId: true }
            })
        ]);

        const [users, pushRows] = await Promise.all([
            userInfoMap(rows.map((r) => r.recipientId)),
            rows.length ? prisma.pushDeliveryLog.findMany({
                where: { notificationId: { in: rows.map((r) => r.id) } },
                select: { notificationId: true, status: true, errorCode: true }
            }) : Promise.resolve([])
        ]);
        const pushBy = new Map<string, { sent: number; failed: number; skipped: number; errorCode: string | null }>();
        pushRows.forEach((p) => {
            const k = p.notificationId!;
            const e = pushBy.get(k) ?? { sent: 0, failed: 0, skipped: 0, errorCode: null };
            (e as any)[p.status] += 1;
            if (p.errorCode) e.errorCode = p.errorCode;
            pushBy.set(k, e);
        });

        res.json({
            notifications: rows.map((r) => ({ ...r, recipient: users.get(r.recipientId) ?? null, push: pushBy.get(r.id) ?? null })),
            total, page, pages: Math.max(1, Math.ceil(total / limit))
        });
    } catch (error) {
        console.error('getAuditNotifications Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/notification-audit/logs
// Filters: organisationId, userId, status, errorCode, source, search(title), from, to.
export const getAuditLogs = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const organisationId = str(req.query.organisationId);
        const userId = str(req.query.userId);
        const status = str(req.query.status);
        const errorCode = str(req.query.errorCode);
        const source = str(req.query.source);
        const search = str(req.query.search);
        const { page, limit, skip } = paging(req.query);

        const where: Prisma.PushDeliveryLogWhereInput = {
            ...(organisationId ? { organisationId } : {}),
            ...(userId ? { userId } : {}),
            ...(status ? { status } : {}),
            ...(errorCode ? { errorCode } : {}),
            ...(source ? { source } : {}),
            ...(dateRange(req.query) ? { createdAt: dateRange(req.query) } : {}),
            ...(search ? { title: { contains: search, mode: 'insensitive' } } : {})
        };

        const [total, rows] = await Promise.all([
            prisma.pushDeliveryLog.count({ where }),
            prisma.pushDeliveryLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit })
        ]);
        const users = await userInfoMap(rows.map((r) => r.userId));

        res.json({
            logs: rows.map((r) => ({ ...r, user: users.get(r.userId) ?? null })),
            total, page, pages: Math.max(1, Math.ceil(total / limit))
        });
    } catch (error) {
        console.error('getAuditLogs Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/super-admin/notification-audit/devices
// Filters: organisationId, userId, platform, state (all | stale | fresh), search.
export const getAuditDevices = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const organisationId = str(req.query.organisationId);
        const userId = str(req.query.userId);
        const platform = str(req.query.platform);
        const state = str(req.query.state) || 'all';
        const search = str(req.query.search);
        const { page, limit, skip } = paging(req.query);
        const staleBefore = new Date(Date.now() - STALE_DEVICE_DAYS * DAY_MS);

        const where: Prisma.UserDeviceWhereInput = {
            ...(userId ? { userId } : {}),
            ...(platform ? (platform === 'unknown' ? { platform: null } : { platform }) : {}),
            ...(state === 'stale' ? { lastSeenAt: { lt: staleBefore } } : state === 'fresh' ? { lastSeenAt: { gte: staleBefore } } : {}),
            user: {
                ...(organisationId ? { organisationId } : {}),
                ...(search ? { OR: [
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } }
                ] } : {})
            }
        };

        const [total, rows] = await Promise.all([
            prisma.userDevice.count({ where }),
            prisma.userDevice.findMany({
                where, orderBy: { lastSeenAt: 'desc' }, skip, take: limit,
                select: {
                    id: true, token: true, platform: true, createdAt: true, lastSeenAt: true, userId: true,
                    user: { select: { firstName: true, lastName: true, email: true, isActive: true, organisationId: true, organisation: { select: { name: true } } } }
                }
            })
        ]);

        res.json({
            devices: rows.map((d) => ({
                id: d.id, tokenSuffix: tokenSuffix(d.token), platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
                stale: d.lastSeenAt < staleBefore,
                user: { id: d.userId, name: fullName(d.user), email: d.user.email, isActive: d.user.isActive, organisationId: d.user.organisationId, organisationName: d.user.organisation?.name ?? null }
            })),
            total, page, pages: Math.max(1, Math.ceil(total / limit)), staleAfterDays: STALE_DEVICE_DAYS
        });
    } catch (error) {
        console.error('getAuditDevices Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// DELETE /api/super-admin/notification-audit/devices/:id
// Removes one registered device (e.g. a dead/stale token). The user re-registers it on next app launch.
export const deleteAuditDevice = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const device = await prisma.userDevice.findUnique({ where: { id: req.params.id } });
        if (!device) return res.status(404).json({ message: 'Device not found' });
        await prisma.userDevice.delete({ where: { id: device.id } });
        await prisma.user.updateMany({ where: { id: device.userId, fcmToken: device.token }, data: { fcmToken: null, fcmTokenUpdatedAt: null } });
        res.json({ message: 'Device removed' });
    } catch (error) {
        console.error('deleteAuditDevice Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/super-admin/notification-audit/users/:id/test-push   body: { dryRun?: boolean }
// dryRun=true asks FCM to validate every token WITHOUT delivering anything to the phone.
// dryRun=false delivers a real test notification to every registered device of that user.
export const testUserPush = async (req: Request, res: Response) => {
    try {
        if (!requireSuperAdmin(req, res)) return;
        const dryRun = req.body?.dryRun !== false;
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            select: { id: true, organisationId: true, fcmToken: true, devices: { select: { token: true, platform: true } } }
        });
        if (!user) return res.status(404).json({ message: 'User not found' });

        const tokens = new Map<string, string | null>(user.devices.map((d) => [d.token, d.platform] as [string, string | null]));
        if (user.fcmToken && !tokens.has(user.fcmToken)) tokens.set(user.fcmToken, null);

        if (tokens.size === 0) {
            return res.json({ dryRun, fcmConfigured: isPushConfigured(), results: [], message: 'This user has no registered device - nothing to deliver to.' });
        }

        const title = 'PypeCRM test notification';
        const results = await Promise.all(Array.from(tokens.entries()).map(async ([token, platform]) => {
            const r = await deliverPush(token, { title, body: 'If you can see this, push notifications reach this phone.', data: { type: 'info' } }, { dryRun });
            return { token, platform, r };
        }));

        await recordPushLogs(results.map(({ token, platform, r }) => ({
            userId: user.id, organisationId: user.organisationId, title: dryRun ? `${title} (validation only)` : title, type: 'info',
            source: dryRun ? 'validate' : 'test', token, platform,
            status: r.ok ? 'sent' : 'failed', errorCode: r.errorCode, errorMessage: r.errorMessage, messageId: r.messageId, latencyMs: r.latencyMs
        })));

        res.json({
            dryRun,
            fcmConfigured: isPushConfigured(),
            results: results.map(({ token, platform, r }) => ({
                tokenSuffix: tokenSuffix(token), platform, ok: r.ok, errorCode: r.errorCode ?? null,
                errorMessage: r.errorMessage ?? null, messageId: r.messageId ?? null, latencyMs: r.latencyMs, deadToken: !!r.invalidToken
            }))
        });
    } catch (error) {
        console.error('testUserPush Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
