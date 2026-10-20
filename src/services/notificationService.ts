
import prisma from '../config/prisma';
import { sendPushNotification } from '../config/firebaseAdmin';
import { getIO } from '../socket';
import { EmailService } from './emailService';
import { WhatsAppService } from './whatsAppService';

// Singleton helper to get IO instance if not exported globally
// Assuming socket.ts exports initSocket and returns io instance, 
// but we might need a way to access it here. 
// Standard pattern: store io in app.set('io') and access via req, 
// OR export a getter from socket.ts.

// Let's update socket.ts to export a getter first, or use a global variable pattern.
// For now, I'll rely on a getter I will add to socket.ts.

export class NotificationService {
    static async send(
        recipientId: string,
        title: string,
        message: string,
        type: string = 'info',
        related?: { resource: string; id?: string }
    ) {
        try {
            // 1. Save to Database
            const notification = await prisma.notification.create({
                data: {
                    recipientId,
                    title,
                    message,
                    type,
                    isRead: false,
                    relatedResource: related?.resource,
                    relatedId: related?.id
                }
            });

            // 2. Emit Real-time Event
            const io = getIO();
            if (io) {
                io.to(recipientId).emit('notification', notification);
            } else {
                console.warn('[NotificationService] Socket IO not initialized');
            }

            // 3. Push Notification (FCM) — fired for every type, not just
            // high_priority/alert/reminder like the email/WhatsApp fallback
            // below: a push is the mobile equivalent of the in-app bell,
            // not an escalation channel, so it should fire whenever a
            // Notification row is created, matching what the mobile app's
            // registered `fcmToken` is actually for.
            const pushUser = await prisma.user.findUnique({
                where: { id: recipientId },
                select: { fcmToken: true, notificationPreferences: true }
            });
            const pushPrefs = pushUser?.notificationPreferences as any;
            if (pushUser?.fcmToken && pushPrefs?.pushNotifications !== false) {
                // Fire-and-forget: never let a push failure block or fail
                // the notification the DB/socket/email paths already
                // succeeded at. `sendPushNotification` itself never throws.
                sendPushNotification(recipientId, pushUser.fcmToken, {
                    title,
                    body: message,
                    data: {
                        type,
                        ...(related?.resource ? { relatedResource: related.resource } : {}),
                        ...(related?.id ? { relatedId: related.id } : {})
                    }
                }).catch((err) => console.error('[NotificationService] Unexpected push error:', err));
            }

            // 4. Email Fallback
            if (type === 'high_priority' || type === 'alert' || type === 'reminder') {
                const user = await prisma.user.findUnique({
                    where: { id: recipientId },
                    select: { email: true, phone: true, organisationId: true, notificationPreferences: true, firstName: true }
                });

                const prefs = user?.notificationPreferences as any;

                // Email Fallback
                if (user?.email && prefs?.emailNotifications !== false) {
                    const emailHtml = `
                        <div style="font-family: sans-serif; padding: 20px;">
                            <h2>${title}</h2>
                            <p>Hi ${user.firstName},</p>
                            <p>${message}</p>
                            <hr />
                            <small>You received this because email notifications are enabled in your CRM settings.</small>
                        </div>
                    `;
                    await EmailService.sendEmail(user.email, `Notification: ${title}`, emailHtml);
                }

                // WhatsApp Integration
                if (user?.phone && user?.organisationId && prefs?.whatsAppNotifications === true) {
                    try {
                        const waClient = await WhatsAppService.getClientForOrg(user.organisationId);
                        if (waClient) {
                            // Format number (remove + if exists for the API call, though waClient might handle it)
                            const cleanPhone = user.phone.replace(/\D/g, '');
                            await waClient.sendTextMessage(cleanPhone, `*${title}*\n\n${message}`);
                            console.log(`[NotificationService] WhatsApp sent to ${cleanPhone}`);
                        }
                    } catch (waError) {
                        console.error('[NotificationService] WhatsApp send failed:', waError);
                    }
                }
            }

            return notification;
        } catch (error) {
            console.error('[NotificationService] Error sending notification:', error);
            throw error;
        }
    }

    static async sendToOrganisation(orgId: string, title: string, message: string, type: string = 'info') {
        // Send to all active users in an organisation
        const users = await prisma.user.findMany({
            where: { organisationId: orgId, isActive: true },
            select: { id: true }
        });

        const promises = users.map(user => this.send(user.id, title, message, type));
        await Promise.all(promises);
    }

    static async sendToHierarchy(startUserId: string, title: string, message: string, type: string = 'info') {
        try {
            const user = await prisma.user.findUnique({
                where: { id: startUserId },
                select: { reportsToId: true }
            });

            if (user && user.reportsToId) {
                const managerId = user.reportsToId;
                await this.send(managerId, title, message, type);
                // Recursive call for next level
                await this.sendToHierarchy(managerId, title, message, type);
            }
        } catch (error) {
            console.error('[NotificationService] Error sending to hierarchy:', error);
        }
    }
}
