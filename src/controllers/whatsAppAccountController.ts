import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { encrypt } from '../utils/encryption';

// Keeps organisation.integrations.whatsappAccounts (the JSON array the existing
// webhook router in whatsAppIntegrationService.ts already reads) in sync with the
// relational WhatsAppAccount table, so inbound message routing keeps working
// unchanged for numbers managed through this new page.
async function syncIntegrationsJson(organisationId: string) {
    const [org, accounts] = await Promise.all([
        prisma.organisation.findUnique({ where: { id: organisationId }, select: { integrations: true } }),
        prisma.whatsAppAccount.findMany({ where: { organisationId, isDeleted: false } })
    ]);

    const integrations = (org?.integrations as any) || {};
    integrations.whatsappAccounts = accounts.map(a => ({
        id: a.id,
        phoneNumberId: a.phoneNumberId,
        wabaId: a.wabaId,
        phoneNumber: a.phoneNumber,
        displayName: a.displayName,
        provider: a.provider,
        status: a.status
    }));

    await prisma.organisation.update({
        where: { id: organisationId },
        data: { integrations }
    });
}

export const getWhatsAppAccounts = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const accounts = await prisma.whatsAppAccount.findMany({
            where: { organisationId: orgId as string, isDeleted: false },
            orderBy: { createdAt: 'desc' },
            include: {
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                _count: { select: { campaigns: { where: { isDeleted: false } }, messages: true } },
                assignmentRules: {
                    where: { isDeleted: false },
                    include: {
                        targetTeam: { select: { id: true, name: true } }
                    }
                }
            }
        });

        // Resolve assigned user names in one batch query (assignedUserIds is a scalar array, not a relation)
        const allUserIds = Array.from(new Set(accounts.flatMap(a => a.assignmentRules.flatMap(r => r.assignedUserIds))));
        const users = allUserIds.length
            ? await prisma.user.findMany({ where: { id: { in: allUserIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
            : [];
        const userMap = new Map(users.map(u => [u.id, u]));

        const enriched = accounts.map(a => ({
            ...a,
            assignmentRules: a.assignmentRules.map(r => ({
                ...r,
                assignedUsers: r.assignedUserIds.map(id => userMap.get(id)).filter(Boolean)
            }))
        }));

        res.json(enriched);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createWhatsAppAccount = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const { phoneNumber, displayName, provider, phoneNumberId, wabaId, accessToken, status, isDefault } = req.body;
        if (!phoneNumber) return res.status(400).json({ message: 'phoneNumber is required' });
        // Only the official WhatsApp Cloud API (Meta) and the Gallabox BSP are supported.
        if (provider && !['meta', 'gallabox'].includes(provider)) {
            return res.status(400).json({ message: 'Unsupported provider. Use the official WhatsApp Cloud API (Meta) or Gallabox.' });
        }
        if ((provider || 'meta') === 'meta' && (!phoneNumberId || !wabaId || !accessToken)) {
            return res.status(400).json({ message: 'Phone number ID, WhatsApp Business Account ID and access token are required for the WhatsApp Cloud API.' });
        }

        const existing = await prisma.whatsAppAccount.findFirst({
            where: { organisationId: orgId as string, phoneNumber, isDeleted: false }
        });
        if (existing) return res.status(400).json({ message: 'This number is already connected' });

        if (isDefault) {
            await prisma.whatsAppAccount.updateMany({
                where: { organisationId: orgId as string, isDefault: true },
                data: { isDefault: false }
            });
        }

        const account = await prisma.whatsAppAccount.create({
            data: {
                organisationId: orgId as string,
                phoneNumber,
                displayName,
                provider: provider || 'meta',
                connectionType: 'manual',
                phoneNumberId,
                wabaId,
                accessToken: accessToken ? encrypt(accessToken) : undefined,
                status: status || 'active',
                isDefault: !!isDefault,
                createdById: user.id
            }
        });

        await syncIntegrationsJson(orgId as string);

        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_WHATSAPP_ACCOUNT',
                entity: 'WhatsAppAccount',
                entityId: account.id,
                actorId: user.id,
                organisationId: orgId as string,
                details: { phoneNumber: account.phoneNumber, provider: account.provider }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(account);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const updateWhatsAppAccount = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const existing = await prisma.whatsAppAccount.findFirst({
            where: { id: req.params.id, organisationId: orgId as string, isDeleted: false }
        });
        if (!existing) return res.status(404).json({ message: 'WhatsApp account not found' });

        const { phoneNumber, displayName, provider, phoneNumberId, wabaId, accessToken, status, isDefault } = req.body;
        if (provider && !['meta', 'gallabox'].includes(provider)) {
            return res.status(400).json({ message: 'Unsupported provider. Use the official WhatsApp Cloud API (Meta) or Gallabox.' });
        }

        if (isDefault) {
            await prisma.whatsAppAccount.updateMany({
                where: { organisationId: orgId as string, isDefault: true, NOT: { id: existing.id } },
                data: { isDefault: false }
            });
        }

        const account = await prisma.whatsAppAccount.update({
            where: { id: existing.id },
            data: {
                phoneNumber: phoneNumber ?? undefined,
                displayName: displayName ?? undefined,
                provider: provider ?? undefined,
                phoneNumberId: phoneNumberId ?? undefined,
                wabaId: wabaId ?? undefined,
                accessToken: accessToken ? encrypt(accessToken) : undefined,
                status: status ?? undefined,
                isDefault: isDefault ?? undefined
            }
        });

        await syncIntegrationsJson(orgId as string);

        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'UPDATE_WHATSAPP_ACCOUNT',
                entity: 'WhatsAppAccount',
                entityId: account.id,
                actorId: user.id,
                organisationId: orgId as string,
                details: { updatedFields: Object.keys(req.body) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json(account);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteWhatsAppAccount = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const existing = await prisma.whatsAppAccount.findFirst({
            where: { id: req.params.id, organisationId: orgId as string, isDeleted: false }
        });
        if (!existing) return res.status(404).json({ message: 'WhatsApp account not found' });

        await prisma.whatsAppAccount.update({
            where: { id: existing.id },
            data: { isDeleted: true }
        });
        await prisma.whatsAppAssignmentRule.updateMany({
            where: { whatsappAccountId: existing.id },
            data: { isDeleted: true }
        });

        await syncIntegrationsJson(orgId as string);

        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'DELETE_WHATSAPP_ACCOUNT',
                entity: 'WhatsAppAccount',
                entityId: existing.id,
                actorId: user.id,
                organisationId: orgId as string,
                details: { phoneNumber: existing.phoneNumber }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({ message: 'WhatsApp account deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getWhatsAppIntegrationReport = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No organisation found' });

        const accounts = await prisma.whatsAppAccount.findMany({
            where: { organisationId: orgId as string, isDeleted: false },
            include: {
                _count: { select: { campaigns: { where: { isDeleted: false } } } },
                assignmentRules: { where: { isDeleted: false } }
            }
        });

        const messageGroups = await prisma.whatsAppMessage.groupBy({
            by: ['whatsappAccountId', 'status'],
            where: { organisationId: orgId as string, isDeleted: false },
            _count: { _all: true }
        });

        const perAccount = accounts.map(a => {
            const stats = messageGroups.filter(g => g.whatsappAccountId === a.id);
            const totalMessages = stats.reduce((sum, g) => sum + g._count._all, 0);
            const delivered = stats.filter(g => ['delivered', 'read'].includes(g.status)).reduce((sum, g) => sum + g._count._all, 0);
            const failed = stats.find(g => g.status === 'failed')?._count._all || 0;
            const read = stats.find(g => g.status === 'read')?._count._all || 0;

            return {
                id: a.id,
                phoneNumber: a.phoneNumber,
                displayName: a.displayName,
                status: a.status,
                campaignCount: a._count.campaigns,
                messageCount: totalMessages,
                deliveredCount: delivered,
                readCount: read,
                failedCount: failed,
                deliveryRate: totalMessages > 0 ? Math.round((delivered / totalMessages) * 100) : 0,
                isAssigned: a.assignmentRules.length > 0
            };
        });

        const totalMessages = perAccount.reduce((sum, a) => sum + a.messageCount, 0);
        const totalDelivered = perAccount.reduce((sum, a) => sum + a.deliveredCount, 0);
        const totalFailed = perAccount.reduce((sum, a) => sum + a.failedCount, 0);
        const totalRead = perAccount.reduce((sum, a) => sum + a.readCount, 0);
        const totalCampaigns = perAccount.reduce((sum, a) => sum + a.campaignCount, 0);

        res.json({
            summary: {
                totalNumbers: accounts.length,
                activeNumbers: accounts.filter(a => a.status === 'active').length,
                inactiveNumbers: accounts.filter(a => a.status !== 'active').length,
                unassignedNumbers: perAccount.filter(a => !a.isAssigned).length,
                totalCampaigns,
                totalMessages,
                totalDelivered,
                totalRead,
                totalFailed,
                deliveryRate: totalMessages > 0 ? Math.round((totalDelivered / totalMessages) * 100) : 0
            },
            perAccount
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
