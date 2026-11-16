import express from 'express';
import { protect } from '../middleware/authMiddleware';
import { MultiOrgService } from '../services/multiOrgService';

const router = express.Router();
router.use(protect);

const fail = (res: express.Response, e: any) =>
    res.status(e?.status || 500).json({ message: e?.status ? e.message : 'Something went wrong' });

router.get('/', async (req, res) => {
    try { res.json(await MultiOrgService.list((req as any).user)); } catch (e) { console.error('[MultiOrg] list', e); fail(res, e); }
});
router.post('/', async (req, res) => {
    try { res.status(201).json(await MultiOrgService.create((req as any).user, { name: req.body?.name })); } catch (e) { console.error('[MultiOrg] create', e); fail(res, e); }
});
router.post('/switch', async (req, res) => {
    try { res.json(await MultiOrgService.switchTo((req as any).user, String(req.body?.organisationId || ''), req)); } catch (e) { console.error('[MultiOrg] switch', e); fail(res, e); }
});

export default router;
