
import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';

export const getWebForms = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const webForms = await prisma.webForm.findMany({
            where: { organisationId: orgId, isDeleted: false },
            orderBy: { createdAt: 'desc' }
        });

        // Calculate submissionsCount for each form
        // Submissions are leads with source 'website' and sourceDetails content linking to the form
        const formsWithCounts = await Promise.all(webForms.map(async (form) => {
            const count = await prisma.lead.count({
                where: {
                    organisationId: orgId,
                    source: 'website',
                    isDeleted: false,
                    OR: [
                        { customFields: { path: ['webFormId'], equals: form.id } },
                        { sourceDetails: { path: ['webFormId'], equals: form.id } }
                    ]
                }
            });
            return {
                ...form,
                submissionsCount: count
            };
        }));

        res.json(formsWithCounts);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createWebForm = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const webForm = await prisma.webForm.create({
            data: {
                ...req.body,
                organisationId: orgId,
                createdById: user.id
            }
        });
        res.status(201).json(webForm);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const updateWebForm = async (req: Request, res: Response) => {
    try {
        const webForm = await prisma.webForm.update({
            where: { id: req.params.id },
            data: req.body
        });
        res.json(webForm);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteWebForm = async (req: Request, res: Response) => {
    try {
        await prisma.webForm.update({
            where: { id: req.params.id },
            data: { isDeleted: true }
        });
        res.json({ message: 'WebForm deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * Lists the leads captured by a given web form, org-scoped.
 * GET /api/web-forms/:id/submissions
 */
export const getWebFormSubmissions = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const { id } = req.params;
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 20;

        const webForm = await prisma.webForm.findFirst({
            where: { id, organisationId: orgId, isDeleted: false }
        });
        if (!webForm) return res.status(404).json({ message: 'Form not found' });

        const where = {
            organisationId: orgId,
            source: 'website' as const,
            isDeleted: false,
            OR: [
                { customFields: { path: ['webFormId'], equals: id } },
                { sourceDetails: { path: ['webFormId'], equals: id } }
            ] as any
        };

        const [submissions, total] = await Promise.all([
            prisma.lead.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                    company: true,
                    customFields: true,
                    createdAt: true,
                    isReEnquiry: true
                }
            }),
            prisma.lead.count({ where })
        ]);

        res.json({
            form: { id: webForm.id, name: webForm.name, fields: webForm.fields },
            submissions,
            pagination: { total, page, limit, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * Public, unauthenticated: returns the safe-to-render definition of an active form.
 * GET /api/public/webforms/:id
 */
export const getPublicWebForm = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const webForm = await prisma.webForm.findUnique({ where: { id, isDeleted: false } });
        if (!webForm || !webForm.isActive) {
            return res.status(404).json({ message: 'Form not found or inactive' });
        }
        res.json({
            id: webForm.id,
            name: webForm.name,
            description: webForm.description,
            fields: webForm.fields,
            submitAction: webForm.submitAction,
            submitMessage: webForm.submitMessage,
            redirectUrl: webForm.redirectUrl
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

/**
 * Public endpoint for submitting a web form
 * POST /api/public/webforms/:id/submit
 */
export const submitWebForm = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const formData = req.body;

        const webForm = await prisma.webForm.findUnique({
            where: { id, isDeleted: false }
        });

        if (!webForm || !webForm.isActive) {
            return res.status(404).json({ message: 'Form not found or inactive' });
        }

        const orgId = webForm.organisationId;

        // Sanitize phone: keep all digits for the service to handle normalization
        let cleanPhone = formData.phone?.toString().replace(/\D/g, '') || '';

        // Resolve target branch early to isolate duplicate check
        let targetBranchId = null;

        const { DistributionService } = await import('../services/distributionService');
        // Simulate assignment to find target owner and their branch
            const assignedUserId = await DistributionService.assignLead(
                { ...formData, organisationId: orgId }, 
                orgId
            );
            if (assignedUserId) {
                const assignedUser = await prisma.user.findUnique({
                    where: { id: assignedUserId },
                    select: { branchId: true }
                });
                if (assignedUser?.branchId) targetBranchId = assignedUser.branchId;
            }
        // Check for duplicates in the RESOLVED branch
        const { DuplicateLeadService } = await import('../services/duplicateLeadService');
        const duplicateCheck = await DuplicateLeadService.checkDuplicate(
            cleanPhone, 
            formData.email, 
            orgId, 
            targetBranchId || undefined
        );

        if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
            // Handle as re-enquiry
            await DuplicateLeadService.handleReEnquiry(
                duplicateCheck.existingLead,
                {
                    firstName: formData.firstName || 'Unknown',
                    lastName: formData.lastName || '',
                    email: formData.email,
                    phone: cleanPhone,
                    company: formData.company,
                    source: 'website',
                    sourceDetails: { webFormId: id, ...formData.customFields }
                },
                orgId
            );

            return res.status(200).json({
                message: 'Thank you for your interest! We will contact you soon.',
                isReEnquiry: true
            });
        }

        // 1. Create Lead with resolved assignment
        const lead = await prisma.lead.create({
            data: {
                firstName: formData.firstName || 'Unknown',
                lastName: formData.lastName || '',
                email: formData.email,
                phone: cleanPhone,
                company: formData.company,
                source: 'website',
                organisationId: orgId,
                assignedToId: assignedUserId || undefined,
                branchId: targetBranchId,
                customFields: {
                    webFormId: id,
                    ...formData.customFields
                }
            }
        });

        // 3. AI Scoring
        const { LeadScoringService } = await import('../services/leadScoringService');
        LeadScoringService.scoreLead(lead.id).catch(console.error);

        res.status(201).json({
            message: 'Form submitted successfully',
            leadId: lead.id
        });

    } catch (error) {
        console.error('[WebFormSubmit] Error:', error);
        res.status(400).json({ message: (error as Error).message });
    }
};
