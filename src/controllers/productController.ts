import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { Prisma } from '../generated/client';
import { isOrgAdmin } from '../utils/roleUtils';

export const getProducts = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string || '1');
        const limit = parseInt(req.query.limit as string || '20');
        const search = req.query.search as string;
        const skip = (page - 1) * limit;
        const user = (req as any).user;

        const where: Prisma.ProductWhereInput = { isDeleted: false };

        // Organisation Scoping
        if (user.role === 'super_admin') {
            if (req.query.organisationId) {
                where.organisationId = String(req.query.organisationId);
            }
        } else {
            const orgId = getOrgId(user);
            if (!orgId) return res.status(403).json({ message: 'User not associated with an organisation' });
            where.organisationId = orgId;

            // Branch Scoping
            if (user.branchId) {
                where.OR = [
                    { branchId: user.branchId },
                    { branchId: null }
                ];
            }
        }

        // Lightweight count-only mode for the web app's "Showing X of Y" indicator —
        // same org/branch scoping as above, before the search filter below.
        if (req.query.countOnly === 'true') {
            const defaultTotal = await prisma.product.count({ where });
            return res.json({ total: defaultTotal });
        }

        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { sku: { contains: search, mode: 'insensitive' } },
                { category: { contains: search, mode: 'insensitive' } }
            ];
        }

        const count = await prisma.product.count({ where });
        const products = await prisma.product.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            products,
            page,
            totalPages: Math.ceil(count / limit),
            totalProducts: count
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!isOrgAdmin(user)) {
            return res.status(403).json({ message: 'Only admins can create products' });
        }

        if (!orgId) return res.status(403).json({ message: 'No org' });

        // branchId: explicit selection from the Add Product form - "" or null means
        // "All Branches" (org-wide, visible regardless of the viewer's branch - see
        // the branch-scoping OR in getProducts above). Falls back to the creator's
        // own branch only when the field is omitted entirely (older callers),
        // matching the previous hardcoded default.
        const branchIdProvided = Object.prototype.hasOwnProperty.call(req.body, 'branchId');
        const requestedBranchId: string | null = branchIdProvided ? (req.body.branchId || null) : (user.branchId || null);

        if (requestedBranchId) {
            const branch = await prisma.branch.findFirst({ where: { id: requestedBranchId, organisationId: orgId, isDeleted: false } });
            if (!branch) {
                return res.status(400).json({ message: 'Selected branch not found in your organisation' });
            }
        }

        const product = await prisma.product.create({
            data: {
                name: req.body.name,
                sku: req.body.sku,
                description: req.body.description,
                basePrice: Number(req.body.basePrice),
                category: req.body.category,
                tags: req.body.tags,
                // Previously dropped on create even though the Add Product form
                // already sends them - a new product always landed Active with no
                // brochure attached regardless of what was chosen/uploaded.
                isActive: req.body.isActive !== undefined ? Boolean(req.body.isActive) : undefined,
                isCustom: req.body.isCustom !== undefined ? Boolean(req.body.isCustom) : undefined,
                brochureUrl: req.body.brochureUrl,
                organisation: { connect: { id: orgId } },
                createdBy: { connect: { id: user.id } },
                ...(requestedBranchId ? { branch: { connect: { id: requestedBranchId } } } : {})
            }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_PRODUCT',
                entity: 'Product',
                entityId: product.id,
                actorId: user.id,
                organisationId: orgId,
                details: { name: product.name, sku: product.sku }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(product);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const getProductById = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const where: any = { id: req.params.id, isDeleted: false };

        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
        }

        const product = await prisma.product.findFirst({ where });
        if (!product) return res.status(404).json({ message: 'Product not found' });
        res.json(product);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { id } = req.params;

        if (!isOrgAdmin(user)) {
            return res.status(403).json({ message: 'Only admins can update products' });
        }

        // First, verify the product exists and belongs to the organization
        const existingProduct = await prisma.product.findUnique({
            where: { id }
        });

        if (!existingProduct) {
            return res.status(404).json({ message: 'Product not found' });
        }

        // Check organization ownership (unless super admin)
        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            if (existingProduct.organisationId !== orgId) {
                return res.status(403).json({ message: 'Not authorized to update this product' });
            }
        }

        // branchId: "" or null from the Edit form means "All Branches" (cleared to
        // org-wide); a specific id must actually belong to this org, or a mis-sent
        // id would silently scope the product to a branch nothing can manage it from.
        if (Object.prototype.hasOwnProperty.call(req.body, 'branchId')) {
            req.body.branchId = req.body.branchId || null;
            if (req.body.branchId) {
                const branch = await prisma.branch.findFirst({ where: { id: req.body.branchId, organisationId: existingProduct.organisationId, isDeleted: false } });
                if (!branch) {
                    return res.status(400).json({ message: 'Selected branch not found in this organisation' });
                }
            }
        }

        // Update the product
        const product = await prisma.product.update({
            where: { id },
            data: req.body
        });

        // Audit Log
        const { logAudit } = await import('../utils/auditLogger');
        logAudit({
            action: 'UPDATE_PRODUCT',
            entity: 'Product',
            entityId: product.id,
            actorId: user.id,
            organisationId: product.organisationId,
            details: { name: product.name, sku: product.sku }
        });

        res.json(product);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteProduct = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);

        if (!isOrgAdmin(user)) {
            return res.status(403).json({ message: 'Only admins can delete products' });
        }

        const where: any = { id: req.params.id };

        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
        }

        const product = await prisma.product.findFirst({ where });
        if (!product) return res.status(404).json({ message: 'Product not found' });

        await prisma.product.update({
            where: { id: req.params.id },
            data: { isDeleted: true, deletedAt: new Date() }
        });

        // Audit Log
        const { logAudit } = await import('../utils/auditLogger');
        logAudit({
            action: 'DELETE_PRODUCT',
            entity: 'Product',
            entityId: req.params.id,
            actorId: user.id,
            organisationId: product.organisationId,
            details: { name: product.name, sku: product.sku }
        });

        res.json({ message: 'Product deleted' });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getProductShareConfig = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { productId } = req.params;

        if (!orgId) return res.status(403).json({ message: 'No org' });

        const share = await prisma.productShare.findFirst({
            where: { productId, organisationId: orgId }
        });

        if (!share) {
            // Return empty config if not shared yet
            return res.json({
                youtubeUrl: '',
                customTitle: '',
                customDescription: ''
            });
        }

        res.json({
            youtubeUrl: share.youtubeUrl || '',
            customTitle: share.customTitle || '',
            customDescription: share.customDescription || '',
            slug: share.slug,
            views: share.views,
            url: `${process.env.CLIENT_URL || 'http://localhost:5173'}/shared-product/${share.slug}`
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const generateProductShareLink = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const { productId } = req.params;
        const { youtubeUrl, customTitle, customDescription, leadId } = req.body;

        if (!orgId) return res.status(403).json({ message: 'No org' });

        // Check if product exists and belongs to org
        const product = await prisma.product.findFirst({
            where: { id: productId, organisationId: orgId }
        });

        if (!product) return res.status(404).json({ message: 'Product not found' });

        // Check if share link already exists
        let share = await prisma.productShare.findFirst({
            where: { productId }
        });

        if (!share) {
            // Create new share link
            // Generate a random slug (8 chars)
            const slug = Math.random().toString(36).substring(2, 10);

            share = await prisma.productShare.create({
                data: {
                    productId,
                    organisationId: orgId,
                    createdById: user.id,
                    slug,
                    notificationsEnabled: true,
                    youtubeUrl,
                    customTitle,
                    customDescription
                }
            });
        } else {
            // Update existing share with new details if provided
            share = await prisma.productShare.update({
                where: { id: share.id },
                data: {
                    youtubeUrl,
                    customTitle,
                    customDescription
                }
            });
        }

        // Create timeline entry if leadId is provided
        if (leadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
            try {
                const lead = await prisma.lead.findUnique({
                    where: { id: leadId, organisationId: orgId },
                    select: { id: true, firstName: true, lastName: true }
                });

                if (lead) {
                    // Create interaction record for timeline
                    await prisma.interaction.create({
                        data: {
                            type: 'other',
                            direction: 'outbound',
                            subject: `Product Link Shared: ${product.name}`,
                            description: `Shareable product link for "${product.name}" was generated and sent to ${lead.firstName} ${lead.lastName}.`,
                            date: new Date(),
                            leadId: lead.id,
                            createdById: user.id,
                            organisationId: orgId
                        }
                    });
                }
            } catch (e) {
                console.error('Error creating timeline entry for share:', e);
            }
        }

        const baseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const shareUrl = `${baseUrl}/shared-product/${share.slug}`;

        res.json({
            slug: share.slug,
            url: shareUrl,
            views: share.views,
            youtubeUrl: share.youtubeUrl,
            customTitle: share.customTitle,
            customDescription: share.customDescription
        });

    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const getSharedProduct = async (req: Request, res: Response) => {
    try {
        const { slug } = req.params;
        const leadId = req.query.leadId as string | undefined;

        const share = await prisma.productShare.findUnique({
            where: { slug },
            include: {
                product: true,
                createdBy: { select: { firstName: true, lastName: true, id: true, email: true, phone: true } },
                organisation: { select: { isDeleted: true, name: true } }
            }
        });

        if (!share) return res.status(404).json({ message: 'Product link not found' });

        // Security checks: ensure product and organisation are not deleted
        if (share.product.isDeleted || share.organisation.isDeleted) {
            return res.status(404).json({ message: 'Product is no longer available' });
        }

        // Increment views (async, don't await)
        prisma.productShare.update({
            where: { id: share.id },
            data: { views: { increment: 1 } }
        }).catch(console.error);

        // Log interaction in lead timeline if leadId is provided
        if (leadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
            try {
                const lead = await prisma.lead.findUnique({
                    where: { id: leadId },
                    select: { id: true, firstName: true, lastName: true, company: true, organisationId: true }
                });

                if (lead) {
                    // Create interaction record for timeline
                    await prisma.interaction.create({
                        data: {
                            type: 'other',
                            direction: 'outbound',
                            subject: `Product Shared: ${share.product.name}`,
                            description: `Product "${share.product.name}" was shared with this lead. The lead viewed the product details via shareable link.`,
                            date: new Date(),
                            leadId: lead.id,
                            createdById: share.createdById,
                            organisationId: lead.organisationId
                        }
                    });
                }
            } catch (e) {
                console.error('Error creating timeline interaction:', e);
            }
        }

        // Send Notification (if enabled)
        if (share.notificationsEnabled) {
            const { NotificationService } = await import('../services/notificationService');
            const { getIO } = await import('../socket');
            const viewedAt = new Date();
            const time = viewedAt.toLocaleString('en-US', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });
            let viewerName = 'A customer';
            let leadInfo = null;

            // If leadId is provided, try to fetch lead details (with UUID validation)
            if (leadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
                try {
                    const lead = await prisma.lead.findUnique({
                        where: { id: leadId },
                        select: { id: true, firstName: true, lastName: true, company: true, phone: true, email: true }
                    });
                    if (lead) {
                        viewerName = `${lead.firstName} ${lead.lastName}${lead.company ? ` from ${lead.company}` : ''}`;
                        leadInfo = {
                            id: lead.id,
                            name: `${lead.firstName} ${lead.lastName}`,
                            company: lead.company,
                            phone: lead.phone,
                            email: lead.email
                        };
                    }
                } catch (e) {
                    console.error('Error fetching lead for view tracking:', e);
                }
            }

            const notificationMessage = `${viewerName} viewed your product "${share.product.name}" at ${time}.`;

            // Send database notification
            NotificationService.send(
                share.createdById,
                'Product Viewed',
                notificationMessage,
                'info'
            ).catch(console.error);

            // Send real-time Socket.io notification
            const io = getIO();
            if (io) {
                io.to(share.createdById).emit('product_view_notification', {
                    type: 'product_view',
                    title: 'Product Viewed',
                    message: notificationMessage,
                    productId: share.product.id,
                    productName: share.product.name,
                    shareSlug: share.slug,
                    viewedAt: viewedAt.toISOString(),
                    viewerName,
                    lead: leadInfo,
                    timestamp: Date.now()
                });
                console.log(`[Real-time] Product view notification sent to user ${share.createdById}`);
            }
        }

        // Fetch lead data if leadId is provided
        let leadData = null;
        if (leadId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
            try {
                const lead = await prisma.lead.findUnique({
                    where: { id: leadId },
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        phone: true,
                        company: true,
                        organisationId: true
                    }
                });
                if (lead) {
                    leadData = {
                        firstName: lead.firstName,
                        lastName: lead.lastName,
                        phone: lead.phone
                    };
                }
            } catch (e) {
                console.error('Error fetching lead data:', e);
            }
        }

        res.json({
            product: share.product,
            seller: share.createdBy,
            organisation: {
                name: share.organisation.name
            },
            shareConfig: {
                youtubeUrl: share.youtubeUrl,
                customTitle: share.customTitle,
                customDescription: share.customDescription,
                createdAt: share.createdAt
            },
            lead: leadData
        });

        // Debug logging
        console.log('Shared product data sent:', {
            productName: share.product.name,
            hasBrochure: !!share.product.brochureUrl,
            brochureUrl: share.product.brochureUrl,
            hasYoutubeUrl: !!share.youtubeUrl,
            youtubeUrl: share.youtubeUrl,
            customTitle: share.customTitle,
            customDescription: share.customDescription
        });

    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};
