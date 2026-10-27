/**
 * READ-ONLY diagnostic for a reported call-recording issue on a Samsung
 * Galaxy F07 (SM-E07F/DS) — see conversation context. No writes.
 *
 * Usage: npx tsx src/scripts/check_prohostix_recording.ts
 */
import prisma from '../config/prisma';

async function main() {
    const email = 'info@prohostix.com';

    const org = await prisma.organisation.findFirst({
        where: { contactEmail: email },
        select: { id: true, name: true, contactEmail: true, status: true },
    });

    const userByEmail = await prisma.user.findUnique({
        where: { email },
        select: { id: true, firstName: true, lastName: true, email: true, organisationId: true, isActive: true },
    });

    console.log('--- Organisation (by contactEmail) ---');
    console.log(org ?? 'none found');

    console.log('\n--- User (by email) ---');
    console.log(userByEmail ?? 'none found');

    const orgId = org?.id ?? userByEmail?.organisationId;
    if (!orgId) {
        console.log('\nNo org resolved — stopping here.');
        return;
    }

    const orgUsers = await prisma.user.findMany({
        where: { organisationId: orgId, isDeleted: false },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true, isActive: true },
    });
    console.log(`\n--- Users in org ${orgId} (${orgUsers.length}) ---`);
    console.log(orgUsers);

    const callSettings = await prisma.callSettings.findUnique({ where: { organisationId: orgId } });
    console.log('\n--- CallSettings for org ---');
    console.log(callSettings ?? 'none (defaults apply)');

    // Recent call Interactions for this org's users, recording status only.
    const recentCalls = await prisma.interaction.findMany({
        where: { organisationId: orgId, type: 'call' },
        orderBy: { date: 'desc' },
        take: 30,
        select: {
            id: true,
            date: true,
            direction: true,
            callStatus: true,
            duration: true,
            recordingUrl: true,
            hardwareDuration: true,
            createdById: true,
            phoneNumber: true,
        },
    });
    console.log(`\n--- Last ${recentCalls.length} call Interactions (recording status) ---`);
    for (const call of recentCalls) {
        console.log(
            `${call.date.toISOString()} | by=${call.createdById ?? 'n/a'} | dir=${call.direction} | status=${call.callStatus} | duration=${call.duration} | hasRecording=${call.recordingUrl ? 'YES' : 'no'}`,
        );
    }

    const withRecording = recentCalls.filter((c) => c.recordingUrl).length;
    console.log(`\nSummary: ${withRecording}/${recentCalls.length} of the last ${recentCalls.length} calls have a recordingUrl attached.`);
}

main()
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
