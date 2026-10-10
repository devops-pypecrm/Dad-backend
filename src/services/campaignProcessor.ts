import prisma from '../config/prisma';
import { WhatsAppService } from './whatsAppService';
import { EmailService } from './emailService';
import { logger } from '../utils/logger';


interface CampaignStats {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    replied: number;
    [key: string]: any; // Add index signature for Prisma JSON compatibility
}

export class CampaignProcessor {
    /**
     * Process a WhatsApp campaign. Implemented in WhatsAppCampaignService
     * (template-only, consent-checked, tier-aware); kept here so existing callers still work.
     */
    static async processWhatsAppCampaign(campaignId: string): Promise<void> {
        const { WhatsAppCampaignService } = await import('./whatsAppCampaignService');
        await WhatsAppCampaignService.process(campaignId);
    }

    /**
     * Process Email campaign with batch sending
     */
    static async processEmailCampaign(campaignId: string): Promise<void> {
        try {
            logger.info(`Starting email campaign ${campaignId}`, 'CampaignProcessor');

            const campaign = await prisma.campaign.findUnique({
                where: { id: campaignId },
                include: {
                    organisation: true,
                    createdBy: true,
                    emailList: true
                }
            });

            if (!campaign) throw new Error('Campaign not found');
            if (campaign.status === 'completed' || campaign.status === 'failed') {
                throw new Error(`Campaign is already in ${campaign.status} state`);
            }

            // Get recipients - Filter by emailList if provided, otherwise fallback to all leads with emails
            const recipients = await prisma.lead.findMany({
                where: {
                    organisationId: campaign.organisationId,
                    isDeleted: false,
                    email: { not: null },
                    ...(campaign.emailListId ? {
                        emailLists: {
                            some: { id: campaign.emailListId }
                        }
                    } : {})
                },
                select: { id: true, email: true, firstName: true, lastName: true, company: true }
            });

            if (recipients.length === 0) throw new Error('No recipients found with valid email addresses');

            logger.info(`Found ${recipients.length} recipients for email campaign`, 'CampaignProcessor', undefined, campaign.organisationId);

            const stats = { sent: 0, failed: 0 };

            await prisma.campaign.update({
                where: { id: campaignId },
                data: { status: 'sending', sentAt: new Date() }
            });

            const batchSize = 10;
            for (let i = 0; i < recipients.length; i += batchSize) {
                const batch = recipients.slice(i, i + batchSize);
                await Promise.all(batch.map(async (recipient) => {
                    try {
                        const personalizedBody = EmailService.personalize(campaign.content, {
                            firstName: recipient.firstName,
                            lastName: recipient.lastName,
                            company: recipient.company
                        });

                        const sent = await EmailService.sendEmail(
                            recipient.email!,
                            campaign.subject,
                            personalizedBody,
                            campaign.organisationId,
                            campaign.createdById || undefined,
                            { leadId: recipient.id }
                        );

                        if (sent) stats.sent++; else stats.failed++;
                    } catch (err) {
                        logger.error(`Failed to send email to ${recipient.email}:`, err);
                        stats.failed++;
                    }
                }));

                // Update intermediate stats
                await prisma.campaign.update({
                    where: { id: campaignId },
                    data: { stats: stats as any }
                });

                // Throttle to avoid hitting mail server limits
                if (i + batchSize < recipients.length) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            await prisma.campaign.update({
                where: { id: campaignId },
                data: {
                    status: stats.failed === 0 ? 'sent' : 'partially_failed',
                    stats: stats as any
                }
            });

            logger.info(`Email campaign ${campaignId} completed`, 'CampaignProcessor', undefined, campaign.organisationId, { stats });

        } catch (error) {
            logger.error(`Error processing email campaign ${campaignId}`, error, 'CampaignProcessor');
            await prisma.campaign.update({
                where: { id: campaignId },
                data: { status: 'failed', stats: { error: (error as Error).message } as any }
            }).catch(console.error);
        }
    }

    /**
     * Recompute WhatsApp campaign statistics after a delivery status webhook.
     * Counts come straight from the message rows, so they can't drift or double-count.
     */
    static async updateCampaignStats(messageId: string, _newStatus: string): Promise<void> {
        try {
            const message = await prisma.whatsAppMessage.findUnique({ where: { id: messageId }, select: { campaignId: true } });
            if (!message?.campaignId) return;
            const { WhatsAppCampaignService } = await import('./whatsAppCampaignService');
            await WhatsAppCampaignService.refreshStats(message.campaignId);
        } catch (error) {
            logger.error('Error updating campaign stats', error, 'CampaignProcessor');
        }
    }
}
