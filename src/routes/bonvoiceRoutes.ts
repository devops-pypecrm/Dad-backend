import express from 'express';
import { admin, protect } from '../middleware/authMiddleware';
import { disconnect, getAgentMappings, getConfig, testConnection, updateAgentMapping, updateConfig } from '../controllers/bonvoiceController';

const router = express.Router();

router.use(protect, admin);
router.get('/config', getConfig);
router.put('/config', updateConfig);
router.delete('/config', disconnect);
router.post('/test', testConnection);
router.get('/agents', getAgentMappings);
router.put('/agents/:userId', updateAgentMapping);

export default router;
