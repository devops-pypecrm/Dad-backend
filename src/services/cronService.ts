import cron from 'node-cron';
import { TrashService } from './trashService';
import { cronPrisma } from '../config/prisma';
import { runShuffler } from './shuffler-module/shufflerService';
import { runIssueRetentionCleanup } from './issueCleanupService';
import { initWhatsAppScheduler } from './whatsAppScheduler';

export const initCronJobs = () => {
    // Database Keep-Alive: a lightweight SELECT 1 every 5 minutes to prevent
    // idle connection reaping. Using cronPrisma (3-connection pool) so this
    // never competes with API traffic.
    cron.schedule('*/5 * * * *', async () => {
        try {
            await cronPrisma.$executeRawUnsafe('SELECT 1');
        } catch (error) {
            console.error('[Cron] Database keep-alive ping failed:', error);
        }
    });

    // Run every day at midnight (00:00)
    cron.schedule('0 0 * * *', async () => {
        console.log('[Cron] Daily lead rollover is disabled (keeping original follow-up dates unchanged).');

        console.log('[Cron] Running daily license expiry check...');
        try {
            const { LicenseEnforcementService } = await import('./licenseEnforcementService');
            await LicenseEnforcementService.enforceExpiry();
        } catch (error) {
            console.error('[Cron] Error running license expiry check:', error);
        }

        console.log('[Cron] Running daily sales target expiration check...');
        try {
            const { SalesTargetService } = await import('./salesTargetService');
            await SalesTargetService.checkExpiredTargets();
        } catch (error) {
            console.error('[Cron] Error running sales target expiration check:', error);
        }

        // EMI Overdue Detection
        console.log('[Cron] Running EMI overdue status update...');
        try {
            const EMIService = (await import('./emiService')).default;
            await EMIService.updateOverdueStatus();
        } catch (error) {
            console.error('[Cron] Error running EMI overdue update:', error);
        }
    });

    console.log('[Cron] Daily lead rollover job scheduled.');

    // Run every day at 08:00 AM (Daily Task Reminders)
    cron.schedule('0 8 * * *', async () => {
        console.log('[Cron] Running daily task reminders...');
        try {
            const { TaskReminderService } = await import('./taskReminderService');
            await TaskReminderService.sendDailyReminders();
        } catch (error) {
            console.error('[Cron] Error running task reminders:', error);
        }
    });

    // Run every hour for Meeting Reminders
    cron.schedule('0 * * * *', async () => {
        console.log('[Cron] Running meeting reminders check...');
        try {
            const { generateMeetingReminders } = await import('./meetingReminderService');
            await generateMeetingReminders();
        } catch (error) {
            console.error('[Cron] Error running meeting reminders:', error);
        }
    });

    // Run every 15 minutes for Follow-up Reminders
    cron.schedule('*/15 * * * *', async () => {
        console.log('[Cron] Running upcoming follow-up check...');
        try {
            const { FollowUpNotificationService } = await import('./followUpNotificationService');
            await FollowUpNotificationService.notifyUpcomingFollowUps();
        } catch (error) {
            console.error('[Cron] Error running follow-up reminders:', error);
        }
    });

    // Run every minute for Dynamic Daily Reports
    cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

            const organisations = await cronPrisma.organisation.findMany({
                where: {
                    status: 'active',
                    dailyReportTime: currentTime,
                    isDeleted: false
                }
            });

            if (organisations.length === 0) return;

            console.log(`[Cron] Found ${organisations.length} organisations with report time ${currentTime}`);

            const { ReportingService } = await import('./reportingService');
            const { WhatsAppService } = await import('./whatsAppService');
            const { EmailService } = await import('./emailService');

            for (const org of organisations) {
                try {
                    // 1. General Admin Report (Legacy logic)
                    const admins = await cronPrisma.user.findMany({
                        where: { organisationId: org.id, role: 'admin', isActive: true }
                    });

                    const stats = await ReportingService.getDailyStats(org.id);
                    const adminReport = ReportingService.formatWhatsAppReport(stats, org.name);

                    // 2. Manager & Sales Manager Reports
                    const managers = await cronPrisma.user.findMany({
                        where: {
                            organisationId: org.id,
                            role: { in: ['manager', 'sales_manager'] },
                            isActive: true
                        }
                    });

                    const waClient = await WhatsAppService.getClientForOrg(org.id);

                    // Send to Admins
                    for (const admin of admins) {
                        const targetPhone = admin.phone || org.contactPhone;
                        
                        // WhatsApp
                        if (targetPhone && waClient) {
                            console.log(`[Cron] Sending general WhatsApp report to ${org.name} admin: ${admin.firstName} (${targetPhone})`);
                            await waClient.sendTextMessage(targetPhone, adminReport);
                        }
                    }

                    // Email Report (to Contact Email)
                    if (org.dailyReportEmailEnabled && org.contactEmail) {
                        console.log(`[Cron] Sending daily Email report to ${org.name} contact email: ${org.contactEmail}`);
                        const emailHtml = ReportingService.formatEmailReport(stats, org.name);
                        await EmailService.sendEmail(
                            org.contactEmail,
                            `Daily Business Report - ${org.name}`,
                            emailHtml,
                            org.id
                        );
                    }

                    // Send to Managers (Specific reports)
                    for (const manager of managers) {
                        const targetPhone = manager.phone;
                        if (targetPhone && waClient) {
                            const managerStats = await ReportingService.getManagerDailyStats(manager.id, org.id);
                            const managerReport = ReportingService.formatManagerReport(managerStats, manager.firstName);
                            console.log(`[Cron] Sending manager report to ${org.name} manager: ${manager.firstName} (${targetPhone})`);
                            await waClient.sendTextMessage(targetPhone, managerReport);
                        }
                    }

                    // 3. Gupshup daily business summary — shared platform account, always-on
                    // whenever Contact Phone is set. Independent of the two flows above.
                    if (org.contactPhone) {
                        try {
                            const { gupshupService, sendDailySummaryViaGupshup } = await import('./gupshupService');
                            if (gupshupService.isConfigured()) {
                                await sendDailySummaryViaGupshup(org.id, org.name, org.contactPhone);
                            }
                        } catch (gupshupError) {
                            console.error(`[Cron] Error sending Gupshup daily summary for ${org.name}:`, gupshupError);
                        }
                    }
                } catch (orgError) {
                    console.error(`[Cron] Error generating daily reports for ${org.name}:`, orgError);
                }
            }
        } catch (error) {
            console.error('[Cron] Error running daily reports processor:', error);
        }
    });

    console.log('[Cron] Dynamic daily reports processor scheduled.');

    // Run every minute for Workflow Queue
    cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const pendingItems = await cronPrisma.workflowQueue.findMany({
                where: {
                    status: 'pending',
                    executeAt: { lte: now }
                },
                take: 50 // process in batches
            });

            if (pendingItems.length > 0) {
                console.log(`[Cron] Found ${pendingItems.length} pending workflow items ready to execute.`);

                // Dynamically import to avoid circular dependency issues if any
                const { WorkflowEngine } = await import('./workflowEngine');

                for (const item of pendingItems) {
                    // Fire and forget or sequential?
                    // Sequential to simplify load, or promise.all
                    await WorkflowEngine.resumeWorkflow(item.id);
                }
            }
        } catch (error) {
            console.error('[Cron] Error processing workflow queue:', error);
        }
    });

    console.log('[Cron] Workflow Queue processor scheduled.');

    // Run every day at 01:00 AM (Data Retention & Cleanup)
    cron.schedule('0 1 * * *', async () => {
        console.log('[Cron] Running daily cleanup tasks...');
        try {
            const now = new Date();

            // 1. Audit Log Retention (90 Days)
            const ninetyDaysAgo = new Date(now);
            ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
            
            let totalLogsDeleted = 0;
            while (true) {
                const logsToDelete = await cronPrisma.auditLog.findMany({
                    where: { createdAt: { lt: ninetyDaysAgo } },
                    select: { id: true },
                    take: 5000
                });
                
                if (logsToDelete.length === 0) break;
                
                const ids = logsToDelete.map(l => l.id);
                const deleted = await cronPrisma.auditLog.deleteMany({
                    where: { id: { in: ids } }
                });
                totalLogsDeleted += deleted.count;
                if (deleted.count > 0) {
                    console.log(`[Cron] Batch deleted ${deleted.count} old audit logs. Total: ${totalLogsDeleted}`);
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            // 2. Notification Retention (Keep only last 14 days, read or unread)
            const fourteenDaysAgo = new Date(now);
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
            
            let totalNotificationsDeleted = 0;
            while (true) {
                const notificationsToDelete = await cronPrisma.notification.findMany({
                    where: { createdAt: { lt: fourteenDaysAgo } },
                    select: { id: true },
                    take: 5000
                });
                
                if (notificationsToDelete.length === 0) break;
                
                const ids = notificationsToDelete.map(n => n.id);
                const deleted = await cronPrisma.notification.deleteMany({
                    where: { id: { in: ids } }
                });
                totalNotificationsDeleted += deleted.count;
                if (deleted.count > 0) {
                    console.log(`[Cron] Batch deleted ${deleted.count} old notifications. Total: ${totalNotificationsDeleted}`);
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }

        } catch (error) {
            console.error('[Cron] Error during daily cleanup:', error);
        }
    });

    console.log('[Cron] Daily cleanup job scheduled.');

    // Run every day at 02:00 AM (Trash Purge - 7 Days)
    cron.schedule('0 2 * * *', async () => {
        try {
            await TrashService.runAutomatedPurge(7);
        } catch (error) {
            console.error('[Cron] Error during trash purge:', error);
        }
    });

    console.log('[Cron] Daily trash purge job scheduled.');

    // Run every day at 02:30 AM (Closed Issue Retention Cleanup)
    cron.schedule('30 2 * * *', async () => {
        try {
            await runIssueRetentionCleanup();
        } catch (error) {
            console.error('[Cron] Error during issue retention cleanup:', error);
        }
    });

    console.log('[Cron] Issue retention cleanup job scheduled.');

    // Run every 30 minutes for Meta Lead Polling (Real-time fallback)
    cron.schedule('*/30 * * * *', async () => {
        try {
            const { MetaPollingService } = await import('./metaPollingService');
            await MetaPollingService.pollAllOrganisations();
        } catch (error) {
            console.error('[Cron] Error during Meta lead polling:', error);
        }
    });

    // Run every day at 04:00 AM (Meta Marketing API ping for App Review compliance -
    // a lightweight, read-only Insights API call per connected ad account, satisfying
    // Meta's own "continuous API usage" requirement for retained Marketing API access)
    cron.schedule('0 4 * * *', async () => {
        try {
            console.log('[Cron] Initiating daily Meta Marketing API ping...');
            const { MetaPollingService } = await import('./metaPollingService');
            await MetaPollingService.pingMetaMarketingAPI();
        } catch (error) {
            console.error('[Cron] Error during Meta Marketing API ping:', error);
        }
    });


    // Run every day at 03:00 AM (Meta Token Expiry Check)
    cron.schedule('0 3 * * *', async () => {
        console.log('[Cron] Checking for expiring or expired Meta tokens...');
        try {
            const now = new Date();
            const sevenDaysFromNow = new Date();
            sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

            const organisations = await cronPrisma.organisation.findMany({
                where: {
                    isDeleted: false,
                    status: 'active'
                }
            });

            for (const org of organisations) {
                const integrations = org.integrations as any;
                
                // Gather ALL connected accounts (metaAccounts array + primary meta field)
                const allAccounts: any[] = [...(integrations?.metaAccounts || [])];
                if (integrations?.meta?.connected) {
                    const alreadyIncluded = allAccounts.some((a: any) => a.pageId === integrations.meta.pageId);
                    if (!alreadyIncluded) allAccounts.push(integrations.meta);
                }

                for (const acc of allAccounts) {
                    if (!acc.connected || !acc.tokenExpiresAt) continue;

                    const expiresAt = new Date(acc.tokenExpiresAt);
                    const daysLeft = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                    const pageName = acc.pageName || acc.pageId || 'Unknown Page';

                    let alertTitle: string | null = null;
                    let alertMsg: string | null = null;

                    if (expiresAt < now) {
                        // ALREADY EXPIRED
                        alertTitle = `❌ Meta Token EXPIRED — ${pageName}`;
                        alertMsg = `Your Meta access token for page "${pageName}" has EXPIRED. Leads are no longer being received! Go to Settings → Integrations and reconnect immediately.`;
                    } else if (expiresAt < sevenDaysFromNow) {
                        // EXPIRING SOON
                        alertTitle = `⚠️ Meta Token Expiring in ${daysLeft} days — ${pageName}`;
                        alertMsg = `Your Meta access token for page "${pageName}" will expire on ${expiresAt.toLocaleDateString()}. Please reconnect in Settings → Integrations to avoid losing leads.`;
                    }

                    if (alertTitle && alertMsg) {
                        // Check if we already sent a notification in the last 24 hours for this page
                        const recentNotif = await cronPrisma.notification.findFirst({
                            where: {
                                organisationId: org.id,
                                title: alertTitle,
                                createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }
                            }
                        });

                        if (!recentNotif) {
                            const admins = await cronPrisma.user.findMany({
                                where: { organisationId: org.id, role: { in: ['admin', 'super_admin'] }, isActive: true }
                            });
                            for (const admin of admins) {
                                await cronPrisma.notification.create({
                                    data: {
                                        title: alertTitle,
                                        message: alertMsg,
                                        type: expiresAt < now ? 'error' : 'warning',
                                        recipientId: admin.id,
                                        organisationId: org.id
                                    }
                                });
                            }
                            console.log(`[Cron] Sent Meta token alert for Org ${org.name} (${pageName}): ${daysLeft} days left`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Cron] Error checking Meta token expiry:', error);
        }
    });

    console.log('[Cron] Meta Lead Polling and Expiry Check jobs scheduled.');

    // Shuffler job – every minute for now

    cron.schedule('* * * * *', async () => {
        try {
            await runShuffler();
        } catch (error) {
            console.error('[Cron] Error running shuffler:', error);
        }
    });
    console.log('[Cron] Shuffler job scheduled.');

    initWhatsAppScheduler();
};
