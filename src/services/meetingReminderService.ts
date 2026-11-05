import prisma from '../config/prisma';
import { NotificationService } from './notificationService';

/**
 * Checks for meetings scheduled within the next 24 hours
 * and creates reminder notifications for the creator and their hierarchy.
 * 
 * This should be called periodically (e.g., via cron job, or on server startup).
 */
export const generateMeetingReminders = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in23Hours = new Date(now.getTime() + 23 * 60 * 60 * 1000); // Window to avoid duplicates

    console.log(`[MeetingReminder] Checking for meetings between ${in23Hours.toISOString()} and ${in24Hours.toISOString()}`);

    // Find meetings starting in ~24 hours that haven't been notified
    const upcomingMeetings = await prisma.calendarEvent.findMany({
        where: {
            type: 'meeting',
            isDeleted: false,
            status: 'scheduled',
            startTime: {
                gte: in23Hours,
                lt: in24Hours
            }
        },
        include: {
            createdBy: {
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    reportsToId: true
                }
            },
            lead: {
                select: { firstName: true, lastName: true }
            }
        }
    });

    console.log(`[MeetingReminder] Found ${upcomingMeetings.length} meetings requiring notifications`);

    for (const meeting of upcomingMeetings) {
        const notifyUserIds: string[] = [];

        // 1. Add the creator
        if (meeting.createdById) {
            notifyUserIds.push(meeting.createdById);
        }

        // 2. Add the hierarchy (managers up the chain)
        if (meeting.createdBy?.reportsToId) {
            let currentManagerId: string | null = meeting.createdBy.reportsToId;
            let depth = 0;
            const maxDepth = 5; // Safety limit

            while (currentManagerId && depth < maxDepth) {
                notifyUserIds.push(currentManagerId);

                const manager: { reportsToId: string | null } | null = await prisma.user.findUnique({
                    where: { id: currentManagerId },
                    select: { reportsToId: true }
                });

                currentManagerId = manager?.reportsToId || null;
                depth++;
            }
        }

        // 3. Create notifications for each user
        const leadName = meeting.lead
            ? `${meeting.lead.firstName} ${meeting.lead.lastName}`
            : 'Unknown';

        for (const userId of notifyUserIds) {
            // Check if notification already exists (to avoid duplicates)
            const existing = await prisma.notification.findFirst({
                where: {
                    recipientId: userId,
                    relatedResource: 'CalendarEvent',
                    relatedId: meeting.id,
                    title: { contains: 'Upcoming Meeting' }
                }
            });

            if (!existing) {
                await prisma.notification.create({
                    data: {
                        title: 'Upcoming Meeting Tomorrow',
                        message: `Meeting with ${leadName}: "${meeting.title}" scheduled for ${new Date(meeting.startTime).toLocaleString()}`,
                        type: 'reminder',
                        relatedResource: 'CalendarEvent',
                        relatedId: meeting.id,
                        recipientId: userId
                    }
                });
                NotificationService.pushToUser(userId, 'Upcoming Meeting Tomorrow', `Meeting with ${leadName}: "${meeting.title}" scheduled for ${new Date(meeting.startTime).toLocaleString()}`, 'reminder', { resource: 'CalendarEvent', id: meeting.id }).catch(() => {});
                console.log(`[MeetingReminder] Created notification for user ${userId} for meeting ${meeting.id}`);
            }
        }
    }

    return upcomingMeetings.length;
};

/**
 * Alternative: On-demand check when user loads dashboard/notifications.
 * This function can be called from a controller.
 */
export const checkUserMeetingReminders = async (userId: string) => {
    const now = new Date();
    const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    // Find meetings the user created that are coming up
    const upcomingMeetings = await prisma.calendarEvent.findMany({
        where: {
            createdById: userId,
            type: 'meeting',
            isDeleted: false,
            status: 'scheduled',
            startTime: {
                gte: now,
                lt: in48Hours
            }
        },
        include: {
            lead: { select: { firstName: true, lastName: true } }
        },
        orderBy: { startTime: 'asc' }
    });

    return upcomingMeetings;
};
