import express from 'express';
import {
    listTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate
} from '../controllers/whatsappPersonalTemplateController';
import { protect } from '../middleware/authMiddleware';

const router = express.Router();

// `protect` only — no `admin`/`authorize` gate. Every handler scopes by
// req.user.id, so there is nothing an elevated role would legitimately
// unlock here; the only id that matters is the caller's own.
router.route('/').get(protect, listTemplates);
router.route('/').post(protect, createTemplate);
router.route('/:id').put(protect, updateTemplate);
router.route('/:id').delete(protect, deleteTemplate);

export default router;
