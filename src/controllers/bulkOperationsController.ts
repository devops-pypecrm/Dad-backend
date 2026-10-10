import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId } from '../utils/hierarchyUtils';
import { ResponseHandler } from '../utils/apiResponse';
import { logger } from '../utils/logger';
import { EmailService } from '../services/emailService';
import { logAudit } from '../utils/auditLogger';
import { isOrgAdmin } from '../utils/roleUtils';

/**
 * Bulk Operations Controller
 * Handles bulk actions across different entities
 */

// POST /api/bulk/leads
export const bulkLeadOperations = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id;
  const organisationId = getOrgId(user);
  const { action, leadIds, data } = req.body;

  try {
    logger.apiRequest('POST', '/api/bulk/leads', userId, organisationId || undefined, { action, count: leadIds?.length });

    if (!organisationId) {
      return ResponseHandler.forbidden(res, 'User not associated with an organisation');
    }

    if (!action || !leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return ResponseHandler.validationError(res, 'Action and leadIds are required');
    }

    if (leadIds.length > 1000) {
      return ResponseHandler.validationError(res, 'Maximum 1000 leads can be processed at once');
    }

    let result;
    let message = '';

    switch (action) {
      case 'assign': {
        if (!data?.assignedToId) {
          return ResponseHandler.validationError(res, 'assignedToId is required for assign action');
        }

        // Verify user belongs to org
        const assignedUser = await prisma.user.findFirst({
          where: { id: data.assignedToId, organisationId }
        });
        if (!assignedUser) {
          return ResponseHandler.validationError(res, 'Assigned user does not belong to your organisation');
        }

        result = await prisma.lead.updateMany({
          where: {
            id: { in: leadIds },
            organisationId,
            isDeleted: false
          },
          data: {
            assignedToId: data.assignedToId,
            updatedAt: new Date()
          }
        });

        // Reassign all associated records like single-lead and bulkAssignLeads do
        await Promise.all([
            prisma.opportunity.updateMany({
                where: { leadId: { in: leadIds }, isDeleted: false },
                data: { ownerId: data.assignedToId }
            }),
            prisma.account.updateMany({
                where: { leadId: { in: leadIds }, isDeleted: false },
                data: { ownerId: data.assignedToId }
            }),
            prisma.contact.updateMany({
                where: { leadId: { in: leadIds }, isDeleted: false },
                data: { ownerId: data.assignedToId }
            }),
            prisma.followUp.updateMany({
                where: { leadId: { in: leadIds }, isDeleted: false, status: { notIn: ['completed', 'deferred'] } },
                data: { assignedToId: data.assignedToId }
            }),
            prisma.task.updateMany({
                where: { leadId: { in: leadIds }, isDeleted: false, status: { notIn: ['completed'] } },
                data: { assignedToId: data.assignedToId }
            })
        ]);

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_LEAD_ASSIGN',
          entity: 'Lead',
          details: { count: leadIds.length, assignedToId: data.assignedToId }
        });

        // Notify the new owner - this endpoint previously updated ownership
        // silently. leadController.ts's bulkAssignLeads (a separate, older
        // bulk-assign path) already does this; this one never did.
        if (data.assignedToId !== userId) {
          const { NotificationService } = await import('../services/notificationService');
          NotificationService.send(
            data.assignedToId,
            'Bulk Leads Assigned',
            `${result.count} leads have been assigned to you by ${user.firstName}.`,
            'info'
          ).catch((err: unknown) => logger.error('Failed to notify bulk-assign recipient', err, 'BULK_LEADS', userId, organisationId));
        }

        message = `${result.count} leads assigned successfully`;
        break;
      }

      case 'update-status':
        if (!isOrgAdmin(user)) {
          return ResponseHandler.forbidden(res, 'Only Org Admins can perform bulk status updates');
        }

        if (!data?.status) {
          return ResponseHandler.validationError(res, 'status is required for update-status action');
        }

        result = await prisma.lead.updateMany({
          where: {
            id: { in: leadIds },
            organisationId,
            isDeleted: false
          },
          data: {
            status: data.status,
            updatedAt: new Date()
          }
        });

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_LEAD_UPDATE_STATUS',
          entity: 'Lead',
          details: { count: leadIds.length, status: data.status }
        });

        message = `${result.count} leads status updated successfully`;
        break;

      case 'add-tags': {
        if (!data?.tags || !Array.isArray(data.tags)) {
          return ResponseHandler.validationError(res, 'tags array is required for add-tags action');
        }

        // Get existing leads with their current tags
        const leadsWithTags = await prisma.lead.findMany({
          where: {
            id: { in: leadIds },
            organisationId,
            isDeleted: false
          },
          select: { id: true, tags: true }
        });

        // Update each lead with merged tags
        const updatePromises = leadsWithTags.map(lead => {
          const existingTags = lead.tags || [];
          const newTags = [...new Set([...existingTags, ...data.tags])]; // Remove duplicates

          return prisma.lead.update({
            where: { id: lead.id },
            data: {
              tags: newTags,
              updatedAt: new Date()
            }
          });
        });

        await Promise.all(updatePromises);

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_LEAD_ADD_TAGS',
          entity: 'Lead',
          details: { count: leadsWithTags.length, tags: data.tags }
        });

        message = `Tags added to ${leadsWithTags.length} leads successfully`;
        break;
      }

      case 'send-email': {
        if (!data?.subject || !data?.content) {
          return ResponseHandler.validationError(res, 'subject and content are required for send-email action');
        }

        // Get leads with email addresses
        const leadsWithEmail = await prisma.lead.findMany({
          where: {
            id: { in: leadIds },
            organisationId,
            isDeleted: false,
            email: { not: null },
            NOT: { email: '' }
          },
          select: { id: true, email: true, firstName: true, lastName: true }
        });

        // Send emails (in background)
        const emailPromises = leadsWithEmail.map(async (lead) => {
          try {
            const personalizedContent = data.content
              .replace(/\{firstName\}/g, lead.firstName)
              .replace(/\{lastName\}/g, lead.lastName)
              .replace(/\{fullName\}/g, `${lead.firstName} ${lead.lastName}`);

            await EmailService.sendEmail(
              lead.email!,
              data.subject,
              personalizedContent,
              organisationId,
              userId,
              { leadId: lead.id }
            );
          } catch (error) {
            logger.error('Failed to send email to lead', error, 'BULK_EMAIL', userId, organisationId, { leadId: lead.id });
          }
        });

        // Don't wait for all emails to complete
        Promise.all(emailPromises).catch(error => {
          logger.error('Some bulk emails failed', error, 'BULK_EMAIL', userId, organisationId);
        });

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_LEAD_SEND_EMAIL',
          entity: 'Lead',
          details: { count: leadsWithEmail.length, subject: data.subject }
        });

        message = `Email sending initiated for ${leadsWithEmail.length} leads`;
        break;
      }

      case 'send-whatsapp': {
        // Mass free-text WhatsApp messaging is not permitted by WhatsApp's policy (and is blocked
        // outside the 24h window). Bulk outreach must use an approved template via WhatsApp > Campaigns.
        return ResponseHandler.validationError(res, 'Bulk WhatsApp messages must be sent as a template campaign. Go to WhatsApp > Campaigns.');
      }

      case 'delete':
        if (!isOrgAdmin(user)) {
          return ResponseHandler.forbidden(res, 'Only Org Admins can perform bulk deletion');
        }

        result = await prisma.lead.updateMany({
          where: {
            id: { in: leadIds },
            organisationId,
            isDeleted: false
          },
          data: {
            isDeleted: true,
            deletedAt: new Date(),
            updatedAt: new Date()
          }
        });

        // Cascade to entities converted from these leads, matching the single-lead
        // delete path (leadController.deleteLead) - otherwise a lead's converted
        // Contact/Account/Opportunity stay active and visible after the lead is gone.
        const cascadeDeletedAt = new Date();
        await Promise.all([
          prisma.contact.updateMany({
            where: { leadId: { in: leadIds } },
            data: { isDeleted: true, deletedAt: cascadeDeletedAt }
          }),
          prisma.account.updateMany({
            where: { leadId: { in: leadIds } },
            data: { isDeleted: true, deletedAt: cascadeDeletedAt }
          }),
          prisma.opportunity.updateMany({
            where: { leadId: { in: leadIds } },
            data: { isDeleted: true, deletedAt: cascadeDeletedAt }
          })
        ]);

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_LEAD_DELETE',
          entity: 'Lead',
          details: { count: leadIds.length }
        });

        message = `${result.count} leads deleted successfully`;
        break;

      case 'export': {
        // Get leads data for export
        const exportLeads = await prisma.lead.findMany({
          where: {
            id: { in: leadIds },
            organisationId,
            isDeleted: false
          },
          include: {
            assignedTo: { select: { firstName: true, lastName: true } }
          }
        });

        // Format data for export
        const exportData = exportLeads.map(lead => ({
          'First Name': lead.firstName,
          'Last Name': lead.lastName,
          'Email': lead.email || '',
          'Phone': lead.phone || '',
          'Company': lead.company || '',
          'Status': lead.status,
          'Lead Score': lead.leadScore,
          'Source': lead.source,
          'Assigned To': lead.assignedTo ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}` : '',
          'Created At': lead.createdAt.toISOString(),
          'Updated At': lead.updatedAt.toISOString()
        }));

        return ResponseHandler.success(res, {
          data: exportData,
          filename: `leads_export_${new Date().toISOString().split('T')[0]}.csv`,
          count: exportData.length
        }, 'Export data prepared successfully');
      }

      default:
        return ResponseHandler.validationError(res, `Unsupported action: ${action}`);
    }

    logger.info(`Bulk lead operation completed: ${action}`, 'BULK_LEADS', userId, organisationId, { count: leadIds.length });
    return ResponseHandler.success(res, { processed: result?.count || leadIds.length }, message);

  } catch (error: any) {
    logger.apiError('POST', '/api/bulk/leads', error, userId, organisationId || undefined);
    return ResponseHandler.serverError(res, 'An error occurred while processing bulk operation');
  }
};

// POST /api/bulk/contacts
export const bulkContactOperations = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id;
  const organisationId = getOrgId(user);
  const { action, contactIds, data } = req.body;

  try {
    logger.apiRequest('POST', '/api/bulk/contacts', userId, organisationId || undefined, { action, count: contactIds?.length });

    if (!organisationId) {
      return ResponseHandler.forbidden(res, 'User not associated with an organisation');
    }

    if (!action || !contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return ResponseHandler.validationError(res, 'Action and contactIds are required');
    }

    let result;
    let message = '';

    switch (action) {
      case 'assign-owner':
        if (!data?.ownerId) {
          return ResponseHandler.validationError(res, 'ownerId is required for assign-owner action');
        }

        result = await prisma.contact.updateMany({
          where: {
            id: { in: contactIds },
            organisationId,
            isDeleted: false
          },
          data: {
            ownerId: data.ownerId,
            updatedAt: new Date()
          }
        });

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_CONTACT_ASSIGN',
          entity: 'Contact',
          details: { count: contactIds.length, ownerId: data.ownerId }
        });

        message = `${result.count} contacts assigned successfully`;
        break;

      case 'add-to-campaign': {
        if (!data?.campaignId) {
          return ResponseHandler.validationError(res, 'campaignId is required for add-to-campaign action');
        }

        // Add contacts to email list associated with campaign
        const campaign = await prisma.campaign.findUnique({
          where: { id: data.campaignId },
          select: { emailListId: true }
        });

        if (!campaign?.emailListId) {
          return ResponseHandler.validationError(res, 'Campaign does not have an associated email list');
        }

        // Get contacts that aren't already in the email list
        const contactsToAdd = await prisma.contact.findMany({
          where: {
            id: { in: contactIds },
            organisationId,
            emailLists: {
              none: { id: campaign.emailListId }
            }
          }
        });

        // Add contacts to email list
        await prisma.emailList.update({
          where: { id: campaign.emailListId },
          data: {
            contacts: {
              connect: contactsToAdd.map(contact => ({ id: contact.id }))
            }
          }
        });

        message = `${contactsToAdd.length} contacts added to campaign successfully`;
        break;
      }

      case 'delete':
        result = await prisma.contact.updateMany({
          where: {
            id: { in: contactIds },
            organisationId,
            isDeleted: false
          },
          data: {
            isDeleted: true,
            deletedAt: new Date(),
            updatedAt: new Date()
          }
        });

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_CONTACT_DELETE',
          entity: 'Contact',
          details: { count: contactIds.length }
        });

        message = `${result.count} contacts deleted successfully`;
        break;

      case 'export': {
        const exportContacts = await prisma.contact.findMany({
          where: {
            id: { in: contactIds },
            organisationId
          },
          include: {
            account: { select: { name: true } },
            owner: { select: { firstName: true, lastName: true } }
          }
        });

        const exportData = exportContacts.map(contact => ({
          'First Name': contact.firstName,
          'Last Name': contact.lastName,
          'Email': contact.email || '',
          'Job Title': contact.jobTitle || '',
          'Department': contact.department || '',
          'Account': contact.account?.name || '',
          'Owner': contact.owner ? `${contact.owner.firstName} ${contact.owner.lastName}` : '',
          'Created At': contact.createdAt.toISOString(),
          'Updated At': contact.updatedAt.toISOString()
        }));

        return ResponseHandler.success(res, {
          data: exportData,
          filename: `contacts_export_${new Date().toISOString().split('T')[0]}.csv`,
          count: exportData.length
        }, 'Export data prepared successfully');
      }

      default:
        return ResponseHandler.validationError(res, `Unsupported action: ${action}`);
    }

    logger.info(`Bulk contact operation completed: ${action}`, 'BULK_CONTACTS', userId, organisationId, { count: contactIds.length });
    return ResponseHandler.success(res, { processed: result?.count || contactIds.length }, message);

  } catch (error: any) {
    logger.apiError('POST', '/api/bulk/contacts', error, userId, organisationId || undefined);
    return ResponseHandler.serverError(res, 'An error occurred while processing bulk operation');
  }
};

// POST /api/bulk/opportunities
export const bulkOpportunityOperations = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id;
  const organisationId = getOrgId(user);
  const { action, opportunityIds, data } = req.body;

  try {
    logger.apiRequest('POST', '/api/bulk/opportunities', userId, organisationId || undefined, { action, count: opportunityIds?.length });

    if (!organisationId) {
      return ResponseHandler.forbidden(res, 'User not associated with an organisation');
    }

    if (!action || !opportunityIds || !Array.isArray(opportunityIds) || opportunityIds.length === 0) {
      return ResponseHandler.validationError(res, 'Action and opportunityIds are required');
    }

    let result;
    let message = '';

    switch (action) {
      case 'update-stage':
        if (!data?.stage) {
          return ResponseHandler.validationError(res, 'stage is required for update-stage action');
        }

        result = await prisma.opportunity.updateMany({
          where: {
            id: { in: opportunityIds },
            organisationId
          },
          data: {
            stage: data.stage,
            probability: data.probability || undefined,
            updatedAt: new Date(),
            // Same reasoning as the single-opportunity update: closeDate drives
            // "deals closed in [month]" reporting, so a bulk move into a closed
            // stage needs to stamp it too, not leave it stuck at creation time.
            ...((data.stage === 'closed_won' || data.stage === 'closed_lost') && data.closeDate === undefined
              ? { closeDate: new Date() }
              : {})
          }
        });
        message = `${result.count} opportunities stage updated successfully`;

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_OPPORTUNITY_UPDATE_STAGE',
          entity: 'Opportunity',
          details: { count: opportunityIds.length, stage: data.stage }
        });
        break;

      case 'assign-owner':
        if (!data?.ownerId) {
          return ResponseHandler.validationError(res, 'ownerId is required for assign-owner action');
        }

        result = await prisma.opportunity.updateMany({
          where: {
            id: { in: opportunityIds },
            organisationId
          },
          data: {
            ownerId: data.ownerId,
            updatedAt: new Date()
          }
        });
        message = `${result.count} opportunities assigned successfully`;

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_OPPORTUNITY_ASSIGN',
          entity: 'Opportunity',
          details: { count: opportunityIds.length, ownerId: data.ownerId }
        });
        break;

      case 'delete':
        result = await prisma.opportunity.updateMany({
          where: {
            id: { in: opportunityIds },
            organisationId,
            isDeleted: false
          },
          data: {
            isDeleted: true,
            deletedAt: new Date(),
            updatedAt: new Date()
          }
        });

        await logAudit({
          organisationId,
          actorId: userId,
          action: 'BULK_OPPORTUNITY_DELETE',
          entity: 'Opportunity',
          details: { count: opportunityIds.length }
        });

        message = `${result.count} opportunities deleted successfully`;
        break;

      case 'export': {
        const exportOpportunities = await prisma.opportunity.findMany({
          where: {
            id: { in: opportunityIds },
            organisationId
          },
          include: {
            account: { select: { name: true } },
            owner: { select: { firstName: true, lastName: true } }
          }
        });

        const exportData = exportOpportunities.map(opp => ({
          'Name': opp.name,
          'Account': opp.account.name,
          'Amount': opp.amount,
          'Stage': opp.stage,
          'Probability': opp.probability,
          'Close Date': opp.closeDate?.toISOString().split('T')[0] || '',
          'Lead Source': opp.leadSource || '',
          'Owner': opp.owner ? `${opp.owner.firstName} ${opp.owner.lastName}` : '',
          'Created At': opp.createdAt.toISOString(),
          'Updated At': opp.updatedAt.toISOString()
        }));

        return ResponseHandler.success(res, {
          data: exportData,
          filename: `opportunities_export_${new Date().toISOString().split('T')[0]}.csv`,
          count: exportData.length
        }, 'Export data prepared successfully');
      }

      default:
        return ResponseHandler.validationError(res, `Unsupported action: ${action}`);
    }

    logger.info(`Bulk opportunity operation completed: ${action}`, 'BULK_OPPORTUNITIES', userId, organisationId, { count: opportunityIds.length });
    return ResponseHandler.success(res, { processed: result?.count || opportunityIds.length }, message);

  } catch (error: any) {
    logger.apiError('POST', '/api/bulk/opportunities', error, userId, organisationId || undefined);
    return ResponseHandler.serverError(res, 'An error occurred while processing bulk operation');
  }
};