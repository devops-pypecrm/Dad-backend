/**
 * Platform-wide broadcast alert - shows a large, non-dismissible popup to
 * every logged-in user across every organisation (or just org admins),
 * the next time their app polls/loads notifications. Goes through the live
 * server's own `/api/super-admin/broadcast-notification` endpoint (not a
 * direct DB write) so Socket.io delivers it in real time to anyone online
 * right now, exactly like a super admin sending it from the UI would.
 *
 * Usage:
 *   npx tsx scripts/broadcast.ts \
 *     --title "Meta integration update" \
 *     --message "We're rolling out improvements to Meta Ads..." \
 *     --severity warning \
 *     --audience all
 *
 * Flags:
 *   --title      (required) short headline shown in the popup
 *   --message    (required) full body text
 *   --severity   info | warning | critical | update   (default: info)
 *   --audience   all | admins | self                   (default: admins)
 *                "self" only notifies the account you log in as - use this
 *                to safely test-drive a broadcast against the real, live
 *                database without notifying anyone else.
 *   --base-url   API base, e.g. https://pypecrm.com     (default: $API_BASE_URL or https://pypecrm.com)
 *   --dry-run    print what would be sent, don't call the API
 *
 * Auth: reads SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD from the environment
 * (export them in your shell, or prefix the command with them) - never
 * hardcode credentials into this file or commit them.
 */
import axios from 'axios';

const VALID_SEVERITIES = ['info', 'warning', 'critical', 'update'];

function parseArgs(argv: string[]) {
    const args: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const title = args.title as string | undefined;
    const message = args.message as string | undefined;
    const severity = (args.severity as string) || 'info';
    const audience = (args.audience as string) || 'admins';
    const baseUrl = (args['base-url'] as string) || process.env.API_BASE_URL || 'https://pypecrm.com';
    const dryRun = !!args['dry-run'];

    if (!title || !message) {
        console.error('Usage: npx tsx scripts/broadcast.ts --title "..." --message "..." [--severity info|warning|critical|update] [--audience all|admins] [--base-url https://...] [--dry-run]');
        process.exitCode = 1;
        return;
    }
    if (!VALID_SEVERITIES.includes(severity)) {
        console.error(`Invalid --severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`);
        process.exitCode = 1;
        return;
    }
    if (audience !== 'all' && audience !== 'admins' && audience !== 'self') {
        console.error(`Invalid --audience "${audience}". Must be "all", "admins", or "self".`);
        process.exitCode = 1;
        return;
    }

    const audienceLabel = audience === 'all'
        ? 'EVERY active user, every org'
        : audience === 'self'
            ? 'YOU ONLY (test mode)'
            : 'organisation admins only';
    console.log(`Target: ${baseUrl}`);
    console.log(`Audience: ${audienceLabel}`);
    console.log(`Severity: ${severity}`);
    console.log(`Title: ${title}`);
    console.log(`Message: ${message}`);

    if (dryRun) {
        console.log('\n[dry-run] Not sending - no login, no API call made.');
        return;
    }

    const email = process.env.SUPER_ADMIN_EMAIL;
    const password = process.env.SUPER_ADMIN_PASSWORD;
    if (!email || !password) {
        console.error('\nMissing credentials - set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in your shell env before running this script.');
        process.exitCode = 1;
        return;
    }

    console.log('\nLogging in as super admin...');
    const loginRes = await axios.post(`${baseUrl}/api/auth/login`, { email, password });
    const token = loginRes.data?.token;
    if (!token) {
        console.error('Login did not return a token - aborting.');
        process.exitCode = 1;
        return;
    }

    console.log('Sending broadcast...');
    const res = await axios.post(
        `${baseUrl}/api/super-admin/broadcast-notification`,
        { title, message, severity, audience },
        { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log(`\n${res.data?.message || 'Done.'}`);
}

main().catch((err) => {
    console.error('\nBroadcast failed:', err.response?.data?.message || err.message);
    process.exitCode = 1;
});
