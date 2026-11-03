import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { createInvoice, previewInvoice, generatePreviousMonthInvoices, monthsBetween, prevMonthOf, DEFAULT_RATE } from '../services/billingService';

const guard = (req: Request, res: Response): boolean => {
    if (!(req as any).user?.isSuperAdmin) { res.status(403).json({ message: 'Access denied' }); return false; }
    return true;
};
const fail = (res: Response, e: any) => res.status(500).json({ message: e?.message || 'Billing error' });
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

export const billingOverview = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const orgs = await prisma.organisation.findMany({ where: { isDeleted: false }, select: { id: true, name: true, status: true, billingRate: true, billingEnabled: true, currency: true }, orderBy: { name: 'asc' } });
        const invs = await prisma.billingInvoice.findMany({ select: { organisationId: true, status: true, total: true, periodStart: true, periodEnd: true, invoiceNumber: true, id: true }, orderBy: { periodStart: 'desc' } });
        const users = await prisma.user.groupBy({ by: ['organisationId'], where: { isDeleted: false, isActive: true }, _count: { _all: true } });
        const uc = new Map(users.map((u) => [u.organisationId, u._count._all]));
        const rows = orgs.map((o) => {
            const mine = invs.filter((i) => i.organisationId === o.id);
            const pending = mine.filter((i) => i.status === 'pending');
            return { ...o, rate: o.billingRate ?? DEFAULT_RATE, seats: uc.get(o.id) || 0, invoices: mine.length, pendingCount: pending.length, pendingAmount: pending.reduce((a, i) => a + i.total, 0), paidAmount: mine.filter((i) => i.status === 'paid').reduce((a, i) => a + i.total, 0), lastInvoice: mine[0] || null };
        });
        res.json({
            organisations: rows,
            totals: { pendingAmount: rows.reduce((a, r) => a + r.pendingAmount, 0), paidAmount: rows.reduce((a, r) => a + r.paidAmount, 0), pendingInvoices: rows.reduce((a, r) => a + r.pendingCount, 0), suspended: rows.filter((r) => r.status === 'suspended').length },
            previousMonth: prevMonthOf()
        });
    } catch (e) { fail(res, e); }
};

export const listInvoices = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const { status, organisationId, month } = req.query as Record<string, string>;
        const where: any = {};
        if (status === 'pending' || status === 'paid') where.status = status;
        if (organisationId) where.organisationId = organisationId;
        if (month && YM.test(month)) { const [y, m] = month.split('-').map(Number); where.periodStart = { lte: new Date(Date.UTC(y, m, 1)) }; where.periodEnd = { gte: new Date(Date.UTC(y, m - 1, 1)) }; }
        const invoices = await prisma.billingInvoice.findMany({ where, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }], take: 500 });
        const orgs = await prisma.organisation.findMany({ where: { id: { in: [...new Set(invoices.map((i) => i.organisationId))] } }, select: { id: true, name: true, status: true } });
        const nm = new Map(orgs.map((o) => [o.id, o]));
        res.json({ invoices: invoices.map((i) => ({ ...i, organisation: nm.get(i.organisationId) || null })) });
    } catch (e) { fail(res, e); }
};

export const getInvoice = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const inv = await prisma.billingInvoice.findUnique({ where: { id: req.params.id } });
        if (!inv) return res.status(404).json({ message: 'Invoice not found' });
        const organisation = await prisma.organisation.findUnique({ where: { id: inv.organisationId }, select: { id: true, name: true, status: true } });
        res.json({ ...inv, organisation });
    } catch (e) { fail(res, e); }
};

export const previewBilling = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const { organisationId, from, to, rate } = req.query as Record<string, string>;
        if (!organisationId || !YM.test(from) || !YM.test(to) || from > to) return res.status(400).json({ message: 'organisationId, from and to (YYYY-MM) are required' });
        res.json(await previewInvoice(organisationId, from, to, rate ? Number(rate) : undefined));
    } catch (e) { fail(res, e); }
};

// Body: { organisationIds?: string[] | 'all', mode: 'previous' | 'custom', from?, to?, combine?: boolean, rate?: number }
export const generateInvoices = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const { organisationIds, mode, combine = true, rate } = req.body || {};
        let from: string, to: string;
        if (mode === 'custom') { from = req.body.from; to = req.body.to; } else { from = to = prevMonthOf(); }
        if (!YM.test(from) || !YM.test(to) || from > to) return res.status(400).json({ message: 'Invalid month range' });
        if (monthsBetween(from, to).length > 24) return res.status(400).json({ message: 'Range too long (max 24 months)' });
        const orgs = !organisationIds || organisationIds === 'all'
            ? await prisma.organisation.findMany({ where: { isDeleted: false, billingEnabled: true }, select: { id: true } })
            : await prisma.organisation.findMany({ where: { id: { in: organisationIds }, isDeleted: false }, select: { id: true } });
        const result = { created: 0, skipped: [] as { organisationId: string; reason: string }[] };
        for (const o of orgs) {
            const ranges = combine ? [[from, to]] : monthsBetween(from, to).map((m) => [m, m]);
            for (const [f, t] of ranges) {
                const r: any = await createInvoice({ organisationId: o.id, from: f, to: t, rate: rate ? Number(rate) : undefined, skipEmpty: organisationIds === 'all' || !organisationIds });
                if (r.invoice && !r.skipped) result.created++; else result.skipped.push({ organisationId: o.id, reason: r.skipped || 'unknown' });
            }
        }
        res.json(result);
    } catch (e) { fail(res, e); }
};

export const updateInvoice = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const { status, paymentNote, notes, dueDate } = req.body || {};
        const data: any = {};
        if (status === 'paid') { data.status = 'paid'; data.paidAt = new Date(); }
        if (status === 'pending') { data.status = 'pending'; data.paidAt = null; }
        if (paymentNote !== undefined) data.paymentNote = paymentNote;
        if (notes !== undefined) data.notes = notes;
        if (dueDate) data.dueDate = new Date(dueDate);
        res.json(await prisma.billingInvoice.update({ where: { id: req.params.id }, data }));
    } catch (e) { fail(res, e); }
};

export const deleteInvoice = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try { await prisma.billingInvoice.delete({ where: { id: req.params.id } }); res.json({ message: 'Invoice deleted' }); } catch (e) { fail(res, e); }
};

export const updateOrgBilling = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const { billingRate, billingEnabled } = req.body || {};
        const data: any = {};
        if (billingRate !== undefined) data.billingRate = billingRate === null || billingRate === '' ? null : Number(billingRate);
        if (billingEnabled !== undefined) data.billingEnabled = !!billingEnabled;
        res.json(await prisma.organisation.update({ where: { id: req.params.id }, data, select: { id: true, billingRate: true, billingEnabled: true } }));
    } catch (e) { fail(res, e); }
};

// Manual only — nothing suspends an organisation automatically for unpaid bills.
export const setOrgSuspended = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
        const suspend = !!req.body?.suspend;
        const org = await prisma.organisation.update({ where: { id: req.params.id }, data: { status: suspend ? 'suspended' : 'active' }, select: { id: true, name: true, status: true } });
        try { const { logAudit } = await import('../utils/auditLogger'); await logAudit({ organisationId: org.id, actorId: (req as any).user.id, action: suspend ? 'SUSPEND_ORGANISATION' : 'ACTIVATE_ORGANISATION', entity: 'Organisation', entityId: org.id }); } catch { /* audit is best-effort */ }
        res.json(org);
    } catch (e) { fail(res, e); }
};

export const runMonthlyNow = async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try { res.json(await generatePreviousMonthInvoices(false)); } catch (e) { fail(res, e); }
};
