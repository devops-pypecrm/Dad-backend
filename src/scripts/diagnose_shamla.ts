import prisma from '../config/prisma';

async function main() {
    let user = await prisma.user.findFirst({
        where: { email: 'shamlaemtees25@gamil.com' },
        select: { id: true, email: true, firstName: true, lastName: true, organisationId: true, role: true, isActive: true },
    });
    if (!user) {
        console.log('No exact match for shamlaemtees25@gamil.com, trying fuzzy...');
        const fuzzy = await prisma.user.findMany({
            where: { OR: [
                { email: { contains: 'shamla', mode: 'insensitive' } },
                { firstName: { contains: 'shamla', mode: 'insensitive' } },
            ]},
            select: { id: true, email: true, firstName: true, lastName: true, organisationId: true, role: true, isActive: true },
        });
        console.log('Fuzzy matches:', fuzzy);
        user = fuzzy[0] ?? null;
        if (!user) { console.log('No user found.'); return; }
    }
    console.log('User:', user);

    const org = await prisma.organisation.findUnique({ where: { id: user.organisationId! }, select: { id: true, name: true } });
    console.log('Org:', org);

    const settings = await prisma.callSettings.findUnique({ where: { organisationId: user.organisationId! } });
    console.log('CallSettings:', settings);

    const totalEver = await prisma.interaction.count({ where: { createdById: user.id, type: 'call' } });
    console.log('Total call rows ever:', totalEver);

    const recent = await prisma.interaction.findMany({
        where: { createdById: user.id, type: 'call' },
        select: { id: true, direction: true, duration: true, callStatus: true, date: true, createdAt: true, isDeleted: true, hardwareId: true, phoneNumber: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
    });
    console.log('Most recent 10 rows:');
    for (const r of recent) {
        console.log(`  dir=${r.direction} dur=${r.duration} status=${r.callStatus} isDeleted=${r.isDeleted} date=${r.date.toISOString()} createdAt=${r.createdAt.toISOString()} hw=${r.hardwareId} phone=${r.phoneNumber}`);
    }

    const logs = await prisma.helperActivityLog.findMany({
        where: { userId: user.id },
        orderBy: { clientTimestamp: 'desc' },
        take: 20,
    });
    console.log(`\nMost recent ${logs.length} HelperActivityLog rows (total ever: ${await prisma.helperActivityLog.count({ where: { userId: user.id } })}):`);
    for (const l of logs) {
        console.log(`  [${l.level}] ${l.event} :: ${l.detail ?? ''}  client=${l.clientTimestamp.toISOString()} received=${l.createdAt.toISOString()}`);
    }
}

main().catch((e) => console.error(e)).finally(() => process.exit(0));
