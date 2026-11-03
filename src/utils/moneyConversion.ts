import { AsyncLocalStorage } from 'async_hooks';
import { Prisma } from '../generated/client';
import { getRate, dateStr } from '../services/currencyService';

/**
 * Money is STORED in USD and PRESENTED in the organisation's currency.
 * This module is a Prisma middleware that sits on the main client, so controllers keep working in the org's currency:
 *   - writes: money fields in `data` are converted org-currency -> USD (rate of the record's day)
 *   - reads:  money fields are converted USD -> org-currency using the rate of the day the record was CREATED,
 *             so a record always reads back exactly as it was entered, regardless of today's rate.
 * Outside an authenticated request (cron, webhooks) there is no currency context and values pass through untouched.
 */
export const currencyStore = new AsyncLocalStorage<{ currency: string; raw?: boolean }>();
export const setRequestCurrency = (currency?: string | null) => {
    const c = (currency || 'USD').toUpperCase();
    currencyStore.enterWith({ currency: c });
};
export const runWithCurrency = <T>(currency: string, fn: () => T): T => currencyStore.run({ currency: (currency || 'USD').toUpperCase() }, fn);

export const MONEY_FIELDS: Record<string, string[]> = {
    Lead: ['potentialValue'],
    Account: ['annualRevenue'],
    Opportunity: ['amount'],
    Product: ['basePrice'],
    LeadProduct: ['price'],
    AccountProduct: ['price'],
    Quote: ['subtotal', 'totalDiscount', 'totalTax', 'grandTotal'],
    QuoteLineItem: ['unitPrice', 'total'],
    Commission: ['amount'],
    EMISchedule: ['totalAmount', 'paidAmount', 'remainingAmount'],
    EMIInstallment: ['amount', 'paidAmount'],
    PaymentRecord: ['amount'],
};

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const relationOf = (model: string, field: string): string | null => {
    const f = models.get(model)?.fields.find((x) => x.name === field);
    return f && f.kind === 'object' ? f.type : null;
};
const lower = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);
const num = (v: any) => typeof v === 'number' && isFinite(v);
const round = (v: number) => Math.round(v * 1e4) / 1e4; // display rounding

// ---------- writes ----------
async function convertDataIn(model: string, data: any, currency: string, createdAt: Date | string | null | undefined): Promise<void> {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data)) { for (const d of data) await convertDataIn(model, d, currency, createdAt); return; }
    const fields = MONEY_FIELDS[model] || [];
    // A product carries its own currency (chosen on the product form), independent of the organisation setting.
    const cur = model === 'Product' && typeof data.currency === 'string' && data.currency ? data.currency.toUpperCase() : currency;
    const day = data.createdAt || createdAt;
    for (const f of fields) {
        const v = data[f];
        if (num(v)) data[f] = v / (await getRate(cur, day)); // full precision: reads back exactly
        else if (v && typeof v === 'object') { // { set } / { increment } / { decrement }
            for (const op of ['set', 'increment', 'decrement']) if (num(v[op])) v[op] = v[op] / (await getRate(cur, day));
        }
    }
    for (const key of Object.keys(data)) {
        const rel = relationOf(model, key);
        if (!rel || !data[key] || typeof data[key] !== 'object') continue;
        const v = data[key];
        for (const op of ['create', 'update', 'upsert', 'connectOrCreate', 'createMany', 'updateMany']) {
            const part = v[op];
            if (!part) continue;
            const items = Array.isArray(part) ? part : [part];
            for (const it of items) {
                const target = it.data ?? it.create ?? it; // createMany/updateMany/update{where,data}/connectOrCreate
                await convertDataIn(rel, target, currency, day);
                if (it.update) await convertDataIn(rel, it.update, currency, day);
                if (it.create && it.create !== target) await convertDataIn(rel, it.create, currency, day);
            }
        }
    }
}

// ---------- reads ----------
async function convertRecordOut(model: string, rec: any, currency: string, selectAdded: Set<string>): Promise<void> {
    if (!rec || typeof rec !== 'object') return;
    if (Array.isArray(rec)) { for (const r of rec) await convertRecordOut(model, r, currency, selectAdded); return; }
    const fields = MONEY_FIELDS[model] || [];
    if (fields.some((f) => num(rec[f]))) {
        const rate = await getRate(currency, rec.createdAt);
        for (const f of fields) if (num(rec[f])) rec[f] = round(rec[f] * rate);
        if (model === 'Product' && num(rec.basePrice) && rec.currency) {
            // price as originally entered, in the product's own currency (used by the product form)
            const usd = rec.basePrice / rate;
            rec.originalPrice = round(usd * (await getRate(String(rec.currency).toUpperCase(), rec.createdAt)));
        }
    }
    for (const key of Object.keys(rec)) {
        const rel = relationOf(model, key);
        if (rel && rec[key] && typeof rec[key] === 'object') await convertRecordOut(rel, rec[key], currency, selectAdded);
    }
}

// Make sure createdAt is selected wherever money fields are (so each row can be pinned to its own day's rate).
function ensureCreatedAt(model: string, args: any): void {
    if (!args || typeof args !== 'object') return;
    const sel = args.select;
    if (sel) {
        const fields = MONEY_FIELDS[model] || [];
        if (fields.some((f) => sel[f]) && !sel.createdAt) sel.createdAt = true;
        for (const key of Object.keys(sel)) {
            const rel = relationOf(model, key);
            if (rel && sel[key] && typeof sel[key] === 'object') ensureCreatedAt(rel, sel[key]);
        }
    }
    if (args.include) {
        for (const key of Object.keys(args.include)) {
            const rel = relationOf(model, key);
            if (rel && args.include[key] && typeof args.include[key] === 'object') ensureCreatedAt(rel, args.include[key]);
        }
    }
}

// ---------- aggregates (exact, per-row rates) ----------
const AGG_OPS = ['_sum', '_avg', '_min', '_max'];
const needsAggFallback = (model: string, args: any) => {
    const fields = MONEY_FIELDS[model] || [];
    return AGG_OPS.some((op) => args?.[op] && fields.some((f) => args[op][f]));
};

async function computeAggregates(model: string, rows: any[], args: any, currency: string) {
    const out: any = {};
    const fieldsMoney = MONEY_FIELDS[model] || [];
    const valueOf = (r: any, f: string, rateCache: Map<string, number>) => {
        const v = r[f];
        if (!num(v)) return null;
        if (!fieldsMoney.includes(f)) return v;
        return v * (rateCache.get(dateStr(r.createdAt)) as number);
    };
    const rateCache = new Map<string, number>();
    for (const r of rows) { const d = dateStr(r.createdAt); if (!rateCache.has(d)) rateCache.set(d, await getRate(currency, r.createdAt)); }
    for (const op of AGG_OPS) {
        if (!args[op]) continue;
        out[op] = {};
        for (const f of Object.keys(args[op])) {
            if (!args[op][f]) continue;
            const vals = rows.map((r) => valueOf(r, f, rateCache)).filter((v) => v !== null) as number[];
            if (!vals.length) { out[op][f] = null; continue; }
            const sum = vals.reduce((a, b) => a + b, 0);
            out[op][f] = op === '_sum' ? round(sum) : op === '_avg' ? round(sum / vals.length) : op === '_min' ? Math.min(...vals) : Math.max(...vals);
        }
    }
    if (args._count !== undefined) {
        if (args._count === true) out._count = rows.length;
        else { out._count = {}; for (const f of Object.keys(args._count)) out._count[f] = f === '_all' ? rows.length : rows.filter((r) => r[f] !== null && r[f] !== undefined).length; }
    }
    return out;
}

export function registerMoneyMiddleware(prisma: any): void {
    prisma.$use(async (params: any, next: (p: any) => Promise<any>) => {
        const ctx = currencyStore.getStore();
        const model: string | undefined = params.model;
        if (!ctx || ctx.raw || !model || !params.args) return next(params);
        const rawCall = <T>(fn: () => Promise<T>): Promise<T> => currencyStore.run({ currency: ctx.currency, raw: true }, async () => await fn());
        const currency = ctx.currency;
        const hasMoney = !!MONEY_FIELDS[model];
        const action: string = params.action;

        try {
            // ----- writes -----
            if (['create', 'createMany', 'update', 'updateMany', 'upsert'].includes(action)) {
                let day: Date | string | null = null;
                if (['update', 'upsert'].includes(action) && params.args.where) {
                    // pin to the existing record's creation day so editing never drifts the stored USD value
                    try { const ex: any = await rawCall<any>(() => prisma[lower(model)].findUnique({ where: params.args.where, select: { createdAt: true } })); day = ex?.createdAt || null; } catch { day = null; }
                }
                // clone first: controllers keep using their own input objects after the call
                const args = { ...params.args };
                if (args.data) { args.data = structuredClone(args.data); await convertDataIn(model, args.data, currency, day); }
                if (args.create) { args.create = structuredClone(args.create); await convertDataIn(model, args.create, currency, null); }
                if (args.update) { args.update = structuredClone(args.update); await convertDataIn(model, args.update, currency, day); }
                params.args = args;
            }
            // ----- aggregate / groupBy with money -----
            if (hasMoney && (action === 'aggregate' || action === 'groupBy') && needsAggFallback(model, params.args)) {
                const a = params.args;
                const by: string[] = action === 'groupBy' ? (Array.isArray(a.by) ? a.by : [a.by]) : [];
                const need = new Set<string>(['createdAt', ...by]);
                for (const op of [...AGG_OPS, '_count']) if (a[op] && typeof a[op] === 'object') Object.keys(a[op]).forEach((k) => k !== '_all' && need.add(k));
                const rows: any[] = await rawCall(() => prisma[lower(model)].findMany({ where: a.where, select: Object.fromEntries([...need].map((k) => [k, true])) }));
                if (action === 'aggregate') return computeAggregates(model, rows, a, currency);
                const groups = new Map<string, any[]>();
                for (const r of rows) { const k = JSON.stringify(by.map((b) => r[b])); (groups.get(k) || groups.set(k, []).get(k)!).push(r); }
                const result: any[] = [];
                for (const [, g] of groups) {
                    const row: any = {}; by.forEach((b) => { row[b] = g[0][b]; });
                    Object.assign(row, await computeAggregates(model, g, a, currency));
                    result.push(row);
                }
                const ob = a.orderBy ? (Array.isArray(a.orderBy) ? a.orderBy : [a.orderBy]) : [];
                if (ob.length) {
                    const pick = (r: any, spec: any): [any, string] => { const k = Object.keys(spec)[0]; const v = spec[k]; return typeof v === 'object' ? [r[k]?.[Object.keys(v)[0]], v[Object.keys(v)[0]]] : [r[k], v]; };
                    result.sort((x, y) => { for (const spec of ob) { const [xv, dir] = pick(x, spec); const [yv] = pick(y, spec); if (xv === yv) continue; return (xv > yv ? 1 : -1) * (dir === 'desc' ? -1 : 1); } return 0; });
                }
                const sliced = result.slice(a.skip || 0, a.take ? (a.skip || 0) + a.take : undefined);
                return sliced;
            }
            // ----- reads (and results of writes) -----
            const addCreatedAt = ['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'create', 'update', 'upsert', 'delete'].includes(action);
            if (addCreatedAt) ensureCreatedAt(model, params.args);
        } catch (e) {
            console.error('[money] pre-processing failed, passing through:', (e as Error).message);
        }

        const result = await next(params);
        try {
            if (result && typeof result === 'object' && ['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'create', 'update', 'upsert', 'delete'].includes(params.action)) {
                await convertRecordOut(model, result, currency, new Set());
            }
        } catch (e) {
            console.error('[money] post-processing failed:', (e as Error).message);
        }
        return result;
    });
}
