import { ContactLinkService } from '../services/contactLinkService';
import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId, getSubordinateIds, getVisibleUserIds } from '../utils/hierarchyUtils';
import { DistributionService } from '../services/distributionService';
import { WorkflowEngine } from '../services/workflowEngine';
import { LeadSource } from '../generated/client';
import { logger } from '../utils/logger';
import { ResponseHandler } from '../utils/apiResponse';
import { leadValidation, sanitizeObject } from '../utils/validation';

/**
 * Enhanced Lead Controller with comprehensive error handling and validation
 * This serves as an example of best practices for other controllers
 */

// GET /api/leads - Enhanced with better error handling
export const getLeadsEnhanced = async (req: Request, res: Response) => {
    const user = (req as any).user;
    const userId = user?.id;
    const organisationId = getOrgId(user);

    try {
        logger.apiRequest('GET', '/api/leads', userId, organisationId || undefined, req.query);

        // Validate pagination parameters
        const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
        const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 10));
        const skip = (page - 1) * limit;

        const where: any = { isDeleted: false };

        // 1. Organisation Scoping with validation
        if (user.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = req.query.organisationId as string;
            }
        } else {
            if (!organisationId) {
                logger.authError('User has no organisation', undefined, { userId });
                return ResponseHandler.forbidden(res, 'User not associated with an organisation');
            }
            where.organisationId = organisationId;
        }

        // 2. Hierarchy Visibility
        if (user.role !== 'super_admin' && user.role !== 'admin') {
            try {
                const visibleUserIds = await getVisibleUserIds(user.id);
                where.assignedToId = { in: visibleUserIds };
                logger.debug('Applied hierarchy filter', 'LEADS', userId, organisationId || undefined, { visibleCount: visibleUserIds.length });
            } catch (error) {
                logger.error('Failed to get subordinate IDs', error, 'LEADS', userId, organisationId || undefined);
                return ResponseHandler.serverError(res, 'Failed to apply access controls');
            }
        }

        // 3. Apply filters with validation
        if (req.query.status) {
            where.status = req.query.status as string;
        }

        if (req.query.source && Object.values(LeadSource).includes(req.query.source as LeadSource)) {
            where.source = req.query.source as LeadSource;
        }

        // 4. Search with sanitization
        if (req.query.search) {
            const search = String(req.query.search).trim().substring(0, 100); // Limit search length
            if (search.length > 0) {
                where.OR = [
                    { firstName: { contains: search, mode: 'insensitive' } },
                    { lastName: { contains: search, mode: 'insensitive' } },
                    { email: { contains: search, mode: 'insensitive' } },
                    { company: { contains: search, mode: 'insensitive' } }
                ];
            }
        }

        // 5. Execute queries with error handling
        const [leads, total] = await Promise.all([
            prisma.lead.findMany({
                where,
                include: {
                    assignedTo: { select: { id: true, firstName: true, lastName: true } }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }).catch(error => {
                logger.dbError('findMany', 'Lead', error, userId, organisationId || undefined);
                throw new Error('Failed to fetch leads');
            }),

            prisma.lead.count({ where }).catch(error => {
                logger.dbError('count', 'Lead', error, userId, organisationId || undefined);
                throw new Error('Failed to count leads');
            })
        ]);

        logger.info(`Retrieved ${leads.length} leads (page ${page})`, 'LEADS', userId, organisationId || undefined);

        return ResponseHandler.paginated(res, leads, page, limit, total, 'Leads retrieved successfully');

    } catch (error: any) {
        logger.apiError('GET', '/api/leads', error, userId, organisationId || undefined);

        if (error.message.includes('Failed to')) {
            return ResponseHandler.serverError(res, error.message);
        }

        return ResponseHandler.serverError(res, 'An unexpected error occurred while fetching leads');
    }
};

// POST /api/leads - Enhanced with comprehensive validation
export const createLeadEnhanced = async (req: Request, res: Response) => {
    const user = (req as any).user;
    const userId = user?.id;
    const organisationId = getOrgId(user);

    try {
        logger.apiRequest('POST', '/api/leads', userId, organisationId || undefined, req.body);

        // 1. Validate organisation access
        if (!organisationId) {
            logger.authError('User has no organisation for lead creation', undefined, { userId });
            return ResponseHandler.forbidden(res, 'User not associated with an organisation');
        }

        // 2. Sanitize and validate input
        const allowedFields = ['firstName', 'lastName', 'email', 'phone', 'secondaryPhone', 'company', 'source', 'status', 'leadScore', 'notes'];
        const sanitizedData = sanitizeObject(req.body, allowedFields);

        // 3. Validate required fields
        const validationErrors: string[] = [];

        if (!leadValidation.firstName(sanitizedData.firstName)) {
            validationErrors.push('First name is required and must be 1-50 characters');
        }

        if (!leadValidation.lastName(sanitizedData.lastName)) {
            validationErrors.push('Last name is required and must be 1-50 characters');
        }

        if (!leadValidation.email(sanitizedData.email)) {
            validationErrors.push('Valid email address is required');
        }

        if (sanitizedData.phone && !leadValidation.phone(sanitizedData.phone)) {
            validationErrors.push('Phone number format is invalid');
        }

        if (validationErrors.length > 0) {
            logger.warn('Lead creation validation failed', 'LEADS', userId, organisationId || undefined, { errors: validationErrors });
            return ResponseHandler.validationError(res, validationErrors);
        }

        // 4. Check for duplicate email
        const existingLead = await prisma.lead.findFirst({
            where: {
                email: sanitizedData.email,
                organisationId,
                isDeleted: false
            }
        }).catch(error => {
            logger.dbError('findFirst', 'Lead', error, userId, organisationId || undefined);
            throw new Error('Failed to check for duplicate leads');
        });

        if (existingLead) {
            logger.warn('Attempted to create duplicate lead', 'LEADS', userId, organisationId || undefined, { email: sanitizedData.email });
            return ResponseHandler.validationError(res, 'A lead with this email already exists');
        }

        if (sanitizedData.phone && await ContactLinkService.isBlocked(organisationId, sanitizedData.phone)) {
            return ResponseHandler.validationError(res, 'This number is blocked');
        }

        // 5. Create lead with error handling
        const leadData = {
            ...sanitizedData,
            organisationId,
            createdById: userId,
            source: sanitizedData.source || LeadSource.manual,
            status: sanitizedData.status || "new",
            leadScore: sanitizedData.leadScore || 0
        };

        const newLead = await prisma.lead.create({
            data: leadData,
            include: {
                assignedTo: { select: { id: true, firstName: true, lastName: true } }
            }
        }).catch(error => {
            logger.dbError('create', 'Lead', error, userId, organisationId || undefined);
            throw new Error('Failed to create lead');
        });

        // 6. Apply distribution rules (non-blocking)
        try {
            await DistributionService.assignLead(newLead, organisationId, undefined, userId);
            logger.info('Lead distribution applied', 'LEADS', userId, organisationId || undefined, { leadId: newLead.id });
        } catch (error) {
            logger.error('Lead distribution failed', error, 'LEADS', userId, organisationId || undefined, { leadId: newLead.id });
            // Don't fail the request if distribution fails
        }

        // 7. Trigger workflows (non-blocking)
        try {
            await WorkflowEngine.evaluate('lead', 'created', newLead, organisationId);
            logger.info('Lead workflows triggered', 'LEADS', userId, organisationId || undefined, { leadId: newLead.id });
        } catch (error) {
            logger.error('Lead workflow trigger failed', error, 'LEADS', userId, organisationId || undefined, { leadId: newLead.id });
            // Don't fail the request if workflows fail
        }

        logger.info('Lead created successfully', 'LEADS', userId, organisationId || undefined, { leadId: newLead.id });
        return ResponseHandler.created(res, newLead, 'Lead created successfully');

    } catch (error: any) {
        logger.apiError('POST', '/api/leads', error, userId, organisationId || undefined);

        if (error.message.includes('Failed to')) {
            return ResponseHandler.serverError(res, error.message);
        }

        return ResponseHandler.serverError(res, 'An unexpected error occurred while creating the lead');
    }
};

// PUT /api/leads/:id - Enhanced with validation and error handling
export const updateLeadEnhanced = async (req: Request, res: Response) => {
    const user = (req as any).user;
    const userId = user?.id;
    const organisationId = getOrgId(user);
    const leadId = req.params.id;

    try {
        logger.apiRequest('PUT', `/api/leads/${leadId}`, userId, organisationId || undefined, req.body);

        // 1. Validate lead ID format
        if (!leadId || leadId.length < 10) {
            return ResponseHandler.validationError(res, 'Invalid lead ID format');
        }

        // 2. Check if lead exists and user has access
        const existingLead = await prisma.lead.findFirst({
            where: {
                id: leadId,
                organisationId: organisationId || undefined,
                isDeleted: false
            }
        }).catch(error => {
            logger.dbError('findFirst', 'Lead', error, userId, organisationId || undefined);
            throw new Error('Failed to fetch lead');
        });

        if (!existingLead) {
            logger.warn('Attempted to update non-existent lead', 'LEADS', userId, organisationId || undefined, { leadId });
            return ResponseHandler.notFound(res, 'Lead not found');
        }

        // 3. Sanitize and validate update data
        const allowedFields = ['firstName', 'lastName', 'email', 'phone', 'secondaryPhone', 'company', 'source', 'status', 'leadScore', 'notes'];
        const sanitizedData = sanitizeObject(req.body, allowedFields);

        // 4. Validate updated fields
        const validationErrors: string[] = [];

        if (sanitizedData.firstName && !leadValidation.firstName(sanitizedData.firstName)) {
            validationErrors.push('First name must be 1-50 characters');
        }

        if (sanitizedData.lastName && !leadValidation.lastName(sanitizedData.lastName)) {
            validationErrors.push('Last name must be 1-50 characters');
        }

        if (sanitizedData.email && !leadValidation.email(sanitizedData.email)) {
            validationErrors.push('Valid email address is required');
        }

        if (sanitizedData.phone && !leadValidation.phone(sanitizedData.phone)) {
            validationErrors.push('Phone number format is invalid');
        }

        if (validationErrors.length > 0) {
            logger.warn('Lead update validation failed', 'LEADS', userId, organisationId || undefined, { errors: validationErrors, leadId });
            return ResponseHandler.validationError(res, validationErrors);
        }

        // 5. Check for duplicate email if email is being updated
        if (sanitizedData.email && sanitizedData.email !== existingLead.email) {
            const duplicateLead = await prisma.lead.findFirst({
                where: {
                    email: sanitizedData.email,
                    organisationId: organisationId || '',
                    isDeleted: false,
                    id: { not: leadId }
                }
            }).catch(error => {
                logger.dbError('findFirst', 'Lead', error, userId, organisationId || undefined);
                throw new Error('Failed to check for duplicate leads');
            });

            if (duplicateLead) {
                logger.warn('Attempted to update lead with duplicate email', 'LEADS', userId, organisationId || undefined, { email: sanitizedData.email, leadId });
                return ResponseHandler.validationError(res, 'A lead with this email already exists');
            }
        }

        // 5.5. Check for duplicate phone if phone is being updated
        if (sanitizedData.phone && sanitizedData.phone !== existingLead.phone) {
            const { DuplicateLeadService } = await import('../services/duplicateLeadService');
            const duplicateCheck = await DuplicateLeadService.checkDuplicate(
                sanitizedData.phone,
                undefined,
                organisationId || '',
                existingLead.branchId || undefined
            );
            
            if (duplicateCheck.isDuplicate && duplicateCheck.existingLead && duplicateCheck.existingLead.id !== leadId) {
                logger.warn('Attempted to update lead with duplicate phone', 'LEADS', userId, organisationId || undefined, { phone: sanitizedData.phone, leadId });
                return ResponseHandler.validationError(res, `A lead with this phone number already exists in this branch`);
            }
        }

        // 6. Update lead
        const updatedLead = await prisma.lead.update({
            where: { id: leadId },
            data: {
                ...sanitizedData,
                updatedAt: new Date()
            },
            include: {
                assignedTo: { select: { id: true, firstName: true, lastName: true } }
            }
        }).catch(error => {
            logger.dbError('update', 'Lead', error, userId, organisationId || undefined);
            throw new Error('Failed to update lead');
        });

        // 7. Trigger workflows for status changes (non-blocking)
        if (sanitizedData.status && sanitizedData.status !== existingLead.status) {
            try {
                await WorkflowEngine.evaluate('lead', 'updated', updatedLead, organisationId || '');
                logger.info('Lead status change workflows triggered', 'LEADS', userId, organisationId || undefined, { leadId, oldStatus: existingLead.status, newStatus: sanitizedData.status });
            } catch (error) {
                logger.error('Lead workflow trigger failed', error, 'LEADS', userId, organisationId || undefined, { leadId });
            }
        }

        logger.info('Lead updated successfully', 'LEADS', userId, organisationId || undefined, { leadId });
        return ResponseHandler.success(res, updatedLead, 'Lead updated successfully');

    } catch (error: any) {
        logger.apiError('PUT', `/api/leads/${leadId}`, error, userId, organisationId || undefined);

        if (error.message.includes('Failed to')) {
            return ResponseHandler.serverError(res, error.message);
        }

        return ResponseHandler.serverError(res, 'An unexpected error occurred while updating the lead');
    }
};