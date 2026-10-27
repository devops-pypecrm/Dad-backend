import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma';

/**
 * Deletes every call recording belonging to the organisation of one user
 * (by email). The call records themselves (Interaction rows) are kept —
 * only the audio goes:
 *   - Interaction.recordingUrl / recordingDuration / documentId cleared
 *   - Documents those calls pointed at (recording bytes stored in Postgres)
 *   - CallRecording rows for the org's leads
 *   - the audio files under uploads/recordings on this server
 *
 * Dry run by default — prints what it would delete. Pass --confirm to delete.
 *
 *   npx ts-node src/scripts/delete_org_recordings.ts demo@crm.com
 *   npx ts-node src/scripts/delete_org_recordings.ts demo@crm.com --confirm
 *
 * Run from the backend's root folder ON THE SERVER that stores the uploads.
 */

const email = process.argv[2];
const confirm = process.argv.includes('--confirm');

// Both locations the app writes recordings to (callController uses a path
// relative to the source file, androidRoutes one relative to the cwd).
const recordingDirs = Array.from(
    new Set([path.join(__dirname, '../../uploads/recordings'), path.join(process.cwd(), 'uploads', 'recordings')]),
);

function localFileFor(url: string | null | undefined): string | null {
    if (!url || /^https?:\/\//i.test(url)) return null;
    const name = path.basename(url);
    if (!name || name === '.' || name === '..') return null;
    for (const dir of recordingDirs) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
    }
    return null;
}

async function main() {
    if (!email) {
        console.error('Usage: npx ts-node src/scripts/delete_org_recordings.ts <user-email> [--confirm]');
        process.exit(1);
    }

    const user = await prisma.user.findFirst({
        where: { email },
        select: { organisationId: true, organisation: { select: { name: true } } },
    });
    if (!user?.organisationId) {
        console.error(`No user/organisation found for ${email}`);
        process.exit(1);
    }
    const orgId = user.organisationId;
    console.log(`Organisation: ${user.organisation?.name} (${orgId})`);

    const calls = await prisma.interaction.findMany({
        where: { organisationId: orgId, OR: [{ recordingUrl: { not: null } }, { documentId: { not: null }, type: 'call' }] },
        select: { id: true, recordingUrl: true, documentId: true },
    });
    const documentIds = Array.from(new Set(calls.map((c) => c.documentId).filter((id): id is string => !!id)));
    const callRecordings = await prisma.callRecording.findMany({
        where: { lead: { organisationId: orgId } },
        select: { id: true, fileUrl: true },
    });

    const urls = [...calls.map((c) => c.recordingUrl), ...callRecordings.map((r) => r.fileUrl)];
    const files = Array.from(new Set(urls.map(localFileFor).filter((f): f is string => !!f)));
    const remote = urls.filter((u) => u && /^https?:\/\//i.test(u));

    console.log(`Calls with a recording:     ${calls.length}`);
    console.log(`Recording documents (DB):   ${documentIds.length}`);
    console.log(`CallRecording rows:         ${callRecordings.length}`);
    console.log(`Audio files on this server: ${files.length}`);
    if (remote.length) console.log(`Remote URLs (not deletable here, links will be cleared): ${remote.length}`);

    if (!confirm) {
        console.log('\nDry run — nothing deleted. Re-run with --confirm to delete.');
        return;
    }

    await prisma.$transaction(async (tx) => {
        if (calls.length) {
            await tx.interaction.updateMany({
                where: { id: { in: calls.map((c) => c.id) } },
                data: { recordingUrl: null, recordingDuration: null, documentId: null },
            });
        }
        if (documentIds.length) {
            // Only documents no other row still points at.
            const stillUsed = await tx.interaction.findMany({
                where: { documentId: { in: documentIds } },
                select: { documentId: true },
            });
            const used = new Set(stillUsed.map((s) => s.documentId));
            await tx.document.deleteMany({
                where: { id: { in: documentIds.filter((id) => !used.has(id)) }, organisationId: orgId },
            });
        }
        if (callRecordings.length) {
            await tx.callRecording.deleteMany({ where: { id: { in: callRecordings.map((r) => r.id) } } });
        }
    });

    let removed = 0;
    for (const file of files) {
        try {
            fs.unlinkSync(file);
            removed++;
        } catch (e) {
            console.warn(`Could not delete ${file}: ${(e as Error).message}`);
        }
    }
    console.log(`\nDone. Cleared ${calls.length} calls, deleted ${callRecordings.length} CallRecording rows and ${removed} files.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
