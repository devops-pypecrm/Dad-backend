import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { Prisma } from '../generated/client';

export const getWorkflows = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string || '1');
        const limit = parseInt(req.query.limit as string || '20');
        const search = req.query.search as string;
        const skip = (page - 1) * limit;
        const user = (req as any).user;

        const where: Prisma.WorkflowWhereInput = { isDeleted: false };
        const orgId = getOrgId(user);

        // Organisation Scoping
        if (user.role === 'super_admin') {
            if (req.query.organisationId) where.organisationId = String(req.query.organisationId);
        } else {
            if (!orgId) return res.status(403).json({ message: 'User has no organisation' });
            where.organisationId = orgId;
        }

        if (search) {
            where.name = { contains: search, mode: 'insensitive' };
        }

        // Optional filters. WhatsApp keyword automations are workflows triggered by "WhatsAppMessage";
        // they are managed inside the WhatsApp section, so the general Automation pages exclude them.
        if (typeof req.query.triggerEntity === 'string' && req.query.triggerEntity) {
            where.triggerEntity = req.query.triggerEntity;
        } else if (typeof req.query.excludeTriggerEntity === 'string' && req.query.excludeTriggerEntity) {
            where.triggerEntity = { not: req.query.excludeTriggerEntity };
        }
        if (req.query.isActive === 'true' || req.query.isActive === 'false') {
            where.isActive = req.query.isActive === 'true';
        }

        const count = await prisma.workflow.count({ where });
        const workflows = await prisma.workflow.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            workflows,
            page,
            totalPages: Math.ceil(count / limit),
            totalWorkflows: count
        });
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const createWorkflow = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        if (!orgId) return res.status(400).json({ message: 'No org' });

        const workflow = await prisma.workflow.create({
            data: {
                name: req.body.name,
                description: req.body.description,
                isActive: req.body.isActive !== undefined ? req.body.isActive : false,
                triggerEntity: req.body.triggerEntity,
                triggerEvent: req.body.triggerEvent,
                conditions: req.body.conditions,
                actions: req.body.actions,
                organisation: { connect: { id: orgId } },
                createdBy: { connect: { id: user.id } }
            }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'CREATE_WORKFLOW',
                entity: 'Workflow',
                entityId: workflow.id,
                actorId: user.id,
                organisationId: orgId,
                details: { name: workflow.name, triggerEntity: workflow.triggerEntity }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.status(201).json(workflow);
    } catch (error) {
        res.status(400).json({ message: (error as Error).message });
    }
};

export const getWorkflowById = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const where: any = { id: req.params.id, isDeleted: false };

        if (user.role !== 'super_admin') {
            if (!orgId) return res.status(403).json({ message: 'No org' });
            where.organisationId = orgId;
        }

        const workflow = await prisma.workflow.findFirst({
            where
        });

        if (!workflow) return res.status(404).json({ message: 'Workflow not found' });
        res.json(workflow);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const updateWorkflow = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const workflowId = req.params.id;

        // Verify existence and org
        const existing = await prisma.workflow.findFirst({
            where: { id: workflowId, isDeleted: false }
        });

        if (!existing) return res.status(404).json({ message: 'Workflow not found' });
        if (existing.organisationId !== orgId && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const { organisationId: _orgId, createdById: _createdById, executionCount: _count, ...updateData } = req.body;

        const workflow = await prisma.workflow.update({
            where: { id: workflowId },
            data: updateData
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'UPDATE_WORKFLOW',
                entity: 'Workflow',
                entityId: workflowId,
                actorId: user.id,
                organisationId: orgId as string,
                details: { name: workflow.name, updatedFields: Object.keys(req.body) }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }
        res.json(workflow);
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const deleteWorkflow = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        const orgId = getOrgId(user);
        const workflowId = req.params.id;

        // Verify existence and org
        const existing = await prisma.workflow.findFirst({
            where: { id: workflowId, isDeleted: false }
        });

        if (!existing) return res.status(404).json({ message: 'Workflow not found' });
        if (existing.organisationId !== orgId && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        await prisma.workflow.update({
            where: { id: workflowId },
            data: { isDeleted: true }
        });

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'DELETE_WORKFLOW',
                entity: 'Workflow',
                entityId: workflowId,
                actorId: user.id,
                organisationId: orgId as string,
                details: { name: existing.name }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }
    } catch (error) {
        res.status(500).json({ message: (error as Error).message });
    }
};

export const runWorkflow = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { entityId } = req.body;
        const user = (req as any).user;

        if (!entityId) {
            return res.status(400).json({ message: 'Entity ID is required' });
        }

        const workflow = await prisma.workflow.findUnique({ where: { id } });
        if (!workflow) {
            return res.status(404).json({ message: 'Workflow not found' });
        }

        // Security check
        const orgId = getOrgId(user);
        if (workflow.organisationId !== orgId && user.role !== 'super_admin') {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Fetch Entity
        let entityData: any = null;

        // Use Prisma dynamic fetch? or switch case
        // Since we are inside controller, we can use prisma methods directly or dynamic queries.
        // Prisma Client generic delegate access: `prisma[modelName]` is tricky in TS without casts.
        // Let's use switch case for safety.

        switch (workflow.triggerEntity) {
            case 'Lead':
                entityData = await prisma.lead.findUnique({ where: { id: entityId } });
                break;
            case 'Contact':
                entityData = await prisma.contact.findUnique({ where: { id: entityId } });
                break;
            case 'Opportunity':
                entityData = await prisma.opportunity.findUnique({ where: { id: entityId } });
                break;
            case 'Account':
                entityData = await prisma.account.findUnique({ where: { id: entityId } });
                break;
            case 'Task':
                entityData = await prisma.task.findUnique({ where: { id: entityId } });
                break;
            default:
                return res.status(400).json({ message: `Unsupported entity type: ${workflow.triggerEntity}` });
        }

        if (!entityData) {
            return res.status(404).json({ message: `${workflow.triggerEntity} with ID ${entityId} not found` });
        }

        const { WorkflowEngine } = await import('../services/workflowEngine');
        await WorkflowEngine.executeActions(workflow, entityData, workflow.organisationId);

        // Audit Log
        try {
            const { logAudit } = await import('../utils/auditLogger');
            logAudit({
                action: 'RUN_WORKFLOW_MANUAL',
                entity: 'Workflow',
                entityId: id,
                actorId: user.id,
                organisationId: workflow.organisationId,
                details: { name: workflow.name, entityType: workflow.triggerEntity, entityId }
            });
        } catch (e) {
            console.error('Audit Log Error:', e);
        }

        res.json({
            message: 'Workflow executed successfully',
            workflowId: id,
            entityId
        });

    } catch (error) {
        console.error('Manual Workflow Run Error:', error);
        res.status(500).json({ message: (error as Error).message });
    }
};
