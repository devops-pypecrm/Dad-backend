import express from 'express';
import { getLeads, createLead, getLeadById, updateLead, deleteLead, createBulkLeads, bulkAssignLeads, convertLead, getViolations, submitExplanation, getLeadHistory, getLeadTransferLog, getPendingFollowUpsCount, generateAIResponse, suggestNextStep, getReEnquiryLeads, getDuplicateLeads, syncToGallabox, getUnattendedLeads, getNoActivityLeads, getNoActivityStatuses, previewNoActivityCleanup, executeNoActivityCleanup, getReEnquiryHistory, splitReEnquiryIntoLead } from '../controllers/leadController';
import { protect, admin, authorize } from '../middleware/authMiddleware';
import { checkPlanLimits } from '../middleware/subscriptionMiddleware';

const router = express.Router();


router.post('/bulk', protect, createBulkLeads as any);
router.post('/bulk-assign', protect, bulkAssignLeads as any);
router.get('/violations', protect, getViolations as any); // New Route
router.get('/transfer-log', protect, getLeadTransferLog as any); // Org-wide lead ownership transfer log
router.post('/explanation', protect, submitExplanation as any); // New Route
router.get('/pending-follow-ups', protect, getPendingFollowUpsCount as any);
router.get('/re-enquiries', protect, authorize('admin', 'manager', 'org_admin', 'super_admin', 'operation_executive'), getReEnquiryLeads as any);
router.get('/duplicates', protect, authorize('admin', 'manager', 'org_admin', 'operation_executive'), getDuplicateLeads as any);
router.get('/unattended', protect, getUnattendedLeads as any);
router.get('/no-activity', protect, getNoActivityLeads as any);
router.get('/no-activity/statuses', protect, getNoActivityStatuses as any);
router.post('/no-activity/cleanup/preview', protect, previewNoActivityCleanup as any);
router.post('/no-activity/cleanup/execute', protect, executeNoActivityCleanup as any);
router.get('/', protect, getLeads as any);
router.post('/', protect, checkPlanLimits('leads'), createLead as any);
router.get('/:id', protect, getLeadById as any);
router.get('/:id/history', protect, getLeadHistory as any);
router.get('/:id/re-enquiry-history', protect, getReEnquiryHistory as any);
router.post('/:id/re-enquiry-history/split', protect, splitReEnquiryIntoLead as any);
router.put('/:id', protect, updateLead as any);
router.post('/:id/generate-response', protect, generateAIResponse as any); // New
router.post('/:id/suggest-next-step', protect, suggestNextStep as any);
router.post('/:id/convert', protect, convertLead as any);
router.post('/:id/sync-gallabox', protect, syncToGallabox as any);
router.delete('/:id', protect, deleteLead as any);

export default router;
