import express from 'express';
import { protect } from '../middleware/authMiddleware';
import prisma from '../config/prisma';
import { SUPPORTED_CURRENCIES, getRate } from '../services/currencyService';

const router = express.Router();

// Currencies the CRM supports + today's rate (units per 1 USD) — used by the product form's currency picker.
router.get('/', protect, async (_req, res) => {
    const rates = await Promise.all(SUPPORTED_CURRENCIES.map(async (code) => ({ code, rate: await getRate(code) })));
    res.json({ base: 'USD', currencies: rates });
});

export default router;
