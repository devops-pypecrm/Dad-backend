import { Request, Response } from 'express';
import { WhatsAppService } from '../services/whatsAppService';
import { WhatsAppIntegrationService } from '../services/whatsAppIntegrationService';
import { GallaboxService } from '../services/gallaboxService';
import prisma from '../config/prisma';
import { getOrgId, getVisibleUserIds } from '../utils/hierarchyUtils';
import { getIO } from '../socket';
import { resolveWhatsAppCredentials } from '../services/whatsAppCredentials';
import { WhatsAppSender, WhatsAppSendError } from '../services/whatsAppSender';
import { WhatsAppTemplateService } from '../services/whatsAppTemplateService';
import { digitsOnly } from '../utils/whatsappPhone';

// Type extension for Request to include user
interface AuthRequest extends Request {
    user?: {
        id: string;
        organisationId: string;
    };
}

import { decrypt } from '../utils/encryption';

export const getWhatsAppConfig = async (req: AuthRequest) => {
    const orgId = getOrgId(req.user);
    if (!orgId) throw new Error('User not authenticated or missing organisation');

    const cred = await resolveWhatsAppCredentials(orgId);
    if (!cred) throw new Error('WhatsApp integration not configured. Please check settings.');

    return { accessToken: cred.accessToken, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId, connected: true, accountId: cred.accountId };
};

/**
 * Legacy send endpoint (used by lead pages and the bulk-send dialog). Delegates to the
 * central sender, so the 24h window, opt-outs and approved-template rules apply everywhere.
 */
export const sendMessage = async (req: AuthRequest, res: Response) => {
    try {
        const { to, message, type = 'text', accountId } = req.body;
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });
        if (!to) return res.status(400).json({ message: 'Phone number (to) is required' });
        if (!/^\+[1-9]\d{1,14}$/.test(to)) return res.status(400).json({ message: 'Phone number must be in international format (+1234567890)' });
        if (type === 'text' && !message) return res.status(400).json({ message: 'Message text is required for text messages' });
        if (type === 'template' && !req.body.templateName) return res.status(400).json({ message: 'Template name is required for template messages' });

        const sanitizedMessage = message ? String(message).trim().substring(0, 4096) : undefined;

        // Accept either explicit `values` or Cloud-API style `components` (body parameters).
        const values: string[] = Array.isArray(req.body.values)
            ? req.body.values.map(String)
            : ((req.body.components || []).find((c: any) => (c.type || '').toLowerCase() === 'body')?.parameters || []).map((p: any) => String(p.text ?? ''));

        try {
            const result = await WhatsAppSender.send({
                organisationId: orgId, to, accountId, source: 'agent', agentId: req.user?.id,
                ...(type === 'template'
                    ? { template: { name: req.body.templateName, language: req.body.languageCode || 'en_US', values } }
                    : { text: sanitizedMessage })
            });
            return res.json({ success: true, result: { messages: [{ id: result.message.waMessageId }] }, conversationId: result.conversationId });
        } catch (err) {
            // Orgs connected only through Gallabox keep their existing text-sending path.
            if (err instanceof WhatsAppSendError && err.code === 'NOT_CONNECTED' && type === 'text') {
                const gallabox = await GallaboxService.getClientForOrg(orgId);
                if (gallabox) {
                    const result = await gallabox.sendWhatsAppMessage(to, sanitizedMessage!);
                    await prisma.whatsAppMessage.create({
                        data: {
                            conversationId: `${digitsOnly(to)}_${orgId}`, phoneNumber: digitsOnly(to), direction: 'outgoing', messageType: 'text',
                            content: { text: sanitizedMessage }, status: 'sent', waMessageId: result.messageId, sentAt: new Date(),
                            organisationId: orgId, agentId: req.user?.id, source: 'agent'
                        }
                    });
                    return res.json({ success: true, result });
                }
            }
            throw err;
        }
    } catch (error: any) {
        if (error instanceof WhatsAppSendError) {
            const status = error.code === 'WINDOW_CLOSED' ? 409 : error.code === 'NOT_CONNECTED' ? 412 : error.code === 'API_ERROR' ? 502 : 400;
            return res.status(status).json({ message: error.message, code: error.code });
        }
        console.error('Error in sendMessage:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getMessages = async (req: AuthRequest, res: Response) => {
    try {
        const user = req.user as any;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const { phoneNumber, limit = 50, offset = 0 } = req.query;

        const visibleUserIds = await getVisibleUserIds(user.id);
        const isOrgAdmin = user.role === 'organisation_admin' || user.role === 'org_admin' || user.role === 'super_admin';

        const where: any = {
            organisationId: orgId,
            isDeleted: false
        };

        if (!isOrgAdmin) {
            where.OR = [
                { agentId: { in: visibleUserIds } },
                { lead: { assignedToId: { in: visibleUserIds } } },
                { lead: { createdById: { in: visibleUserIds } } },
                { contact: { ownerId: { in: visibleUserIds } } },
            ];
        }

        if (phoneNumber) {
            where.phoneNumber = phoneNumber;
        }

        const messages = await prisma.whatsAppMessage.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: Number(limit),
            skip: Number(offset),
            include: {
                agent: {
                    select: { id: true, firstName: true, lastName: true, email: true }
                },
                lead: {
                    select: { id: true, firstName: true, lastName: true, email: true, phone: true }
                },
                contact: {
                    select: { id: true, firstName: true, lastName: true, email: true, phones: true }
                }
            }
        });

        res.json(messages);
    } catch (error: any) {
        console.error('Error in getMessages:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getLeadWhatsAppMessages = async (req: AuthRequest, res: Response) => {
    try {
        const user = req.user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const { leadId } = req.params;
        if (!leadId) return res.status(400).json({ message: 'Lead ID is required' });

        // Get the lead's phone number for matching
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            select: { phone: true, secondaryPhone: true }
        });

        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        // Build exact phone number variants to match using the B-Tree index.
        // Avoids a full-table LIKE scan by querying exact formats stored in the DB.
        const buildPhoneVariants = (phone: string): string[] => {
            const digits = phone.replace(/[^0-9]/g, '');
            const last10 = digits.slice(-10);
            if (last10.length < 10) return [];
            return [...new Set([last10, `+91${last10}`, `91${last10}`, `0${last10}`, phone.trim()])];
        };

        const phoneVariantSet = new Set<string>();
        if (lead.phone) buildPhoneVariants(lead.phone).forEach(v => phoneVariantSet.add(v));
        if (lead.secondaryPhone) buildPhoneVariants(lead.secondaryPhone).forEach(v => phoneVariantSet.add(v));

        const agentSelect = { select: { id: true, firstName: true, lastName: true } } as const;

        // 1a. Fetch by leadId — uses WhatsAppMessage_leadId_idx (fast B-Tree scan)
        const byLeadId = await prisma.whatsAppMessage.findMany({
            where: { organisationId: orgId, isDeleted: false, leadId },
            orderBy: { createdAt: 'desc' },
            take: 100,
            include: { agent: agentSelect }
        });

        // 1b. Fetch by exact phone variants — uses WhatsAppMessage_phoneNumber_idx (fast B-Tree scan).
        // The `OR` below guards against cross-lead/cross-contact leakage: the last-10-digit variant
        // set can collide with a DIFFERENT lead's or contact's number (e.g. a data-entry typo that
        // prepends an extra digit, or messy import formatting) — without this guard, a message
        // already confidently attributed elsewhere (its own `leadId`/`contactId` set to someone
        // else) would get pulled into THIS lead's conversation view too. Only pick up phone-matched
        // messages that have no attribution yet, or that are already attributed to this same lead;
        // never steal one that's already correctly linked to a different lead or contact.
        const byPhone = phoneVariantSet.size > 0
            ? await prisma.whatsAppMessage.findMany({
                where: {
                    organisationId: orgId,
                    isDeleted: false,
                    phoneNumber: { in: Array.from(phoneVariantSet) },
                    OR: [{ leadId: null, contactId: null }, { leadId }]
                },
                orderBy: { createdAt: 'desc' },
                take: 100,
                include: { agent: agentSelect }
            })
            : [];

        // Merge, deduplicate by id, re-sort, cap at 100
        const seen = new Set<string>();
        const waMessages = [...byLeadId, ...byPhone]
            .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 100);

        // 2. Fetch Interaction records with type='whatsapp' 
        const waInteractions = await prisma.interaction.findMany({
            where: {
                leadId,
                type: 'whatsapp',
                isDeleted: false
            },
            orderBy: { date: 'desc' },
            take: 100,
            include: {
                createdBy: { select: { id: true, firstName: true, lastName: true } }
            }
        });

        // Normalize both into a unified format
        const normalized = [
            ...waMessages.map(m => ({
                id: m.id,
                source: 'whatsapp_message' as const,
                direction: m.direction === 'incoming' ? 'inbound' : 'outbound',
                messageType: m.messageType,
                content: (m.content as any)?.text || (m.content as any)?.templateName || m.messageType,
                status: m.status,
                phoneNumber: m.phoneNumber,
                date: m.sentAt || m.createdAt,
                actor: m.agent ? `${m.agent.firstName} ${m.agent.lastName || ''}`.trim() : null
            })),
            ...waInteractions.map(i => ({
                id: i.id,
                source: 'interaction' as const,
                direction: i.direction || 'outbound',
                messageType: 'text',
                content: i.description || i.subject || 'WhatsApp message',
                status: 'logged',
                phoneNumber: i.phoneNumber,
                date: i.date,
                actor: i.createdBy ? `${i.createdBy.firstName} ${i.createdBy.lastName || ''}`.trim() : null,
                subject: i.subject,
                description: i.description,
                duration: i.duration,
                recordingDuration: i.recordingDuration,
                hardwareDuration: i.hardwareDuration,
                callStatus: i.callStatus,
                recordingUrl: i.recordingUrl
            }))
        ];

        const isWhatsAppCall = (msg: any) => {
            const desc = (msg.description || msg.content || '').toLowerCase();
            const subj = (msg.subject || '').toLowerCase();
            return (
                subj.includes('call') ||
                desc.includes('voice call') ||
                desc.includes('video call') ||
                desc.includes('call not connected') ||
                desc.includes('initiated whatsapp call')
            );
        };

        // Determine record priority: ended calls with durations > raw "ongoing" notifications
        const getPriority = (item: any) => {
            const content = (item.content || '').toLowerCase();
            const callStatus = (item.callStatus || '').toLowerCase();
            
            if (content.includes('ongoing') || content.includes('ringing')) {
                return 0;
            }
            
            if (item.source === 'interaction' && (item.duration > 0 || ['completed', 'missed', 'failed', 'rejected'].includes(callStatus))) {
                return 2;
            }
            
            return 1;
        };

        // Sort normalized array by priority descending, then date descending
        normalized.sort((a, b) => {
            const pA = getPriority(a);
            const pB = getPriority(b);
            if (pA !== pB) return pB - pA;
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        });

        // Deduplicate by timestamp proximity (60s for calls, 5s for messages)
        const seenCallKeys = new Set<string>();
        const seenMessageKeys = new Set<string>();

        const deduped = normalized.filter(item => {
            const time = new Date(item.date).getTime();
            if (isWhatsAppCall(item)) {
                // Deduplicate calls within the same 60-second window by direction
                const key = `${item.direction}_${Math.floor(time / 60000)}`;
                if (seenCallKeys.has(key)) return false;
                seenCallKeys.add(key);
                return true;
            } else {
                // Deduplicate messages within the same 5-second window by direction and content
                const key = `${item.direction}_${Math.floor(time / 5000)}_${item.content}`;
                if (seenMessageKeys.has(key)) return false;
                seenMessageKeys.add(key);
                return true;
            }
        });

        // Sanitize call descriptions (e.g. if the call has ended or date is in the past, it's not "ongoing" anymore!)
        const sanitized = deduped.map(item => {
            if (isWhatsAppCall(item)) {
                let content = item.content || '';
                const lowerContent = content.toLowerCase();
                const timeDiffMins = (Date.now() - new Date(item.date).getTime()) / 60000;
                
                if (lowerContent.includes('ongoing voice call') || lowerContent.includes('ongoing video call')) {
                    if (timeDiffMins > 2 || ((item as any).duration && (item as any).duration > 0)) {
                        content = lowerContent.includes('video') ? 'Video call' : 'Voice call';
                    }
                }
                
                return {
                    ...item,
                    content
                };
            }
            return item;
        });

        // Sort by date descending strictly for final output
        sanitized.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        res.json(sanitized);
    } catch (error: any) {
        console.error('Error in getLeadWhatsAppMessages:', error);
        res.status(500).json({ message: error.message });
    }
};

export const testConnection = async (req: AuthRequest, res: Response) => {
    try {
        const config = await getWhatsAppConfig(req);

        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        // Test by getting phone number info
        const response = await whatsAppService.makeRequest(`${config.phoneNumberId}`, config.accessToken, {
            fields: 'display_phone_number,verified_name,quality_rating'
        });

        res.json({
            success: true,
            phoneNumber: response.display_phone_number,
            verifiedName: response.verified_name,
            qualityRating: response.quality_rating
        });
    } catch (error: any) {
        console.error('Error in testConnection:', error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * Central connection status used by every page in the WhatsApp hub.
 * Never throws for "not connected" - that is a normal state the UI renders.
 */
export const getConnectionStatus = async (req: AuthRequest, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const cred = await resolveWhatsAppCredentials(orgId);
        if (!cred) return res.json({ connected: false });

        const [account, accountsCount] = await Promise.all([
            cred.accountId ? prisma.whatsAppAccount.findUnique({ where: { id: cred.accountId } }) : null,
            prisma.whatsAppAccount.count({ where: { organisationId: orgId, isDeleted: false, status: 'active' } })
        ]);

        let phone: any = {};
        try {
            const svc = new WhatsAppService({ accessToken: cred.accessToken, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId });
            phone = await svc.makeRequest(`${cred.phoneNumberId}`, cred.accessToken, { fields: 'display_phone_number,verified_name,quality_rating' }, 1);
        } catch (err: any) {
            return res.json({ connected: true, healthy: false, phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId, accountId: cred.accountId, accountsCount, error: err.message });
        }

        res.json({
            connected: true, healthy: true, accountId: cred.accountId, accountsCount,
            phoneNumberId: cred.phoneNumberId, wabaId: cred.wabaId,
            phoneNumber: phone.display_phone_number, verifiedName: phone.verified_name,
            qualityRating: phone.quality_rating || account?.qualityRating, messagingTier: account?.messagingTier
        });
    } catch (error: any) {
        console.error('Error in getConnectionStatus:', error);
        res.status(500).json({ message: error.message });
    }
};

export const deleteTemplate = async (req: AuthRequest, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });
        await WhatsAppTemplateService.remove(orgId, req.params.name);
        res.json({ success: true });
    } catch (error: any) {
        console.error('Error in deleteTemplate:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getTemplates = async (req: AuthRequest, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });
        const rows = await WhatsAppTemplateService.list(orgId, { refresh: req.query.refresh === '1' });
        res.json(rows);
    } catch (error: any) {
        console.error('Error in getTemplates:', error);
        res.status(500).json({ message: error.message });
    }
};

export const createTemplate = async (req: AuthRequest, res: Response) => {
    try {
        const orgId = getOrgId(req.user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });
        const result = await WhatsAppTemplateService.create(orgId, req.body, req.body.accountId);
        res.json({ ...result.meta, template: result.template });
    } catch (error: any) {
        console.error('Error in createTemplate:', error);
        res.status(500).json({ message: error.message });
    }
};

export const sendMediaMessage = async (req: AuthRequest, res: Response) => {
    try {
        const { to, mediaType, mediaId, caption, filename } = req.body;

        if (!to || !mediaType || !mediaId) {
            return res.status(400).json({ message: 'Phone number, media type, and media ID are required' });
        }

        const config = await getWhatsAppConfig(req);

        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        const result = await whatsAppService.sendMediaMessage(to, mediaType, mediaId, caption, filename);

        // Log the message to database
        const user = req.user;
        const orgId = getOrgId(user);

        if (orgId) {
            await prisma.whatsAppMessage.create({
                data: {
                    conversationId: `${to}_${Date.now()}`,
                    phoneNumber: to,
                    direction: 'outgoing',
                    messageType: mediaType,
                    content: {
                        mediaId,
                        caption,
                        filename
                    },
                    status: 'sent',
                    waMessageId: result.messages?.[0]?.id,
                    sentAt: new Date(),
                    organisationId: orgId,
                    agentId: user?.id
                }
            });
        }

        res.json({ success: true, result });
    } catch (error: any) {
        console.error('Error in sendMediaMessage:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getMessageStatus = async (req: AuthRequest, res: Response) => {
    try {
        const { messageId } = req.params;

        if (!messageId) {
            return res.status(400).json({ message: 'Message ID is required' });
        }

        const config = await getWhatsAppConfig(req);

        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        const result = await whatsAppService.getMessageStatus(messageId);
        res.json(result);
    } catch (error: any) {
        console.error('Error in getMessageStatus:', error);
        res.status(500).json({ message: error.message });
    }
};

export const markMessageAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const { messageId } = req.body;
        const user = req.user;
        const orgId = getOrgId(user);

        if (!orgId) {
            return res.status(400).json({ message: 'No organisation found' });
        }

        if (!messageId) {
            return res.status(400).json({ message: 'Message ID is required' });
        }

        const config = await getWhatsAppConfig(req);

        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        // Update internal database
        await prisma.whatsAppMessage.updateMany({
            where: {
                waMessageId: messageId as string,
                organisationId: orgId as string
            },
            data: {
                isReadByAgent: true
            }
        });

        const result = await whatsAppService.markMessageAsRead(messageId);
        res.json({ success: true, result });
    } catch (error: any) {
        console.error('Error in markMessageAsRead:', error);
        res.status(500).json({ message: error.message });
    }
};

export const markConversationAsRead = async (req: AuthRequest, res: Response) => {
    try {
        const { phoneNumber } = req.body;
        const user = req.user;
        const orgId = getOrgId(user);

        if (!phoneNumber) {
            return res.status(400).json({ message: 'Phone number is required' });
        }

        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        await prisma.whatsAppMessage.updateMany({
            where: {
                organisationId: orgId,
                phoneNumber,
                direction: 'incoming',
                isReadByAgent: false
            },
            data: {
                isReadByAgent: true
            }
        });

        // Notify via socket to refresh conversation list in other tabs
        const io = getIO();
        if (io) {
            io.to(`org:${orgId}`).emit('whatsapp_conversation_read', {
                phoneNumber
            });
        }

        res.json({ success: true });
    } catch (error: any) {
        console.error('Error in markConversationAsRead:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getConversationAnalytics = async (req: AuthRequest, res: Response) => {
    try {
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const config = await getWhatsAppConfig(req);

        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        const result = await whatsAppService.getConversationAnalytics(startDate as string, endDate as string);
        res.json(result);
    } catch (error: any) {
        console.error('Error in getConversationAnalytics:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getMessageStatistics = async (req: AuthRequest, res: Response) => {
    try {
        const user = req.user as any;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const { startDate, endDate, phoneNumber } = req.query;

        const visibleUserIds = await getVisibleUserIds(user.id);
        const isOrgAdmin = user.role === 'organisation_admin' || user.role === 'org_admin' || user.role === 'super_admin';

        const where: any = {
            organisationId: orgId,
            isDeleted: false
        };

        if (!isOrgAdmin) {
            where.OR = [
                { agentId: { in: visibleUserIds } },
                { lead: { assignedToId: { in: visibleUserIds } } },
                { lead: { createdById: { in: visibleUserIds } } },
                { contact: { ownerId: { in: visibleUserIds } } },
            ];
        }

        if (startDate && endDate) {
            where.createdAt = {
                gte: new Date(startDate as string),
                lte: new Date(endDate as string)
            };
        }

        if (phoneNumber) {
            where.phoneNumber = phoneNumber;
        }

        // Get message counts by status
        const statusCounts = await prisma.whatsAppMessage.groupBy({
            by: ['status'],
            where,
            _count: {
                id: true
            }
        });

        // Get message counts by type
        const typeCounts = await prisma.whatsAppMessage.groupBy({
            by: ['messageType'],
            where,
            _count: {
                id: true
            }
        });

        // Get message counts by direction
        const directionCounts = await prisma.whatsAppMessage.groupBy({
            by: ['direction'],
            where,
            _count: {
                id: true
            }
        });

        // Get total messages
        const totalMessages = await prisma.whatsAppMessage.count({ where });

        // Get unique conversations
        const uniqueConversations = await prisma.whatsAppMessage.findMany({
            where,
            select: { phoneNumber: true },
            distinct: ['phoneNumber']
        });

        res.json({
            totalMessages,
            uniqueConversations: uniqueConversations.length,
            statusBreakdown: statusCounts.reduce((acc, item) => {
                acc[item.status] = item._count.id;
                return acc;
            }, {} as Record<string, number>),
            typeBreakdown: typeCounts.reduce((acc, item) => {
                acc[item.messageType] = item._count.id;
                return acc;
            }, {} as Record<string, number>),
            directionBreakdown: directionCounts.reduce((acc, item) => {
                acc[item.direction] = item._count.id;
                return acc;
            }, {} as Record<string, number>)
        });
    } catch (error: any) {
        console.error('Error in getMessageStatistics:', error);
        res.status(500).json({ message: error.message });
    }
};

export const getMedia = async (req: AuthRequest, res: Response) => {
    try {
        const { mediaId } = req.params;
        if (!mediaId) {
            return res.status(400).json({ message: 'Media ID is required' });
        }

        const config = await getWhatsAppConfig(req);
        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        // 1. Get media URL
        const mediaUrl = await whatsAppService.getMediaUrl(mediaId);

        // 2. Download/Proxy media
        const mediaStream = await whatsAppService.downloadMedia(mediaUrl);

        mediaStream.pipe(res);
    } catch (error: any) {
        console.error('Error in getMedia:', error);
        res.status(500).json({ message: error.message });
    }
};
export const uploadMedia = async (req: any, res: any) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const config = await getWhatsAppConfig(req);
        const whatsAppService = new WhatsAppService({
            accessToken: config.accessToken,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId
        });

        const result = await whatsAppService.uploadMedia(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype
        );

        res.json(result);
    } catch (error: any) {
        console.error('Error in uploadMedia:', error);
        res.status(500).json({ message: error.message });
    }
};

export const handleWebhook = async (req: Request, res: Response) => {
    try {
        const signature = req.headers['x-hub-signature-256'] as string;
        // WHATSAPP_APP_SECRET is the canonical name; WHATSAPP_WEBHOOK_SECRET is accepted
        // for backward compatibility with existing deployed env files that used that name.
        const appSecret = process.env.WHATSAPP_APP_SECRET || process.env.WHATSAPP_WEBHOOK_SECRET;
        const rawBody: Buffer | undefined = (req as any).rawBody;

        if (!appSecret) {
            if (process.env.NODE_ENV === 'production') {
                console.error('[WhatsAppWebhook] Rejected: WHATSAPP_APP_SECRET is not configured');
                return res.sendStatus(401);
            }
            console.warn('[WhatsAppWebhook] WHATSAPP_APP_SECRET not configured - skipping signature verification (non-production only)');
        } else {
            if (!signature || !rawBody) {
                console.warn('[WhatsAppWebhook] Missing signature or raw body');
                return res.sendStatus(401);
            }

            const isValid = WhatsAppService.verifySignature(
                rawBody.toString('utf8'),
                signature,
                appSecret
            );

            if (!isValid) {
                console.warn('[WhatsAppWebhook] Invalid signature');
                return res.sendStatus(401);
            }
        }

        await WhatsAppIntegrationService.handleWebhook(req.body);
        res.sendStatus(200);
    } catch (error: any) {
        console.error('Error in handleWebhook:', error);
        res.status(500).json({ message: error.message });
    }
};

export const verifyWebhook = async (req: Request, res: Response) => {
    try {
        await WhatsAppIntegrationService.verifyWebhook(req, res);
    } catch (error: any) {
        console.error('Error in verifyWebhook:', error);
        res.status(500).json({ message: error.message });
    }
};

export const handleGallaboxWebhook = async (req: Request, res: Response) => {
    try {
        const signature = req.headers['x-gallabox-signature'] as string;
        const secret = process.env.GALLABOX_WEBHOOK_SECRET;
        const rawBody: Buffer | undefined = (req as any).rawBody;

        if (!secret) {
            if (process.env.NODE_ENV === 'production') {
                console.error('[GallaboxWebhook] Rejected: GALLABOX_WEBHOOK_SECRET is not configured');
                return res.sendStatus(401);
            }
            console.warn('[GallaboxWebhook] GALLABOX_WEBHOOK_SECRET not configured - skipping signature verification (non-production only)');
        } else {
            if (!signature || !rawBody) {
                console.warn('[GallaboxWebhook] Missing signature or raw body');
                return res.sendStatus(401);
            }

            const isValid = GallaboxService.verifySignature(
                rawBody.toString('utf8'),
                signature,
                secret
            );

            if (!isValid) {
                console.warn('[GallaboxWebhook] Invalid signature');
                return res.sendStatus(401);
            }
        }

        await WhatsAppIntegrationService.handleGallaboxWebhook(req.body);
        res.sendStatus(200);
    } catch (error: any) {
        console.error('Error in handleGallaboxWebhook:', error);
        res.status(500).json({ message: error.message });
    }
};
