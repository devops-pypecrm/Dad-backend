/**
 * Read-only: lists every lead in an organisation that carries a given phone
 * number (as primary or secondary phone, in any +91/91/0 form), with the
 * fields that explain why two leads can share a number.
 *
 * Usage (from Dad-backend/):
 *   npx tsx src/scripts/checkDuplicatePhone.ts <phone> [orgNameContains]
 *   npx tsx src/scripts/checkDuplicatePhone.ts 9747404077 iits
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../../.env') });

import prisma from '../config/prisma';

async function main() {
    const [rawPhone, orgFilter] = process.argv.slice(2);
    const last10 = (rawPhone || '').replace(/\D/g, '').slice(-10);
    if (last10.length < 10) {
        console.error('Usage: npx tsx src/scripts/checkDuplicatePhone.ts <phone> [orgNameContains]');
        process.exit(1);
    }

    const orgs = await prisma.organisation.findMany({
        where: orgFilter ? { name: { contains: orgFilter, mode: 'insensitive' } } : {},
        select: { id: true, name: true }
    });
    if (orgs.length === 0) {
        console.error(`No organisation name contains "${orgFilter}".`);
        process.exit(1);
    }
    console.log(`Organisations matched: ${orgs.map(o => o.name).join(', ')}\n`);

    // Includes soft-deleted leads on purpose — a lead in Trash is one of the
    // ways the same number ends up on two rows.
    const leads = await prisma.lead.findMany({
        where: {
            organisationId: { in: orgs.map(o => o.id) },
            OR: [
                { phone: { endsWith: last10 } },
                { secondaryPhone: { endsWith: last10 } }
            ]
        },
        select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            secondaryPhone: true,
            source: true,
            status: true,
            isDeleted: true,
            isReEnquiry: true,
            reEnquiryCount: true,
            originalLeadId: true,
            createdAt: true,
            organisation: { select: { name: true } },
            branch: { select: { name: true } },
            assignedTo: { select: { email: true } },
            createdBy: { select: { email: true } }
        },
        orderBy: { createdAt: 'asc' }
    });

    if (leads.length === 0) {
        console.log(`No leads found for ${last10}.`);
        return;
    }

    console.log(`Found ${leads.length} lead(s) for ${last10}:\n`);
    console.table(leads.map(l => ({
        id: l.id,
        name: `${l.firstName} ${l.lastName || ''}`.trim(),
        phone: l.phone,
        secondaryPhone: l.secondaryPhone || '',
        org: l.organisation?.name,
        branch: l.branch?.name || '(none)',
        source: l.source,
        status: l.status,
        deleted: l.isDeleted,
        reEnquiries: l.reEnquiryCount,
        splitFrom: l.originalLeadId || '',
        owner: l.assignedTo?.email || '(unassigned)',
        createdBy: l.createdBy?.email || '',
        createdAt: l.createdAt.toISOString()
    })));

    // Point at the likely cause for the common cases.
    const live = leads.filter(l => !l.isDeleted);
    const branches = new Set(live.map(l => l.branch?.name || '(none)'));
    if (leads.some(l => l.isDeleted)) console.log('- At least one row is soft-deleted (in Trash).');
    if (live.length > 1 && branches.size > 1) console.log('- Live leads sit in different branches; single-lead, Meta, web form and API creation only check duplicates within a branch.');
    if (leads.some(l => l.originalLeadId)) console.log('- A row has originalLeadId set: it was split out of a re-enquiry on purpose.');
    if (leads.some(l => l.secondaryPhone?.endsWith(last10) && !l.phone.endsWith(last10))) console.log('- The number is the secondary phone on at least one lead.');
    if (live.length > 1) {
        const times = live.map(l => l.createdAt.getTime()).sort((a, b) => a - b);
        if (times.some((t, i) => i > 0 && t - times[i - 1] < 10_000)) console.log('- Two leads were created within 10 seconds of each other (simultaneous submissions).');
    }
}

main()
    .catch(err => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
