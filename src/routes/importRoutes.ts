
import express from 'express';
import { importLeads, getImportJobStatus, listImportJobs } from '../controllers/importController';
import multer from 'multer';
import { protect } from '../middleware/authMiddleware';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.post('/leads', protect, upload.single('file'), importLeads);
router.get('/jobs', protect, listImportJobs);
router.get('/job/:id', protect, getImportJobStatus);

export default router;
