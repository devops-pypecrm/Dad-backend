import axios from 'axios';
import { PrismaClient } from '../generated/client';

// Currencies pegged to USD — used when the rates API has no history for them (e.g. AED/SAR aren't in ECB data).
export const PEGGED: Record<string, number> = { USD: 1, AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845, JOD: 0.709 };

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const dateStr = (d?: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : todayStr());

type Point = { date: string; rate: number };
const cache = new Map<string, { at: number; points: Point[] }>();
const TTL_MS = 10 * 60 * 1000;

// Raw client for rate reads/writes only (kept off the money-converting client to avoid any recursion).
let db: PrismaClient | null = null;
export const setCurrencyDb = (client: PrismaClient) => { db = client; };

async function loadPoints(currency: string): Promise<Point[]> {
    const hit = cache.get(currency);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.points;
    const rows = db ? await db.exchangeRate.findMany({ where: { currency }, select: { date: true, rate: true }, orderBy: { date: 'asc' } }) : [];
    cache.set(currency, { at: Date.now(), points: rows });
    return rows;
}

/** Units of `currency` per 1 USD for the given day (last known rate on/before that day, else the earliest known). */
export async function getRate(currency: string, date?: Date | string | null): Promise<number> {
    const cur = (currency || 'USD').toUpperCase();
    if (cur === 'USD') return 1;
    const pts = await loadPoints(cur);
    if (!pts.length) return PEGGED[cur] ?? 1;
    const d = dateStr(date);
    let found: Point | undefined;
    for (let i = pts.length - 1; i >= 0; i--) { if (pts[i].date <= d) { found = pts[i]; break; } }
    return (found ?? pts[0]).rate;
}

export const toUsd = async (amount: number, currency: string, date?: Date | string | null) => amount / (await getRate(currency, date));
export const fromUsd = async (usd: number, currency: string, date?: Date | string | null) => usd * (await getRate(currency, date));

/** Fetch today's rates for every currency and store them (idempotent per day). */
export async function fetchAndStoreLatestRates(): Promise<number> {
    if (!db) throw new Error('currency db not set');
    const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 20000 });
    const rates: Record<string, number> = data?.rates || {};
    const date = todayStr();
    let n = 0;
    for (const [currency, rate] of Object.entries(rates)) {
        if (!rate || currency === 'USD') continue;
        await db.exchangeRate.upsert({ where: { date_currency: { date, currency } }, update: { rate, source: 'er-api' }, create: { date, currency, rate, source: 'er-api' } });
        n++;
    }
    cache.clear();
    return n;
}

/** Historical backfill (ECB data via frankfurter; pegged currencies filled with their peg). */
export async function backfillHistory(currencies: string[], from: string): Promise<number> {
    if (!db) throw new Error('currency db not set');
    let n = 0;
    const ecb = currencies.filter((c) => c !== 'USD' && !PEGGED[c]);
    if (ecb.length) {
        const { data } = await axios.get(`https://api.frankfurter.app/${from}..?from=USD&to=${ecb.join(',')}`, { timeout: 60000 });
        for (const [date, byCur] of Object.entries<Record<string, number>>(data?.rates || {})) {
            for (const [currency, rate] of Object.entries(byCur)) {
                await db.exchangeRate.upsert({ where: { date_currency: { date, currency } }, update: {}, create: { date, currency, rate, source: 'ecb' } });
                n++;
            }
        }
    }
    for (const c of currencies.filter((c) => PEGGED[c] && c !== 'USD')) {
        await db.exchangeRate.upsert({ where: { date_currency: { date: from, currency: c } }, update: {}, create: { date: from, currency: c, rate: PEGGED[c], source: 'peg' } });
        n++;
    }
    cache.clear();
    return n;
}

export const SUPPORTED_CURRENCIES = ['USD','INR','AED','EUR','GBP','SAR','QAR','KWD','OMR','BHD','SGD','MYR','AUD','CAD','NZD','CHF','JPY','CNY','HKD','ZAR','NGN','KES','LKR','BDT','PKR','NPR','PHP','IDR','THB','TRY'];
