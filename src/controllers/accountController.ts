import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId, getSubordinateIds, getVisibleUserIds } from '../utils/hierarchyUtils';
import { Prisma } from '../generated/client';

// GET /api/accounts
export const getAccounts = async (req: Request, res: Response) => {
    try {
        const pageSize = Number(req.query.pageSize) || 10;
        const page = Number(req.query.page) || 1;
        const user = (req as any).user;
        const where: Prisma.AccountWhereInput = { isDeleted: false };

        // 1. Organisation Scoping
        if (user.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = String(req.query.organisationId);
            }
        } else {
            const orgId = getOrgId(user);
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
            if (user.branchId) where.branchId = user.branchId;
        }

        // 2. Hierarchy Visibility
        if (user.role !== 'super_admin' && user.role !== 'admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);
            // In Prisma: ownerId IN [...]
            where.ownerId = { in: visibleUserIds };
        }

        // Lightweight count-only mode for the web app's "Showing X of Y" indicator.
        if (req.query.countOnly === 'true') {
            const defaultTotal = await prisma.account.count({ where });
            return res.json({ total: defaultTotal });
        }

        // Filters
        if (req.query.type) where.type = String(req.query.type);
        if (req.query.industry) where.industry = String(req.query.industry);

        // Search
        if (req.query.search) {
            const search = String(req.query.search);
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { website: { contains: search, mode: 'insensitive' } },
                // JSON filtering for City (best effort for Prisma+PG)
                { address: { path: ['city'], string_contains: search } }
            ];
        }

        const count = await prisma.account.count({ where });
        const accounts = await prisma.account.findMany({
            where,
            include: {
                owner: { select: { firstName: true, lastName: true, email: true } }
            },
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { createdAt: 'desc' }
        });

        res.json({ accounts, page, pages: Math.ceil(count / pageSize), total: count });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/accounts
export const createAccount = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'Organisation context required' });

        // Custom Field Validation
        if (req.body.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Account', orgId, req.body.customFields);
        }

        const accountData: Prisma.AccountCreateInput = {
            name: req.body.name,
            industry: req.body.industry,
            website: req.body.website,
            size: req.body.size,
            annualRevenue: req.body.annualRevenue,
            address: req.body.address,
            phone: req.body.phone,
            type: req.body.type || 'prospect',
            customFields: req.body.customFields,
            tags: req.body.tags,

            organisation: { connect: { id: orgId } },
            owner: req.body.owner ? { connect: { id: req.body.owner } } : { connect: { id: user.id } },
            branch: user.branchId ? { connect: { id: user.branchId } } : (req.body.branchId ? { connect: { id: req.body.branchId } } : undefined),
        };

        const account = await prisma.account.create({
            data: accountData
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_ACCOUNT',
                entity: 'Account',
                entityId: account.id,
                actorId: user.id,
                organisationId: orgId,
                details: { name: account.name, type: account.type }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(account);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const getAccountById = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        const where: any = { id: req.params.id, isDeleted: false };
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
            if (user.branchId) where.branchId = user.branchId;

            // Previously org(+branch) membership was the only gate here - any user in
            // the org could view any other rep's account by ID regardless of ownership.
            if (user.role !== 'admin') {
                const visibleUserIds = await getVisibleUserIds(user.id);
                where.OR = [
                    { ownerId: { in: visibleUserIds } },
                    { ownerId: null }
                ];
            }
        }

        const account = await prisma.account.findFirst({
            where,
            include: {
                owner: { select: { firstName: true, lastName: true, email: true } },
                contacts: { select: { id: true, firstName: true, lastName: true, email: true } },
                opportunities: { select: { id: true, name: true, amount: true, stage: true } },
                accountProducts: {
                    include: { product: { select: { name: true, basePrice: true } } },
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        if (!account) return res.status(404).json({ message: 'Account not found' });
        res.json(account);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateAccount = async (req: Request, res: Response) => {
    try {
        const updates = { ...req.body };
        const accountId = req.params.id;

        if (updates.owner && typeof updates.owner === 'string') {
            updates.owner = { connect: { id: updates.owner } };
        }

        const requester = (req as any).user;
        const whereObj: any = { id: accountId };
        if (requester.role !== 'super_admin') {
            const orgId = getOrgId(requester);
            if (!orgId) return res.status(403).json({ message: 'No org' });
            whereObj.organisationId = orgId;
            if (requester.branchId) whereObj.branchId = requester.branchId;

            // Previously org(+branch) membership was the only gate here - any user in
            // the org could update any other rep's account by ID regardless of ownership.
            if (requester.role !== 'admin') {
                const visibleUserIds = await getVisibleUserIds(requester.id);
                whereObj.OR = [
                    { ownerId: { in: visibleUserIds } },
                    { ownerId: null }
                ];
            }
        }

        // Get current account for validation
        const currentAccount = await prisma.account.findUnique({ where: whereObj });
        if (!currentAccount) return res.status(404).json({ message: 'Account not found' });

        // Custom Field Validation
        if (updates.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Account', currentAccount.organisationId, updates.customFields);
        }

        const account = await prisma.account.update({
            where: whereObj,
            data: updates,
            include: {
                owner: { select: { firstName: true, lastName: true, email: true } }
            }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'UPDATE_ACCOUNT',
                entity: 'Account',
                entityId: accountId,
                actorId: requester.id,
                organisationId: account.organisationId,
                details: { name: account.name, updatedFields: Object.keys(updates) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json(account);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const deleteAccount = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const accountId = req.params.id;
        const orgId = getOrgId(user);

        // 1. Role Check
        if (user.role !== 'super_admin' && user.role !== 'admin') {
            return res.status(403).json({ message: 'Not authorized to delete accounts' });
        }

        const where: any = { id: accountId };
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
            if (user.branchId) where.branchId = user.branchId;
        }

        const account = await prisma.account.findFirst({ where });
        if (!account) return res.status(404).json({ message: 'Account not found' });

        // 2. Transaction for Cascading Soft-Delete
        await prisma.$transaction(async (tx) => {
            // Update Account
            await tx.account.update({
                where: { id: accountId },
                data: { isDeleted: true, deletedAt: new Date() }
            });

            // Update Contacts
            await tx.contact.updateMany({
                where: { accountId: accountId, organisationId: orgId || account.organisationId },
                data: { isDeleted: true, deletedAt: new Date() }
            });

            // Update Opportunities
            await tx.opportunity.updateMany({
                where: { accountId: accountId, organisationId: orgId || account.organisationId },
                data: { isDeleted: true, deletedAt: new Date() }
            });

            // Audit Log
            try {
                const { logAudit } = await import('../utils/auditLogger');
                logAudit({
                    action: 'DELETE_ACCOUNT',
                    entity: 'Account',
                    entityId: accountId,
                    actorId: user.id,
                    organisationId: orgId || account.organisationId,
                    details: { name: account.name }
                });
            } catch (e) {
                console.error('Audit Log Error:', e);
            }
        });

        res.json({ message: 'Account and related contacts/opportunities deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Add product to account (Asset)
export const addAccountProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { accountId } = req.params;
        const { productId, quantity, purchaseDate, serialNumber, status, notes, price, isFinalSale, customName } = req.body;

        if (!orgId) return res.status(400).json({ message: 'Organisation context required' });

        const account = await prisma.account.findFirst({
            where: { id: accountId, organisationId: orgId }
        });
        if (!account) return res.status(404).json({ message: 'Account not found' });

        const asset = await prisma.accountProduct.create({
            data: {
                accountId,
                productId,
                quantity: Number(quantity) || 1,
                purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
                serialNumber,
                status: status || 'active',
                notes,
                price: Number(price) || 0,
                customName,
                organisationId: orgId
            },
            include: { product: true }
        });

        await prisma.interaction.create({
            data: {
                accountId,
                type: 'note',
                subject: `Added Asset: ${customName || asset.product.name}`,
                description: `Added product: ${customName || asset.product.name} (Qty: ${asset.quantity})`,
                createdById: user.id,
                organisationId: orgId
            }
        });

        // 3. If it's a Final Sale (Upsell), create a closed_won Opportunity automatically
        if (isFinalSale === true) {
            const finalAmount = (Number(price) || 0) * (Number(quantity) || 1);
            const wonOpportunity = await prisma.opportunity.create({
                data: {
                    name: `Upsell: ${customName || asset.product.name} (${asset.quantity})`,
                    amount: finalAmount,
                    stage: 'closed_won',
                    probability: 100,
                    closeDate: new Date(),
                    description: `Automatically created from finalized asset purchase. Product: ${customName || asset.product.name}, Serial: ${serialNumber || 'N/A'}`,
                    type: 'UPSALE',
                    organisation: { connect: { id: orgId } },
                    owner: { connect: { id: user.id } },
                    account: { connect: { id: accountId } }
                }
            });
            import('../services/incentiveService').then(({ calculateIncentiveForOpportunity }) => {
                calculateIncentiveForOpportunity(wonOpportunity.id, user.id).catch(error => console.error('Incentive calculation error:', error));
            });
            console.log(`[Upsell] Created closed_won opportunity for account ${accountId} (Amount: ${finalAmount})`);
        }

        res.status(201).json(asset);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// Get account products
export const getAccountProducts = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { accountId } = req.params;

        const assets = await prisma.accountProduct.findMany({
            where: { accountId, organisationId: orgId || undefined },
            include: { product: true },
            orderBy: { createdAt: 'desc' }
        });

        res.json(assets);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
