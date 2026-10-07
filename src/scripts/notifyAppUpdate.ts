/**
 * Common notify step for both app platforms — shares one script/CLI shape
 * with `publishRelease.ts` (`<platform> ...`) so `publish_release.sh` can
 * call this unconditionally after every publish instead of branching on
 * platform itself.
 *
 * `platform=mobile`: pushes an "update available" notification to every
 * user with a registered FCM token (`User.fcmToken`), cross-organisation —
 * app releases aren't tenant-scoped, so this deliberately isn't org-filtered
 * like `broadcastNotification` (that endpoint is an unrelated org-admin
 * announcement feature, no push, not reused here). Goes through
 * `NotificationService.send()` (type: 'app_update') so each recipient gets
 * both the in-app bell notification AND a real FCM push — the mobile app's
 * `PushNotificationsController` recognizes `data.type === 'app_update'`
 * specifically: if the app is in the foreground it re-checks for an update
 * and shows the dialog immediately (no relaunch needed); if
 * backgrounded/killed, tapping the system notification deep-links straight
 * to the in-app Updates screen.
 *
 * `platform=helper` / `platform=dialer`: a deliberate no-op, not an
 * oversight. Neither Dad-call-recorder (PypeCRM Helper) nor Dad-dialer has
 * any Firebase/FCM integration — no token to push to, and no in-app bell UI
 * to show a CRM `Notification` row in even if we created one — so there is
 * nothing this script could actually deliver for either. Both apps' own
 * in-app update checker already polls the release manifest on every app
 * open and pops the same update dialog without any push needed; this
 * branch just says so instead of silently doing nothing or (worse)
 * pretending to have notified someone.
 *
 * Run AFTER `publishRelease.ts` has actually published the new version —
 * this only notifies, it doesn't check or change what's published.
 * `publish_release.sh` calls this automatically after every publish; run
 * `notify_app_update.sh <platform> <versionName>` by hand to re-nudge
 * mobile stragglers later without publishing anything new.
 *
 * Usage:
 *   npx tsx src/scripts/notifyAppUpdate.ts <platform> <versionName>
 *   <platform> must be "mobile", "helper", or "dialer"
 */
import prisma from '../config/prisma';
import { NotificationService } from '../services/notificationService';

const CHUNK_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

async function main() {
    const [platform, versionName] = process.argv.slice(2);
    if (!platform || !versionName || !['mobile', 'helper', 'dialer'].includes(platform)) {
        console.error('Usage: npx tsx src/scripts/notifyAppUpdate.ts <platform> <versionName>');
        console.error('  <platform> must be "mobile", "helper", or "dialer"');
        process.exit(1);
    }

    if (platform === 'helper' || platform === 'dialer') {
        const appName = platform === 'helper' ? 'PypeCRM Helper' : 'Pype Dialer';
        console.log(
            `${appName} has no push notifications wired up — nothing to send. ` +
            'Its in-app update popup already checks on every app open, so no action is needed here.'
        );
        return;
    }

    const users = await prisma.user.findMany({
        where: { fcmToken: { not: null }, isActive: true, isDeleted: false },
        select: { id: true }
    });

    if (users.length === 0) {
        console.log('No users with a registered device token — nothing to notify.');
        return;
    }

    const title = 'Update available';
    const message = `Version ${versionName} is available. Tap to update.`;

    let sent = 0;
    for (const batch of chunk(users, CHUNK_SIZE)) {
        const results = await Promise.allSettled(
            batch.map((user) => NotificationService.send(user.id, title, message, 'app_update'))
        );
        sent += results.filter((r) => r.status === 'fulfilled').length;
    }

    console.log(`Notified ${sent}/${users.length} users about version ${versionName}.`);
}

main()
    .catch((error) => {
        console.error('notifyAppUpdate failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
