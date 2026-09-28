import express from 'express';
import {
    getAllOrganisations,
    createOrganisation,
    updateOrganisationAdmin,
    suspendOrganisation,
    getOrganisationStats,
    resetUserPassword,
    getHelperActivityLogs,
    getHelperActivityLogUsers,
    getUserPasswords
} from '../controllers/superAdminController';
import {
    sendBroadcast,
    getAllBroadcasts,
    getBroadcastStats,
    broadcastToOrgAdmins
} from '../controllers/broadcastController';
import { deleteOrganisation, restoreOrganisation, permanentlyDeleteOrganisation } from '../controllers/organisationController';
import {
    getPlans,
    createPlan,
    updatePlan,
    deletePlan
} from '../controllers/subscriptionPlanController';
import { protect } from '../middleware/authMiddleware';
import { getSystemSettings, updateSystemSettings } from '../controllers/systemSettingsController';
import { getGlobalRoles, upsertGlobalRole } from '../controllers/roleController';
import { exportPlatformData, restorePlatformData } from '../controllers/backupController';
import {
    getAllFAQs,
    createFAQ,
    updateFAQ,
    deleteFAQ
} from '../controllers/siteFAQController';
import {
    getAllTrainingVideos,
    createTrainingVideo,
    updateTrainingVideo,
    deleteTrainingVideo
} from '../controllers/trainingVideoController';
import {
    getAllEnquiries,
    convertEnquiryToAccount,
    rejectEnquiry,
    deleteEnquiry
} from '../controllers/enquiryController';

const router = express.Router();

// Full Platform Data Export/Restore
router.get('/platform/export', protect, exportPlatformData);
router.post('/platform/restore', protect, restorePlatformData);

// System Settings
router.get('/settings', protect, getSystemSettings);
router.put('/settings', protect, updateSystemSettings);

// Organisation Management
router.get('/organisations', protect, getAllOrganisations);
router.post('/organisations', protect, createOrganisation);
router.put('/organisations/:id', protect, updateOrganisationAdmin);
router.delete('/organisations/:id', protect, deleteOrganisation); // Soft delete
router.delete('/organisations/:id/permanent', protect, permanentlyDeleteOrganisation); // Permanent delete (super admin only)
router.post('/organisations/:id/restore', protect, restoreOrganisation); // Restore deleted org
router.post('/organisations/:id/suspend', protect, suspendOrganisation);

// License Plans Management
router.get('/plans', protect, getPlans);
router.post('/plans', protect, createPlan);
router.put('/plans/:id', protect, updatePlan);
router.delete('/plans/:id', protect, deletePlan);

// Global Roles management (Super Admin)
router.get('/roles', protect, getGlobalRoles);
router.post('/roles', protect, upsertGlobalRole);

router.get('/stats', protect, getOrganisationStats);

// Landing Page FAQ Management
router.get('/faqs', protect, getAllFAQs);
router.post('/faqs', protect, createFAQ);
router.put('/faqs/:id', protect, updateFAQ);
router.delete('/faqs/:id', protect, deleteFAQ);

router.get('/training-videos', protect, getAllTrainingVideos);
router.post('/training-videos', protect, createTrainingVideo);
router.put('/training-videos/:id', protect, updateTrainingVideo);
router.delete('/training-videos/:id', protect, deleteTrainingVideo);

// User Management (Cross-Organisation)
router.get('/users/passwords', protect, getUserPasswords);
router.post('/users/reset-password', protect, resetUserPassword);

// Broadcast Notification to all Org Admins - legacy route, kept for the
// scripts/broadcast.ts/.sh CLI and any other existing caller.
router.post('/broadcast-notification', protect, broadcastToOrgAdmins);

// Broadcasts - the Super Admin panel's composer + history/acknowledgement UI
router.post('/broadcasts', protect, sendBroadcast);
router.get('/broadcasts', protect, getAllBroadcasts);
router.get('/broadcasts/:id/stats', protect, getBroadcastStats);

// Helper (PypeCRM Helper / Dad-call-recorder) activity log monitoring
router.get('/helper-logs', protect, getHelperActivityLogs);
router.get('/helper-logs/users', protect, getHelperActivityLogUsers);

// Enquiries - the only way a new tenant account gets created now that
// self-serve /register has been retired (see enquiryController.ts)
router.get('/enquiries', protect, getAllEnquiries);
router.post('/enquiries/:id/convert', protect, convertEnquiryToAccount);
router.post('/enquiries/:id/reject', protect, rejectEnquiry);
router.delete('/enquiries/:id', protect, deleteEnquiry);

export default router;
