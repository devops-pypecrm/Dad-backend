
/**
 * Normalizes a role string or object to a standardized key format.
 * (e.g. "Super Admin" -> "super_admin")
 */
export function normalizeRole(role: any): string {
    if (!role) return '';

    if (typeof role === 'object') {
        const roleStr = role.name || role.roleKey || role.id || '';
        return String(roleStr).toLowerCase().replace(/[\s-]/g, '_');
    }

    return String(role).toLowerCase().replace(/[\s-]/g, '_');
}

/**
 * Checks if a user has any of the target roles.
 */
export function checkRole(user: any, targetRoles: string | string[]): boolean {
    if (!user || !user.role) return false;

    const userRoleStr = normalizeRole(user.role);
    const roleName = (user.roleName || (typeof user.role === 'object' ? user.role.name : '') || '').toLowerCase();
    const targets = Array.isArray(targetRoles) ? targetRoles : [targetRoles];

    const match = targets.some(target => {
        const normalizedTarget = target.toLowerCase().replace(/[\s-]/g, '_');
        return normalizedTarget === userRoleStr || (roleName && normalizedTarget === roleName);
    });

    if (match) return true;

    if (targets.some(t => t.toLowerCase() === 'manager')) {
        if (
            userRoleStr.includes('manager') ||
            userRoleStr === 'asm' ||
            userRoleStr.includes('asm') ||
            userRoleStr === 'custom_1774677200913' ||
            roleName.includes('manager') ||
            roleName === 'asm' ||
            roleName.includes('asm')
        ) {
            return true;
        }
    }

    return false;
}

/**
 * Formats a role key or role object into a human-friendly display name.
 * e.g. "custom_1774677200913" -> "ASM"
 *      "sales_rep" -> "Sales Rep"
 */
export function formatRoleName(role: any, fallbackName?: string): string {
    if (!role) return fallbackName || '';
    if (typeof role === 'object') {
        return role.name || role.roleKey || fallbackName || '';
    }
    const r = String(role);
    if (r === 'custom_1774677200913' || r.toLowerCase() === 'asm') return 'ASM';
    if (fallbackName && fallbackName !== r) return fallbackName;
    if (r === 'super_admin') return 'Super Admin';
    if (r === 'admin') return 'Admin';
    if (r === 'manager') return 'Manager';
    if (r === 'sales_manager') return 'Sales Manager';
    if (r === 'sales_rep') return 'Sales Rep';
    if (r === 'operation_executive') return 'Operation Executive';
    if (r.startsWith('custom_')) return fallbackName || 'Custom Role';
    return r.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Helper for Super Admin check
 */
export function isSuperAdmin(user: any): boolean {
    return checkRole(user, 'super_admin');
}

/**
 * Helper for Admin check (includes Super Admin)
 */
export function isAdmin(user: any): boolean {
    return checkRole(user, ['admin', 'super_admin']);
}

/**
 * Roles that see/report on the WHOLE organisation's leads/opportunities
 * rather than a reporting-chain-scoped subset — admin, super_admin, and
 * Operation Executive (an org-wide interaction role with none of admin's
 * settings/user-management permissions — those are governed separately by
 * the Role.permissions array, not this check). Deliberately NOT folded into
 * `isAdmin()`, since that helper also gates settings/permission short-circuits
 * elsewhere (see `hasUserPermission`) that Operation Executive must not get.
 */
export function hasOrgWideVisibility(user: any): boolean {
    return checkRole(user, ['admin', 'super_admin', 'operation_executive']);
}

/**
 * Helper for Org Admin check (includes Admin and Super Admin)
 */
export function isOrgAdmin(user: any): boolean {
    return checkRole(user, ['org_admin', 'organisation_admin', 'admin', 'super_admin']);
}

/**
 * Helper for Manager check (includes Admin, Super Admin, Sales Manager, ASM)
 */
export function isManager(user: any): boolean {
    return checkRole(user, ['manager', 'admin', 'super_admin', 'sales_manager', 'branch_manager', 'asm']);
}

import prisma from '../config/prisma';

/**
 * Resolves whether a user has a specific permission based on direct overrides or role templates.
 */
export async function hasUserPermission(userId: string, targetPermission: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, permissions: true }
    });

    if (!user) return false;

    // Standard admins and super admins have all permissions
    const normalizedRole = normalizeRole(user.role);
    if (normalizedRole === 'admin' || normalizedRole === 'super_admin') {
        return true;
    }

    // Check direct user permissions override
    if (user.permissions && Array.isArray(user.permissions)) {
        if (user.permissions.includes('*') || user.permissions.includes(targetPermission)) {
            return true;
        }
        
        // Handle namespace wildcard like 'users:*'
        const parts = targetPermission.split(':');
        if (parts.length > 1) {
            const wildcardNamespace = `${parts[0]}:*`;
            if (user.permissions.includes(wildcardNamespace)) {
                return true;
            }
        }
    }

    // Check role permissions override
    const roleRecord = await prisma.role.findFirst({
        where: {
            OR: [
                { id: user.role },
                { roleKey: user.role }
            ]
        }
    });

    if (roleRecord && roleRecord.permissions && Array.isArray(roleRecord.permissions)) {
        if (roleRecord.permissions.includes('*') || roleRecord.permissions.includes(targetPermission)) {
            return true;
        }

        // Handle namespace wildcard like 'users:*'
        const parts = targetPermission.split(':');
        if (parts.length > 1) {
            const wildcardNamespace = `${parts[0]}:*`;
            if (roleRecord.permissions.includes(wildcardNamespace)) {
                return true;
            }
        }
    }

    return false;
}

