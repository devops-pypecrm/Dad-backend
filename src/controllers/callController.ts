import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId, getVisibleUserIds } from '../utils/hierarchyUtils';
import { resolveBestDurationSeconds, synchronizeDurations, getISTDateBounds } from '../utils/callUtils';
import { FollowUpService } from '../services/followUpService';
import path from 'path';
import fs from 'fs';

// Helper to ensure upload directory exists
const uploadDir = path.join(__dirname, '../../uploads/recordings');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

export const initiateCall = async (req: Request, res: Response) => {
    try {
        const { leadId, phoneNumber, direction = 'outbound', callSessionId } = req.body;
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) return res.status(400).json({ message: 'No org' });

        // DEDUPLICATION: Check if an 'initiated' interaction already exists for this lead/user/phone in last 60s
        const recentWindow = new Date(Date.now() - 60 * 1000);
        const existingInteraction = await prisma.interaction.findFirst({
            where: {
                leadId,
                createdById: user.id,
                phoneNumber,
                type: 'call',
                callStatus: 'initiated',
                createdAt: { gte: recentWindow }
            }
        });

        if (existingInteraction) {
            console.log(`[CallController] Reusing existing initiated interaction ${existingInteraction.id}`);
            // Update session ID if it was missing but now provided
            if (callSessionId && !existingInteraction.callSessionId) {
                await prisma.interaction.update({
                    where: { id: existingInteraction.id },
                    data: { callSessionId }
                });
            }
            return res.status(200).json(existingInteraction);
        }

        const interaction = await prisma.interaction.create({
            data: {
                type: 'call',
                direction,
                subject: `Call ${direction === 'outbound' ? 'to' : 'from'} ${phoneNumber}`,
                date: new Date(),
                callStatus: 'initiated',
                phoneNumber,
                description: 'Call initiated',
                callSessionId: callSessionId || undefined,

                // Defaults to Lead logic as per old controller
                lead: { connect: { id: leadId } },

                organisation: { connect: { id: orgId } },
                createdBy: { connect: { id: user.id } }
            }
        });

        res.status(201).json(interaction);
    } catch (error) {
        console.error('initiateCall error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

export const completeCall = async (req: Request, res: Response) => {
    try {
        const file = req.file;
        const { duration, status, notes, scheduleFollowUp } = req.body;
        const callId = req.params.id;
        const user = (req as any).user;

        const updateData: any = {
            callStatus: status || 'completed',
            duration: duration ? Number(duration) : undefined,
        };

        if (duration) {
            synchronizeDurations(updateData);
        }

        if (file) {
            updateData.recordingUrl = `/uploads/recordings/${file.filename}`;
        }
        if (notes) {
            updateData.description = notes;
        }

        const interaction = await prisma.interaction.update({
            where: { id: callId },
            data: updateData,
            include: { createdBy: true }
        });

        // Auto-update lead status to 'contacted' if it was 'new'
        if (interaction.leadId && interaction.callStatus === 'completed' && (interaction.duration || 0) > 0) {
            const lead = await prisma.lead.findUnique({ where: { id: interaction.leadId }, select: { status: true } });
            if (lead?.status === 'new') {
                await prisma.lead.update({
                    where: { id: interaction.leadId },
                    data: { status: 'contacted' }
                }).catch(() => {});
                
                await prisma.leadHistory.create({
                    data: {
                        leadId: interaction.leadId,
                        fieldName: 'status',
                        oldValue: 'new',
                        newValue: 'contacted',
                        changedById: interaction.createdById || user.id,
                        reason: 'Auto-updated via Browser Call Completion'
                    }
                }).catch(() => {});
            }
        }

        // Emit socket event for real-time update
        const io = req.app.get('io');
        if (io && interaction.createdBy?.id) {
            io.to(interaction.createdBy.id).emit('call_completed', { callId });
        }

        // Logic for Follow-up Task: Explicit override OR Global Setting
        let shouldCreateTask = false;
        let delay = 1; // Default 1 day

        // 1. Check overrides from request
        if (scheduleFollowUp !== undefined && scheduleFollowUp !== null && scheduleFollowUp !== '') {
            shouldCreateTask = String(scheduleFollowUp) === 'true';
        }

        // 2. If no override, check settings
        if (scheduleFollowUp === undefined || scheduleFollowUp === null || scheduleFollowUp === '') {
            if (interaction.organisationId) {
                const settings = await prisma.callSettings.findUnique({
                    where: { organisationId: interaction.organisationId }
                });
                if (settings?.autoFollowupReminder) {
                    shouldCreateTask = true;
                    delay = settings.followupDelayMinutes || 30; // Default 30 mins
                }
            }
        }

        if (shouldCreateTask) {
            const dueDate = new Date();
            dueDate.setMinutes(dueDate.getMinutes() + delay);

            await FollowUpService.rescheduleOrCreateFollowUp({
                subject: `Follow-up: Call with ${interaction.phoneNumber || 'Lead'}`,
                description: `Follow-up scheduled from call on ${new Date().toLocaleDateString()}.\n\nCall Notes: ${notes || 'None'}`,
                dueDate: dueDate,
                organisationId: interaction.organisationId!,
                createdById: interaction.createdById || undefined,
                leadId: interaction.leadId!,
                assignedToId: interaction.createdById || undefined,
            });

            // Sync Lead follow-up date using the dedicated service
            if (interaction.leadId) {
                await FollowUpService.syncLeadFollowUp(interaction.leadId);
            }
        }

        res.json(interaction);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getLeadCalls = async (req: Request, res: Response) => {
    try {
        const { leadId } = req.params;
        const user = (req as any).user;

        if (leadId === 'new') return res.json([]);

        const where: any = {
            leadId: leadId,
            type: 'call',
            isDeleted: false
        };

        // Hierarchy filtering: Ensure user is authorized to see this lead
        if (user.role !== 'admin' && user.role !== 'super_admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);
            
            // Check if user owns the lead OR created it OR owns it via subordinates
            const lead = await prisma.lead.findFirst({
                where: {
                    id: leadId,
                    organisationId: getOrgId(user) || undefined,
                    OR: [
                        { assignedToId: { in: visibleUserIds } },
                        { createdById: user.id }
                    ]
                }
            });

            if (!lead) {
                return res.status(403).json({ message: 'Not authorized to view calls for this lead' });
            }
        }

        const calls = await prisma.interaction.findMany({
            where,
            orderBy: { date: 'desc' }
        });

        res.json(calls);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getRecording = async (req: Request, res: Response) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(uploadDir, filename);

        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ message: 'Recording not found' });
        }
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get all calls with filters and pagination
export const getAllCalls = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) return res.status(400).json({ message: 'No org' });

        const {
            page = '1',
            limit = '20',
            direction,
            status,
            userId,
            startDate,
            endDate,
            search,
            hasRecording,
            branchId
        } = req.query;

        const pageNum = parseInt(page as string, 10);
        const limitNum = parseInt(limit as string, 10);
        const skip = (pageNum - 1) * limitNum;

        // Build where clause
        const where: Record<string, unknown> = {
            organisationId: orgId,
            type: 'call',
            isDeleted: false
        };

        if (direction && direction !== 'all') {
            where.direction = direction;
        }

        if (status && status !== 'all') {
            where.callStatus = status;
        }

        if (hasRecording === 'true') {
            where.recordingUrl = { not: null };
        }

        if (branchId && branchId !== 'all') {
            where.branchId = branchId;
        }

        if (user.role !== 'admin' && user.role !== 'super_admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);

            const visibilityConditions: any[] = [
                {
                    OR: [
                        { createdById: { in: visibleUserIds } },
                        { createdById: null }
                    ]
                }
            ];

            // Add Lead ownership visibility
            visibilityConditions.push({
                lead: { assignedToId: { in: visibleUserIds } } // Calls for leads you or subordinates own
            });

            if (userId && userId !== 'all') {
                // If filtering by specific user, ensure that user is in allowed hierarchy
                if (visibleUserIds.includes(userId as string)) {
                    where.AND = [
                        { OR: visibilityConditions },
                        { createdById: userId }
                    ];
                } else {
                    // Not authorized to view this user's calls
                    where.createdById = 'none';
                }
            } else {
                where.OR = visibilityConditions;
            }
        } else if (userId && userId !== 'all') {
            // Admin/Super Admin can filter by any user
            where.createdById = userId;
        }

        if (startDate || endDate) {
            where.date = {};
            if (startDate) {
                (where.date as Record<string, Date>).gte = new Date(startDate as string);
            }
            if (endDate) {
                (where.date as Record<string, Date>).lte = new Date(endDate as string);
            }
        }

        if (search) {
            where.OR = [
                { phoneNumber: { contains: search as string, mode: 'insensitive' } },
                { subject: { contains: search as string, mode: 'insensitive' } }
            ];
        }

        // Get total count
        const total = await prisma.interaction.count({ where: where as any });

        // Get calls with relations
        const calls = await prisma.interaction.findMany({
            where: where as any,
            include: {
                createdBy: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true
                    }
                },
                lead: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        phone: true,
                        company: true
                    }
                },
                contact: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true
                    }
                }
            },
            orderBy: { date: 'desc' },
            skip,
            take: limitNum
        });

        res.json({
            calls,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Get all calls error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get call statistics for dashboard
export const getCallStats = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) return res.status(400).json({ message: 'No org' });

        const { period = 'week', userId, startDate: customStart, endDate: customEnd } = req.query;

        // Calculate date range
        const now = new Date();
        let startDate: Date;
        let endDate: Date | null = null;
        const { startOfToday, endOfToday, startOfYesterday, endOfYesterday, startOfMonth } = getISTDateBounds(now);

        switch (period) {
            case 'allTime':
                startDate = new Date(0);
                break;
            case 'today':
                startDate = startOfToday;
                endDate = endOfToday;
                break;
            case 'yesterday':
                startDate = startOfYesterday;
                endDate = endOfYesterday;
                break;
            case 'week':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case 'last30':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case 'month':
            case 'thisMonth':
                startDate = startOfMonth;
                break;
            case 'custom':
                startDate = customStart ? new Date(String(customStart)) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                if (customEnd) {
                    endDate = new Date(String(customEnd));
                    endDate.setHours(23, 59, 59, 999);
                }
                break;
            default:
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }

        const baseWhere: any = {
            organisationId: orgId,
            type: 'call' as const,
            callStatus: { not: 'initiated' },
            isDeleted: false,
            date: endDate ? { gte: startDate, lt: endDate } : { gte: startDate }
        };

        // Hierarchy filtering
        if (user.role !== 'admin' && user.role !== 'super_admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);
            
            const visibilityConditions: any[] = [
                {
                    OR: [
                        { createdById: { in: visibleUserIds } },
                        { createdById: null }
                    ]
                },
                { lead: { assignedToId: { in: visibleUserIds } } }
            ];

            if (userId && userId !== 'all') {
                if (visibleUserIds.includes(userId as string)) {
                    baseWhere.AND = [
                        { OR: visibilityConditions },
                        { createdById: userId }
                    ];
                } else {
                    baseWhere.createdById = 'none';
                }
            } else {
                baseWhere.OR = visibilityConditions;
            }
        } else if (userId && userId !== 'all') {
            baseWhere.createdById = userId;
        }

        // Total calls
        const totalCalls = await prisma.interaction.count({ where: baseWhere });

        // Calls by direction
        const outboundCalls = await prisma.interaction.count({
            where: { ...baseWhere, direction: 'outbound' }
        });
        const inboundCalls = await prisma.interaction.count({
            where: { ...baseWhere, direction: 'inbound' }
        });

        // Missed calls
        const missedCalls = await prisma.interaction.count({
            where: { ...baseWhere, callStatus: 'missed' }
        });

        // Completed calls
        const completedCalls = await prisma.interaction.count({
            where: { ...baseWhere, callStatus: 'completed' }
        });

        // Average duration (for completed calls with duration or recordingDuration)
        const callsWithDuration = await prisma.interaction.findMany({
            where: {
                ...baseWhere,
                callStatus: 'completed',
                OR: [
                    { duration: { gt: 0 } },
                    { recordingDuration: { gt: 0 } }
                ]
            },
            select: { duration: true, recordingDuration: true, hardwareDuration: true }
        });

        let totalSeconds = 0;
        let validCalls = 0;
        callsWithDuration.forEach(c => {
            totalSeconds += resolveBestDurationSeconds(c);
            validCalls++;
        });

        const avgDuration = validCalls > 0 ? (totalSeconds / validCalls) / 60 : 0;

        // Calls with recordings
        const callsWithRecording = await prisma.interaction.count({
            where: {
                ...baseWhere,
                recordingUrl: { not: null }
            }
        });

        res.json({
            totalCalls,
            outboundCalls,
            inboundCalls,
            missedCalls,
            completedCalls,
            connectedCalls: completedCalls, // alias: a "connected" call is one that completed
            avgDuration: Math.round(avgDuration * 10) / 10, // Round to 1 decimal
            callsWithRecording,
            period
        });
    } catch (error) {
        console.error('Get call stats error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// Delete a call recording
export const deleteRecording = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { id } = req.params;

        if (!orgId) return res.status(400).json({ message: 'No org' });

        // Find the call
        const call = await prisma.interaction.findFirst({
            where: {
                id,
                organisationId: orgId,
                type: 'call'
            }
        });

        if (!call) {
            return res.status(404).json({ message: 'Call not found' });
        }

        if (!call.recordingUrl) {
            return res.status(400).json({ message: 'No recording to delete' });
        }

        // Delete the file
        const filename = call.recordingUrl.split('/').pop();
        if (filename) {
            const filePath = path.join(uploadDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        // Update the call record
        await prisma.interaction.update({
            where: { id },
            data: {
                recordingUrl: null,
                recordingDuration: null
            }
        });

        res.json({ message: 'Recording deleted successfully' });
    } catch (error) {
        console.error('Delete recording error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get per-user call analytics for reports
export const getUserCallAnalytics = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) return res.status(400).json({ message: 'No org' });

        const { period = 'today', direction, branchId } = req.query; // direction: all, inbound, outbound

        // Calculate date range
        const now = new Date();
        let startDate: Date;
        const { startOfToday, startOfYesterday, endOfYesterday, startOfMonth } = getISTDateBounds(now);

        switch (period) {
            case 'today':
                startDate = startOfToday;
                break;
            case 'yesterday':
                startDate = startOfYesterday;
                break;
            case 'week':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case 'month':
                startDate = startOfMonth;
                break;
            default:
                startDate = startOfToday;
        }

        const baseWhere: any = {
            organisationId: orgId,
            type: 'call' as const,
            isDeleted: false,
            date: { gte: startDate }
        };

        if (period === 'yesterday') {
            baseWhere.date = { gte: startOfYesterday, lte: endOfYesterday };
        }

        if (direction && direction !== 'all') {
            baseWhere.direction = direction;
        }

        // Hierarchy filtering
        const isAdmin = user.role === 'admin' || user.role === 'super_admin' || user.role === 'organisation_admin';
        let userWhere: any = {};

        if (user.role !== 'super_admin') {
            userWhere.organisationId = orgId;
        }

        if (!isAdmin) {
            const visibleUserIds = await getVisibleUserIds(user.id);
            userWhere.id = { in: visibleUserIds };
        }
        
        if (branchId) userWhere.branchId = branchId as string;

        const users = await prisma.user.findMany({
            where: userWhere,
            select: {
                id: true,
                firstName: true,
                lastName: true,
                branch: { select: { name: true } }
            }
        });

        const filteredUserIds = users.map(u => u.id);
        baseWhere.createdById = { in: filteredUserIds };

        // Fetch all relevant interactions
        const interactions = await prisma.interaction.findMany({
            where: baseWhere,
            select: {
                createdById: true,
                callStatus: true,
                duration: true,
                recordingDuration: true,
                hardwareDuration: true,
                direction: true
            }
        });

        // Aggregate by user
        const userStatsMap: Record<string, any> = {};

        // Initialize for all visible users
        users.forEach(u => {
            userStatsMap[u.id] = {
                userId: u.id,
                agentName: `${u.firstName} ${u.lastName || ''}`.trim(),
                branch: u.branch?.name || 'N/A',
                totalCalls: 0,
                connectedCalls: 0,
                totalDurationSeconds: 0
            };
        });

        interactions.forEach(i => {
            if (i.createdById && userStatsMap[i.createdById]) {
                const stats = userStatsMap[i.createdById];
                
                // Only count as a "Call" if it got past the 'initiated' stage
                if (i.callStatus !== 'initiated') {
                    stats.totalCalls++;
                }

                if (i.callStatus === 'completed') {
                    stats.connectedCalls++;
                    
                    stats.totalDurationSeconds += resolveBestDurationSeconds(i);
                }
            }
        });

        const reportData = Object.values(userStatsMap)
            .sort((a, b) => b.totalCalls - a.totalCalls);

        res.json({
            reportData,
            period,
            direction: direction || 'all'
        });
    } catch (error) {
        console.error('Get user call analytics error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};

