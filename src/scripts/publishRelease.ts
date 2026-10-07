/**
 * Publishes a new app release: upserts the `SystemSetting` row
 * (`app_release_<platform>`) that `GET /api/app-releases/latest` reads.
 * Run AFTER copying the .apk file itself into `uploads/releases/` — this
 * script only writes the version manifest, it doesn't move any files.
 *
 * Usage:
 *   npx tsx src/scripts/publishRelease.ts <platform> <apkFileName> <versionName> <versionCode> <releaseNotes>
 *
 * Example:
 *   npx tsx src/scripts/publishRelease.ts mobile PypeCRM-v1.1.0-prod.apk 1.1.0 3 "Bug fixes and performance improvements"
 */
import prisma from '../config/prisma';

const PLATFORMS = ['mobile', 'helper', 'dialer'];

async function main() {
    const [platform, apkFileName, versionName, versionCodeRaw, releaseNotes] = process.argv.slice(2);

    if (!platform || !apkFileName || !versionName || !versionCodeRaw || !releaseNotes) {
        console.error(
            'Usage: npx tsx src/scripts/publishRelease.ts <platform> <apkFileName> <versionName> <versionCode> <releaseNotes>'
        );
        process.exit(1);
    }

    if (!PLATFORMS.includes(platform)) {
        console.error(`platform must be one of: ${PLATFORMS.join(', ')}`);
        process.exit(1);
    }

    const versionCode = parseInt(versionCodeRaw, 10);
    if (Number.isNaN(versionCode)) {
        console.error('versionCode must be an integer');
        process.exit(1);
    }

    const manifest = {
        versionName,
        versionCode,
        releaseNotes,
        apkFileName,
        releasedAt: new Date().toISOString()
    };

    await prisma.systemSetting.upsert({
        where: { key: `app_release_${platform}` },
        update: { value: JSON.stringify(manifest), group: 'app_releases' },
        create: { key: `app_release_${platform}`, value: JSON.stringify(manifest), group: 'app_releases' }
    });

    console.log(`Published ${platform} release ${versionName} (code ${versionCode}) -> ${apkFileName}`);
}

main()
    .catch((error) => {
        console.error('publishRelease failed:', error);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
