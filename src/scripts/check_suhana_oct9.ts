/**
 * READ-ONLY diagnostic — Suhana's Oct 9 calls: duplicated on the lead
 * Timeline tab, missing from the Calls List page, mobile report counts
 * showing zero, recording not attached. No writes.
 *
 * Usage: npx tsx src/scripts/check_suhana_oct9.ts
 */
import prisma from '../config/prisma';

async function main() {
    const userId = 'cbdec98c-53a8-4541-9327-d4ccc9d6282b'; // suhana
    const orgId = '0d4556dd-7dc5-4fc2-809a-d88573133125';

    const dayStart = new Date('2026-10-09T00:00:00.000Z');
    const dayEnd = new Date('2026-10-10T00:00:00.000Z');

    const calls = await prisma.interaction.findMany({
        where: { createdById: userId, type: 'call', date: { gte: dayStart, lt: dayEnd } },
        orderBy: { date: 'asc' },
        select: {
            id: true, date: true, createdAt: true, updatedAt: true, direction: true,
            callStatus: true, duration: true, recordingUrl: true, hardwareId: true,
            callSessionId: true, phoneNumber: true, leadId: true, contactId: true,
            organisationId: true, isDeleted: true, subject: true,
        },
    });
    console.log(`--- All Interaction rows (type=call) for suhana on Oct 9 (${calls.length}) ---`);
    for (const c of calls) {
        console.log(
            `id=${c.id} | date=${c.date.toISOString()} (IST ~${new Date(c.date.getTime() + 5.5 * 3600000).toISOString().slice(11, 16)}) | ` +
            `dir=${c.direction} | status=${c.callStatus} | dur=${c.duration} | lead=${c.leadId ?? 'none'} | ` +
            `org=${c.organisationId} | deleted=${c.isDeleted} | recording=${c.recordingUrl ?? 'none'} | hwId=${c.hardwareId} | sessId=${c.callSessionId}`
        );
    }

    // If a leadId shows up, confirm the lead itself resolves + its own org.
    const leadIds = [...new Set(calls.map((c) => c.leadId).filter((x): x is string => !!x))];
    for (const leadId of leadIds) {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            select: { id: true, firstName: true, lastName: true, organisationId: true, assignedToId: true, isDeleted: true },
        });
        console.log(`\n--- Lead ${leadId} ---`);
        console.log(lead);
    }

    console.log(`\n--- Sanity: org match ---`);
    console.log(`Querying org: ${orgId}`);
    console.log(`Rows with mismatched organisationId: ${calls.filter((c) => c.organisationId !== orgId).length}`);
}

main()
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
