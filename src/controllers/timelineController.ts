import { Request, Response } from 'express';
import prisma from '../config/prisma';

// Helper function to format action names
function getHumanReadableAction(action: string, entity: string): string {
    const actionMap: Record<string, string> = {
        'LOGIN': 'Logged in',
        'CREATE': `Created ${entity}`,
        'CREATE_LEAD': 'Created Lead',
        'CREATE_CONTACT': 'Created Contact',
        'CREATE_ACCOUNT': 'Created Account',
        'UPDATE': `Updated ${entity}`,
        'DELETE': `Deleted ${entity}`,
        'EXPORT': 'Exported Data',
        'LEAD_STATUS_CHANGE': 'Changed Lead Status',
        'BULK_IMPORT_COMPLETED': 'Completed Bulk Import'
    };

    return actionMap[action] || `${action.replace(/_/g, ' ')} ${entity}`;
}

export const getTimeline = async (req: Request, res: Response) => {
    try {
        const { id, type } = req.params; // type = 'lead' | 'contact' | 'account' | 'opportunity'

        // Basic validation
        if (!['lead', 'contact', 'account', 'opportunity'].includes(type) || !id) {
            return res.status(400).json({ message: 'Invalid entity type or ID' });
        }

        // Fetch related data concurrently
        const [interactions, tasks, events, auditLogs, callRecordings, followUpsData, documents] = await Promise.all([
            prisma.interaction.findMany({
                where: { 
                    [`${type}Id`]: id,
                    isDeleted: false
                },
                orderBy: { date: 'desc' },
                include: { createdBy: { select: { firstName: true, lastName: true } } }
            }),
            prisma.task.findMany({
                where: { 
                    [`${type}Id`]: id,
                    isDeleted: false
                },
                orderBy: { createdAt: 'desc' },
                include: { assignedTo: { select: { firstName: true, lastName: true } } }
            }),
            prisma.calendarEvent.findMany({
                where: { 
                    [`${type}Id`]: id,
                    isDeleted: false
                },
                orderBy: { startTime: 'desc' },
                include: { createdBy: { select: { firstName: true, lastName: true } } }
            }),
            prisma.auditLog.findMany({
                where: { entityId: id }, // AuditLog stores entityId generically
                orderBy: { createdAt: 'desc' },
                include: { actor: { select: { firstName: true, lastName: true } } }
            }),
            prisma.callRecording.findMany({
                where: { leadId: id },
                orderBy: { timestamp: 'desc' }
            }),
            prisma.followUp.findMany({
                where: { 
                    [`${type}Id`]: id,
                    isDeleted: false
                },
                orderBy: { dueDate: 'desc' },
                include: { assignedTo: { select: { firstName: true, lastName: true } } }
            }),
            prisma.document.findMany({
                where: {
                    [`${type}Id`]: id,
                    isDeleted: false,
                    category: { not: 'recording' } // recordings are handled by interactions/recordings
                },
                orderBy: { createdAt: 'desc' },
                include: { createdBy: { select: { firstName: true, lastName: true } } }
            })
        ]);

        // Filter out CallRecordings that are already represented by Interactions to avoid timeline duplicates.
        // A recording is considered "covered" by an interaction if:
        //   1. Its fileUrl matches the interaction's recordingUrl, OR
        //   2. It has an empty fileUrl AND shares the same leadId as an interaction within a 2-minute window.
        const interactionRecordingUrls = new Set(interactions.map(i => i.recordingUrl).filter(Boolean));
        const interactionLeadTimestamps = interactions.map(i => ({
            leadId: i.leadId,
            time: new Date(i.date).getTime()
        }));

        const standaloneRecordings = callRecordings.filter(c => {
            // If the fileUrl matches an interaction's recordingUrl, it's a duplicate
            if (c.fileUrl && interactionRecordingUrls.has(c.fileUrl)) return false;

            // If the recording has an empty fileUrl (metadata-only from bulk sync),
            // check if an Interaction already covers this lead+timestamp window
            if (!c.fileUrl || c.fileUrl === '') {
                const recTime = new Date(c.timestamp).getTime();
                const hasCoveringInteraction = interactionLeadTimestamps.some(
                    it => it.leadId === c.leadId && Math.abs(it.time - recTime) < 120_000
                );
                if (hasCoveringInteraction) return false;
            }

            return true;
        });

        // Normalize data for UI
        const timeline = [
            ...interactions.map(i => ({
                id: i.id,
                type: 'interaction',
                subType: i.type, // call, email, meeting
                title: i.subject,
                description: i.description,
                date: i.date,
                actor: i.createdBy,
                meta: {
                    direction: i.direction,
                    duration: i.duration,
                    recordingDuration: i.recordingDuration,
                    recordingUrl: i.recordingUrl
                }
            })),
            ...tasks.map(t => ({
                id: t.id,
                type: 'task',
                subType: t.status, // not_started, in_progress, etc.
                title: t.subject,
                description: t.description,
                date: t.dueDate || t.createdAt,
                actor: t.assignedTo,
                meta: { priority: t.priority }
            })),
            ...events.map(e => ({
                id: e.id,
                type: 'event',
                subType: e.type,
                title: e.title,
                description: e.description,
                date: e.startTime,
                actor: e.createdBy,
                meta: { location: e.location }
            })),
            ...auditLogs.map(a => {
                // Format audit log description based on action type
                let description = '';
                const details = a.details as any;

                switch (a.action) {
                    case 'CREATE_LEAD':
                    case 'CREATE':
                        const entityName = details?.name || details?.title || 'item';
                        description = `Created ${a.entity.toLowerCase()}: "${entityName}"`;
                        if (details?.company) description += ` at ${details.company}`;
                        break;
                    case 'UPDATE':
                        const updatedName = details?.name || details?.title || 'item';
                        if (details?.updatedFields && Array.isArray(details.updatedFields)) {
                            description = `Updated ${a.entity.toLowerCase()} "${updatedName}": changed ${details.updatedFields.join(', ')}`;
                        } else {
                            description = `Updated ${a.entity.toLowerCase()} "${updatedName}"`;
                        }
                        break;
                    case 'DELETE':
                        description = `Deleted ${a.entity.toLowerCase()}`;
                        break;
                    case 'LOGIN':
                        description = 'Logged into the system';
                        break;
                    case 'EXPORT':
                        description = 'Exported data';
                        break;
                    case 'LEAD_STATUS_CHANGE':
                        description = details?.oldStatus && details?.newStatus
                            ? `Changed status from ${details.oldStatus} to ${details.newStatus}`
                            : details?.status ? `Changed status to ${details.status}` : 'Status changed';
                        break;
                    case 'BULK_IMPORT_COMPLETED':
                        description = details?.successCount
                            ? `Imported ${details.successCount} records`
                            : 'Bulk import completed';
                        break;
                    case 'INVITE_USER':
                        description = `Invited new user: ${details?.email || 'unknown'}`;
                        break;
                    case 'DEACTIVATE_USER':
                        description = `Deactivated user account: ${details?.email || 'unknown'}`;
                        break;
                    default:
                        // For unknown actions, try to extract meaningful info
                        if (details?.name || details?.title) {
                            description = details.name || details.title;
                        } else if (typeof details === 'object' && details !== null) {
                            // Extract first meaningful value
                            const values = Object.values(details).filter(v => v && typeof v === 'string');
                            description = values.length > 0 ? String(values[0]) : '';
                        }
                }

                return {
                    id: a.id,
                    type: 'audit',
                    subType: a.action,
                    title: getHumanReadableAction(a.action, a.entity),
                    description: description || 'Activity recorded',
                    date: a.createdAt,
                    actor: a.actor,
                    meta: {}
                };
            }),
            ...standaloneRecordings.map(c => ({
                id: c.id,
                type: 'recording',
                subType: c.callType,
                title: `Call: ${c.callType}`,
                description: `Duration: ${Math.floor(c.duration / 60)}m ${c.duration % 60}s`,
                date: c.timestamp,
                actor: null, // Call logs are from the device, usually specific to the assigned user
                meta: { fileUrl: c.fileUrl, duration: c.duration, callType: c.callType }
            })),
            ...followUpsData.map(f => ({
                id: f.id,
                type: 'followUp',
                subType: f.status,
                title: f.subject,
                description: f.description,
                date: f.dueDate,
                actor: f.assignedTo,
                meta: { priority: f.priority }
            })),
            ...documents.map(d => ({
                id: d.id,
                type: 'document',
                subType: d.category,
                title: d.name,
                description: d.description,
                date: d.createdAt,
                actor: d.createdBy,
                meta: {
                    fileType: d.fileType,
                    fileSize: d.fileSize,
                    fileUrl: `/api/documents/${d.id}/download`
                }
            }))
        ];

        // A lead's timeline ends with when it was created (and from where). The generic
        // "Create Lead" audit row, if any, is replaced by this entry to avoid a duplicate.
        if (type === 'lead') {
            const orgScope = (req as any).user?.organisationId;
            const lead = await prisma.lead.findFirst({
                where: { id, ...(orgScope ? { organisationId: orgScope } : {}) },
                select: { id: true, createdAt: true, source: true, createdBy: { select: { id: true, firstName: true, lastName: true } } }
            });
            if (lead) {
                for (let i = timeline.length - 1; i >= 0; i--) {
                    if (timeline[i].type === 'audit' && /^create lead/i.test(String(timeline[i].title))) timeline.splice(i, 1);
                }
                timeline.push({
                    id: `lead-created-${lead.id}`,
                    type: 'audit',
                    subType: 'LEAD_CREATED',
                    title: 'Lead created',
                    description: `Lead was created${lead.source ? ` via ${String(lead.source).replace(/_/g, ' ')}` : ''}`,
                    date: lead.createdAt,
                    actor: lead.createdBy || undefined,
                    meta: {}
                } as any);
            }
        }

        // Sort by date descending
        timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        res.json(timeline);
    } catch (error) {
        console.error('Timeline Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
