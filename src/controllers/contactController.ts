import { Request, Response } from 'express';
import prisma from '../config/prisma'; // Use the configured instance with adapter
import { getOrgId, getSubordinateIds, getVisibleUserIds } from '../utils/hierarchyUtils'; // Use existing utils
import { Prisma } from '../generated/client';
import { phoneKeysFrom, ContactLinkService } from '../services/contactLinkService';
import { isAdmin } from '../utils/roleUtils';

// GET /api/contacts
export const getContacts = async (req: Request, res: Response) => {
    try {
        const pageSize = Number(req.query.pageSize) || 10;
        const page = Number(req.query.page) || 1;
        const user = (req as any).user;
        const where: Prisma.ContactWhereInput = { isDeleted: false };

        // 1. Organisation Scoping
        if (user.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = String(req.query.organisationId);
            }
        } else {
            const orgId = getOrgId(user);
            if (orgId) {
                where.organisationId = orgId;
            }
            if (user.branchId) {
                where.branchId = user.branchId;
            }
        }

        // 2. Hierarchy Visibility
        if (user.role !== 'super_admin' && user.role !== 'admin') {
            const visibleUserIds = await getVisibleUserIds(user.id);
            // In Prisma: ownerId IN [...]
            where.ownerId = { in: visibleUserIds };
        }

        // Blocked contacts live on their own list (GET /contacts/blocked).
        where.isBlocked = false;

        // Lightweight count-only mode for the web app's "Showing X of Y" indicator.
        if (req.query.countOnly === 'true') {
            const defaultTotal = await prisma.contact.count({ where });
            return res.json({ total: defaultTotal });
        }

        // Filter: Account
        if (req.query.account) {
            where.accountId = String(req.query.account);
        }

        // Filter: Search (OR condition)
        if (req.query.search) {
            const search = String(req.query.search);
            where.OR = [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { jobTitle: { contains: search, mode: 'insensitive' } },
                { phoneKeys: { has: search.replace(/\D/g, '').slice(-10) } },
            ];
        }

        const count = await prisma.contact.count({ where });
        const contacts = await prisma.contact.findMany({
            where,
            include: {
                account: { select: { name: true } },
                owner: { select: { firstName: true, lastName: true, email: true } }
            },
            skip: (page - 1) * pageSize,
            take: pageSize,
            orderBy: { createdAt: 'desc' }
        });

        res.json({ contacts, page, pages: Math.ceil(count / pageSize), total: count });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/contacts
export const createContact = async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!orgId) return res.status(400).json({ message: 'Organisation context required' });

        // Limit Check
        const org = await prisma.organisation.findUnique({
            where: { id: orgId },
            select: { contactLimit: true }
        });
        /*
        if (org && org.contactLimit > 0) {
            const count = await prisma.contact.count({
                where: { organisationId: orgId, isDeleted: false }
            });
            if (count >= org.contactLimit) {
                return res.status(403).json({
                    message: `Contact limit reached (${org.contactLimit}). Please upgrade your plan.`,
                    code: 'LIMIT_EXCEEDED',
                    limit: org.contactLimit
                });
            }
        }
        */

        const newKeys = phoneKeysFrom(req.body.phones);
        if (newKeys.length === 0) {
            return res.status(400).json({ message: 'A mobile number is required' });
        }
        const clash = await prisma.contact.findFirst({
            where: { organisationId: orgId, isDeleted: false, phoneKeys: { hasSome: newKeys } },
            select: { id: true, firstName: true, lastName: true }
        });
        if (clash) {
            return res.status(409).json({ message: `A contact with this number already exists (${clash.firstName} ${clash.lastName || ''})`.trim() });
        }

        if (email) {
            const existingContact = await prisma.contact.findFirst({
                where: {
                    email: email,
                    organisationId: orgId
                }
            });
            if (existingContact) {
                return res.status(409).json({ message: 'Contact with this email already exists' });
            }
        }

        const contactData: Prisma.ContactCreateInput = {
            firstName: req.body.firstName,
            lastName: req.body.lastName || '',
            email: req.body.email,
            phones: req.body.phones,
            phoneKeys: newKeys,
            jobTitle: req.body.jobTitle,
            department: req.body.department,
            address: req.body.address,
            socialProfiles: req.body.socialProfiles,
            customFields: req.body.customFields,
            tags: req.body.tags,

            // Relations
            organisation: { connect: { id: orgId } },
            owner: req.body.owner ? { connect: { id: req.body.owner } } : { connect: { id: user.id } },
            branch: user.branchId ? { connect: { id: user.branchId } } : (req.body.branchId ? { connect: { id: req.body.branchId } } : undefined),
        };

        if (req.body.account) {
            // Can be accountId string
            contactData.account = { connect: { id: req.body.account } };
        }

        // Custom Field Validation
        if (req.body.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Contact', orgId, req.body.customFields);
        }

        const contact = await prisma.contact.create({
            data: contactData
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_CONTACT',
                entity: 'Contact',
                entityId: contact.id,
                actorId: user.id,
                organisationId: orgId,
                details: { name: `${contact.firstName} ${contact.lastName}` }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(contact);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const getContactById = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        const where: any = { id: req.params.id, isDeleted: false };
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
            if (user.branchId) where.branchId = user.branchId;

            // Previously org(+branch) membership was the only gate here - any user in
            // the org could view any other rep's contact by ID regardless of ownership.
            if (user.role !== 'admin') {
                const visibleUserIds = await getVisibleUserIds(user.id);
                where.OR = [
                    { ownerId: { in: visibleUserIds } },
                    { ownerId: null }
                ];
            }
        }

        const contact = await prisma.contact.findFirst({
            where,
            include: {
                account: { select: { name: true } },
                owner: { select: { firstName: true, lastName: true, email: true } }
            }
        });

        if (!contact) return res.status(404).json({ message: 'Contact not found' });
        res.json(contact);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateContact = async (req: Request, res: Response) => {
    try {
        const updates = { ...req.body };
        const contactId = req.params.id;

        // Handle Relation Updates if IDs are passed as strings
        if (updates.account && typeof updates.account === 'string') {
            updates.account = { connect: { id: updates.account } };
        }
        if (updates.owner && typeof updates.owner === 'string') {
            updates.owner = { connect: { id: updates.owner } };
        }

        // Remove helper fields that might confusing Prisma if they are not in schema as scalars?
        // Actually Prisma update accepts `account: { connect: ... }`. 
        // If updates.account is "ID_STRING", passing it as `account: "ID_STRING"` to Prisma Update will fail.
        // So the remapping above is correct.

        // Fetch first to get Org ID for validation
        const currentContact = await prisma.contact.findUnique({ where: { id: contactId } });
        if (!currentContact) return res.status(404).json({ message: 'Contact not found' });

        if (updates.customFields) {
            const { CustomFieldValidationService } = await import('../services/customFieldValidationService');
            await CustomFieldValidationService.validateFields('Contact', currentContact.organisationId, updates.customFields);
        }

        const requester = (req as any).user;
        const whereObj: any = { id: contactId };
        if (requester.role !== 'super_admin') {
            const orgId = getOrgId(requester);
            if (!orgId) return res.status(403).json({ message: 'No org' });
            whereObj.organisationId = orgId;
            if (requester.branchId) whereObj.branchId = requester.branchId;

            // Previously org(+branch) membership was the only gate here - any user in
            // the org could update any other rep's contact by ID regardless of ownership.
            if (requester.role !== 'admin') {
                const visibleUserIds = await getVisibleUserIds(requester.id);
                whereObj.OR = [
                    { ownerId: { in: visibleUserIds } },
                    { ownerId: null }
                ];
            }
        }

        // Block state is only changed through the dedicated block/unblock endpoints.
        delete updates.isBlocked; delete updates.blockedAt; delete updates.blockedById; delete updates.blockedReason; delete updates.phoneKeys;
        if (updates.phones !== undefined) {
            const keys = phoneKeysFrom(updates.phones);
            if (keys.length > 0) {
                const clash = await prisma.contact.findFirst({
                    where: { organisationId: currentContact.organisationId, isDeleted: false, id: { not: contactId }, phoneKeys: { hasSome: keys } },
                    select: { firstName: true, lastName: true }
                });
                if (clash) return res.status(409).json({ message: `Another contact already uses this number (${clash.firstName} ${clash.lastName || ''})`.trim() });
            }
            updates.phoneKeys = keys;
        }

        const contact = await prisma.contact.update({
            where: whereObj,
            data: updates,
            include: {
                account: { select: { name: true } },
                owner: { select: { firstName: true, lastName: true, email: true } }
            }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'UPDATE_CONTACT',
                entity: 'Contact',
                entityId: contactId,
                actorId: requester.id,
                organisationId: contact.organisationId,
                details: { name: `${contact.firstName} ${contact.lastName}`, updatedFields: Object.keys(updates) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json(contact);
    } catch (error) {
        // Prisma error handling (e.g. RecordNotFound)
        res.status(400).json({ message: (error as Error).message });
    }
};

export const deleteContact = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        const where: any = { id: req.params.id };
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;

            // Previously org membership was the only gate here - any user in the org
            // could delete any other rep's contact by ID regardless of ownership.
            if (user.role !== 'admin') {
                const visibleUserIds = await getVisibleUserIds(user.id);
                where.OR = [
                    { ownerId: { in: visibleUserIds } },
                    { ownerId: null }
                ];
            }
        }

        await prisma.contact.update({
            where,
            data: { isDeleted: true, deletedAt: new Date() }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            const contact = await prisma.contact.findUnique({ where: { id: req.params.id } });
            if (contact) {
                logAudit({
                    action: 'DELETE_CONTACT',
                    entity: 'Contact',
                    entityId: contact.id,
                    actorId: user.id,
                    organisationId: contact.organisationId,
                    details: { name: `${contact.firstName} ${contact.lastName}` }
                });
            }
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({ message: 'Contact deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};


// ---- Contact <-> Lead linking & block list -------------------------------------------

const scopedContactWhere = async (req: Request, id?: string) => {
    const user = (req as any).user;
    const where: any = { isDeleted: false };
    if (id) where.id = id;
    if (user.role !== 'super_admin') {
        const orgId = getOrgId(user);
        if (!orgId) return null;
        where.organisationId = orgId;
    }
    return where;
};

// GET /api/contacts/blocked
export const getBlockedContacts = async (req: Request, res: Response) => {
    try {
        const where = await scopedContactWhere(req);
        if (!where) return res.status(403).json({ message: 'User has no organisation' });
        where.isBlocked = true;
        const contacts = await prisma.contact.findMany({
            where,
            orderBy: { blockedAt: 'desc' },
            select: { id: true, firstName: true, lastName: true, phones: true, blockedAt: true, blockedReason: true, blockedById: true }
        });
        res.json({ contacts });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/contacts/:id/block   { reason? }
export const blockContact = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!isAdmin(user)) return res.status(403).json({ message: 'Only admins can block a contact' });
        const where = await scopedContactWhere(req, req.params.id);
        if (!where) return res.status(403).json({ message: 'User has no organisation' });
        const found = await prisma.contact.findFirst({ where, select: { id: true, phoneKeys: true, organisationId: true } });
        if (!found) return res.status(404).json({ message: 'Contact not found' });
        if (found.phoneKeys.length === 0) return res.status(400).json({ message: 'Contact has no phone number to block' });
        const contact = await prisma.contact.update({
            where: { id: found.id },
            data: { isBlocked: true, blockedAt: new Date(), blockedById: user.id, blockedReason: req.body?.reason || null }
        });
        const { logAudit } = await import('../utils/auditLogger');
        logAudit({ action: 'BLOCK_CONTACT', entity: 'Contact', entityId: contact.id, actorId: user.id, organisationId: contact.organisationId, details: { name: `${contact.firstName} ${contact.lastName}` } });
        res.json(contact);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// POST /api/contacts/:id/unblock
export const unblockContact = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!isAdmin(user)) return res.status(403).json({ message: 'Only admins can unblock a contact' });
        const where = await scopedContactWhere(req, req.params.id);
        if (!where) return res.status(403).json({ message: 'User has no organisation' });
        const found = await prisma.contact.findFirst({ where, select: { id: true } });
        if (!found) return res.status(404).json({ message: 'Contact not found' });
        const contact = await prisma.contact.update({
            where: { id: found.id },
            data: { isBlocked: false, blockedAt: null, blockedById: null, blockedReason: null }
        });
        const { logAudit } = await import('../utils/auditLogger');
        logAudit({ action: 'UNBLOCK_CONTACT', entity: 'Contact', entityId: contact.id, actorId: user.id, organisationId: contact.organisationId, details: { name: `${contact.firstName} ${contact.lastName}` } });
        res.json(contact);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/contacts/:id/leads - every lead that came in on this contact's number(s)
export const getContactLeads = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const where = await scopedContactWhere(req, req.params.id);
        if (!where) return res.status(403).json({ message: 'User has no organisation' });
        const contact = await prisma.contact.findFirst({ where, select: { phoneKeys: true, organisationId: true } });
        if (!contact) return res.status(404).json({ message: 'Contact not found' });
        let leads = await ContactLinkService.findLeadsForKeys(contact.organisationId, contact.phoneKeys);
        // Reps only see leads they're allowed to see.
        if (!isAdmin(user) && user.role !== 'super_admin') {
            const visible = new Set(await getVisibleUserIds(user.id));
            leads = leads.filter((l) => l.assignedToId && visible.has(l.assignedToId));
        }
        res.json({ leads });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

// GET /api/contacts/by-lead/:leadId - contact(s) saved for a lead's number (lead detail badge)
export const getContactsForLead = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
        const lead = await prisma.lead.findFirst({
            where: { id: req.params.leadId, organisationId: orgId },
            select: { phone: true, secondaryPhone: true }
        });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        const contacts = await ContactLinkService.findContactsForPhones(orgId, [lead.phone, lead.secondaryPhone]);
        res.json({ contacts });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
