/**
 * READ-ONLY diagnostic for a reported "Helper app says synced, but call
 * report in Dad-mobile doesn't update" issue for user suhana@skilldad.com
 * (phone 8448119359, org 0d4556dd-7dc5-4fc2-809a-d88573133125). No writes.
 *
 * Usage: npx tsx src/scripts/check_suhana_sync.ts
 */
import prisma from '../config/prisma';

async function main() {
    const user = await prisma.user.findUnique({
        where: { email: 'sales@skilldad.com' },
        select: { id: true, firstName: true, lastName: true, phone: true, organisationId: true, reportsToId: true, role: true, isActive: true },
    });
    console.log('--- User ---');
    console.log(user);
    if (!user) return;

    // Last 10 minutes of raw Interaction rows created by this user, call type only.
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recent = await prisma.interaction.findMany({
        where: { createdById: user.id, type: 'call', date: { gte: since } },
        orderBy: { date: 'desc' },
        select: {
            id: true,
            date: true,
            createdAt: true,
            direction: true,
            callStatus: true,
            duration: true,
            recordingUrl: true,
            hardwareId: true,
            callSessionId: true,
            phoneNumber: true,
            isDeleted: true,
            organisationId: true,
        },
    });
    console.log(`\n--- Interaction rows (type=call) created by this user in the last 15 min (${recent.length}) ---`);
    console.log(recent);

    // SystemSetting rate-limit row for this user's bulk-sync, to see if
    // they're currently (or were recently) throttled.
    const rateLimitKey = `bulk_sync_last_call:${user.id}`;
    const rateLimitRow = await prisma.systemSetting.findUnique({ where: { key: rateLimitKey } });
    console.log('\n--- Bulk-sync rate-limit row ---');
    console.log(rateLimitRow ?? 'none');

    // Any leftover sync-lock rows for this user (would indicate a stuck
    // lock from the bug just fixed, or a genuinely still-in-flight request).
    const lockRows = await prisma.systemSetting.findMany({
        where: { key: { startsWith: `android_sync_lock:${user.id}-` } },
    });
    console.log(`\n--- Lock rows for this user (${lockRows.length}) ---`);
    console.log(lockRows);
}

main()
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
