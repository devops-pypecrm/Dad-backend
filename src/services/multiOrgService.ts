import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Request } from 'express';
import prisma from '../config/prisma';
import generateToken from '../utils/generateToken';
import { createSession } from './sessionService';
import { logAudit } from '../utils/auditLogger';

/**
 * Multiple organisations for one admin.
 *
 * Model: the same person has ONE real admin User row per organisation; rows that belong to the
 * same person share `User.accountGroupId`. Every organisation is therefore a normal, fully
 * isolated tenant (its own admin user, leads, branches, roles...), and no request-handling code
 * changes. "Switching" just issues a login token for the sibling row. Only the Super Admin can
 * turn this on, via the `multi_organisation` platform feature on the owner's organisation.
 */
export const FEATURE_KEY = 'multi_organisation';

const isAdminRole = (role?: string | null) => role === 'admin';

/** Every user row in the caller's group (including the caller), with org info. */
async function groupMembers(user: any) {
    if (!user.accountGroupId) return [];
    return prisma.user.findMany({
        where: { accountGroupId: user.accountGroupId, isActive: true, organisationId: { not: null } },
        select: {
            id: true, organisationId: true,
            organisation: { select: { id: true, name: true, status: true, isDeleted: true, logo: true, enabledFeatures: true } }
        },
        orderBy: { createdAt: 'asc' }
    });
}

/** The feature counts as enabled if ANY organisation in the group (or the caller's own) has it. */
async function isEnabledFor(user: any, members?: Awaited<ReturnType<typeof groupMembers>>) {
    const own = await prisma.organisation.findUnique({ where: { id: user.organisationId }, select: { enabledFeatures: true } });
    if (own?.enabledFeatures?.includes(FEATURE_KEY)) return true;
    const list = members ?? await groupMembers(user);
    return list.some(m => m.organisation?.enabledFeatures?.includes(FEATURE_KEY));
}

export const MultiOrgService = {
    async list(user: any) {
        if (!user?.organisationId) return { enabled: false, canCreate: false, organisations: [] }; // e.g. platform super admin
        const members = await groupMembers(user);
        const enabled = await isEnabledFor(user, members);
        const organisations = members
            .filter(m => m.organisation && !m.organisation.isDeleted)
            .map(m => ({
                organisationId: m.organisationId as string,
                name: m.organisation!.name,
                status: m.organisation!.status,
                logo: (m.organisation as any).logo ?? null,
                isCurrent: m.organisationId === user.organisationId
            }));
        // Nothing to show (and no switcher) until the feature is on or a group exists.
        return { enabled, canCreate: enabled && isAdminRole(user.role), organisations };
    },

    async create(user: any, input: { name: string }) {
        if (!isAdminRole(user.role)) throw Object.assign(new Error('Only an organisation admin can create organisations'), { status: 403 });
        if (!(await isEnabledFor(user))) throw Object.assign(new Error('Multiple organisations is not enabled for this account. Ask the platform admin to enable it.'), { status: 403 });

        const name = (input.name || '').trim();
        if (name.length < 2 || name.length > 120) throw Object.assign(new Error('Organisation name must be 2-120 characters'), { status: 400 });

        const source = await prisma.organisation.findUnique({ where: { id: user.organisationId } });
        if (!source) throw Object.assign(new Error('Current organisation not found'), { status: 404 });

        const owner = await prisma.user.findUnique({ where: { id: user.id } });
        if (!owner) throw Object.assign(new Error('User not found'), { status: 404 });
        const groupId = owner.accountGroupId || owner.id;

        const activeLicense = await prisma.license.findFirst({
            where: { organisationId: source.id, status: { in: ['active', 'trial'] } },
            orderBy: { createdAt: 'desc' }
        });

        // Placeholder login for the new org's admin row: deliverable to the owner (plus-address)
        // but with an unusable password, so the only way in is via the switcher.
        const [local, domain] = owner.email.split('@');
        const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
        const suffix = crypto.randomBytes(3).toString('hex');
        const placeholderEmail = `${local.split('+')[0]}+org${suffix}@${domain}`;
        const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

        const result = await prisma.$transaction(async (tx) => {
            const org = await tx.organisation.create({
                data: {
                    name,
                    slug: `${slugBase}-${suffix}`,
                    contactEmail: owner.email,
                    status: 'active',
                    currency: source.currency,
                    userLimit: source.userLimit,
                    subscription: (source.subscription ?? undefined) as any,
                    billingEnabled: source.billingEnabled,
                }
            });
            await tx.product.create({
                data: {
                    name, description: `Custom product for ${name}`, basePrice: 0, isCustom: true, isOrgProduct: true,
                    organisationId: org.id, sku: `CUSTOM-${org.id.slice(0, 8).toUpperCase()}`
                }
            });
            const adminRow = await tx.user.create({
                data: {
                    email: placeholderEmail, firstName: owner.firstName, lastName: owner.lastName,
                    password: unusablePassword, role: 'admin', organisationId: org.id, isActive: true,
                    phone: owner.phone, profileImage: owner.profileImage, accountGroupId: groupId
                }
            });
            await tx.organisation.update({ where: { id: org.id }, data: { createdBy: adminRow.id } });
            if (!owner.accountGroupId) {
                await tx.user.update({ where: { id: owner.id }, data: { accountGroupId: groupId } });
            }
            if (activeLicense) {
                await tx.license.create({
                    data: {
                        organisationId: org.id, planId: activeLicense.planId, status: activeLicense.status,
                        startDate: new Date(), endDate: activeLicense.endDate, maxUsers: activeLicense.maxUsers,
                        autoRenew: activeLicense.autoRenew, customPrice: activeLicense.customPrice
                    }
                });
            }
            return { org, adminRow };
        });

        logAudit({
            action: 'CREATE_ORGANISATION', entity: 'Organisation', entityId: result.org.id, actorId: user.id,
            organisationId: source.id,
            details: { via: 'multi_organisation', name, newOrganisationId: result.org.id, copiedPlanFrom: source.id, licenseCopied: !!activeLicense }
        });
        logAudit({
            action: 'CREATE_ORGANISATION', entity: 'Organisation', entityId: result.org.id, actorId: result.adminRow.id,
            organisationId: result.org.id, details: { via: 'multi_organisation', createdFromOrganisationId: source.id }
        });

        return { id: result.org.id, name: result.org.name };
    },

    /** Issues a login for the caller's admin row in another organisation of the same group. */
    async switchTo(user: any, targetOrgId: string, req: Request) {
        if (!user.accountGroupId) throw Object.assign(new Error('No other organisations on this account'), { status: 403 });
        if (targetOrgId === user.organisationId) throw Object.assign(new Error('Already in this organisation'), { status: 400 });

        const target = await prisma.user.findFirst({
            where: { accountGroupId: user.accountGroupId, organisationId: targetOrgId, isActive: true },
            include: { organisation: true }
        });
        if (!target || !target.organisation || target.organisation.isDeleted) {
            throw Object.assign(new Error('Organisation not found on this account'), { status: 404 });
        }
        // Feature must still be on for the group (Super Admin can switch it off).
        const members = await groupMembers(user);
        if (!(await isEnabledFor(user, members))) throw Object.assign(new Error('Multiple organisations is not enabled for this account'), { status: 403 });

        const sessionId = await createSession(target.id, target.organisationId, req, { platform: 'web' });
        const roleRecord = await prisma.role.findFirst({
            where: { OR: [{ roleKey: target.role, organisationId: target.organisationId }, { roleKey: target.role, organisationId: null }, { id: target.role }] }
        });
        const branchManaged = await prisma.branch.findFirst({ where: { managerId: target.id, isDeleted: false } });

        logAudit({
            action: 'SWITCH_ORGANISATION', entity: 'Organisation', entityId: targetOrgId, actorId: user.id,
            organisationId: user.organisationId, ipAddress: req.ip,
            details: { from: user.organisationId, to: targetOrgId, asUserId: target.id }
        });
        logAudit({
            action: 'LOGIN', entity: 'User', entityId: target.id, actorId: target.id, organisationId: targetOrgId,
            ipAddress: req.ip, userAgent: req.headers['user-agent'], details: { via: 'organisation_switch', fromUserId: user.id }
        });

        // Same shape as POST /auth/login so the web app can store it unchanged.
        return {
            _id: target.id, id: target.id, firstName: target.firstName, lastName: target.lastName,
            email: user.email, // show the owner's real email, not the placeholder
            role: target.role, roleName: roleRecord?.name || target.role, roleRecord,
            position: target.position, phone: target.phone, profileImage: target.profileImage,
            isBranchManager: !!branchManaged, organisation: target.organisation, branchId: target.branchId,
            token: generateToken(target.id, target.tokenVersion, sessionId)
        };
    }
};
