import jwt, { JwtPayload } from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import crypto from 'crypto';
import { getOrgId } from '../utils/hierarchyUtils';
import { isSuperAdmin as checkSuperAdmin, normalizeRole, isManager } from '../utils/roleUtils';
import { touchSessionLastActive } from '../services/sessionService';

export interface AuthRequest extends Request {
    user?: any; // Ideally this should be the Prisma User type, using any for quick migration
}

export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            console.log(`[AuthDebug] Incoming token: ${token.substring(0, 20)}...`);
            
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key_change_this') as JwtPayload;
            console.log('[AuthDebug] Decoded payload:', decoded);

            // Fetch user from Postgres using Prisma
            const user = await prisma.user.findUnique({
                where: { id: decoded.id },
                include: { organisation: true }
            });

            if (!user) {
                console.warn(`[AuthDebug] User not found for ID: ${decoded.id}`);
                res.status(401).json({ message: 'Not authorized, token failed' });
                return;
            }

            // Tokens issued before tokenVersion existed carry no claim at all —
            // treat that as version 0 so already-logged-in users aren't mass-logged-out
            // the moment this check ships; only an actual password change (which bumps
            // the DB value above 0) should invalidate anything.
            const tokenVersion = typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;
            if (tokenVersion !== user.tokenVersion) {
                console.warn(`[AuthDebug] Stale token version for user ${user.email} (token: ${tokenVersion}, current: ${user.tokenVersion}) — password was changed since this token was issued`);
                res.status(401).json({ message: 'Not authorized, token failed' });
                return;
            }

            // Per-device sign-out (Settings > Devices, mobile) — see the
            // UserSession model's doc comment in schema.prisma. Tokens
            // issued before this feature existed carry no `sessionId`
            // claim at all; those are NOT rejected here (same
            // backward-compat approach as tokenVersion above) — only a
            // token that DOES carry a sessionId gets checked against the
            // live UserSession row, so a user can be remotely signed out.
            const sessionId = typeof decoded.sessionId === 'string' ? decoded.sessionId : null;
            if (sessionId) {
                const session = await prisma.userSession.findUnique({ where: { id: sessionId } });
                if (!session || session.revokedAt) {
                    console.warn(`[AuthDebug] Revoked/missing session ${sessionId} for user ${user.email}`);
                    res.status(401).json({ message: 'Not authorized, token failed' });
                    return;
                }
                touchSessionLastActive(sessionId, req.ip || null);
            }

            console.log(`[AuthDebug] Authenticated user: ${user.email} (Role: ${user.role})`);

            // Exclude password from the object attached to request
            const userWithoutPassword = { ...user };
            delete (userWithoutPassword as any).password;

            // Check if user manages any branch
            const branchManaged = await prisma.branch.findFirst({
                where: { managerId: user.id, isDeleted: false }
            });

            // Attach role info if custom or known role
            let roleRecord = null;
            if (user.role) {
                roleRecord = await prisma.role.findFirst({
                    where: {
                        OR: [
                            { roleKey: user.role, organisationId: user.organisationId },
                            { roleKey: user.role, organisationId: null },
                            { id: user.role }
                        ]
                    }
                });
            }

            // Attach user to request
            req.user = {
                ...userWithoutPassword,
                roleName: roleRecord?.name || (user.role === 'custom_1774677200913' ? 'ASM' : user.role),
                roleRecord,
                permissions: roleRecord?.permissions || (user as any).permissions || [],
                isSuperAdmin: checkSuperAdmin(user),
                isBranchManager: !!branchManaged,
                sessionId
            };

            // console.log(`[AuthMiddleware] Authenticated user: ${ user.email } `); 
            return next();
        } catch (error: any) {
            // Real token verification failures get 401 (forces logout)
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' || error.message?.includes('jwt')) {
                console.warn(`[AuthMiddleware] JWT verification failed: ${error.message || error.name}`);
                res.status(401).json({ message: 'Not authorized, token failed' });
            } else {
                console.error('[AuthMiddleware] Database or Internal Error:', error);
                // Database or internal connection errors get 503 (keeps users logged in, doesn't wipe localStorage)
                res.status(503).json({ message: 'Database service temporarily unavailable, please try again' });
            }
        }
    }


    // Check for API Key if no Bearer token
    if (!token && req.headers['x-api-key']) {
        try {
            const rawKey = req.headers['x-api-key'] as string;
            // Key format: crm_HEXSTRING (ignore prefix for hash if needed, but model says keyHash stores hash of full key)
            // Model says: verifyKey = sha256 of key.

            const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

            const apiKey = await prisma.apiKey.findUnique({
                where: { keyHash, isDeleted: false, status: 'active' }
            });

            if (apiKey) {
                // Update usage stats (optional, could be fire-and-forget)
                // await prisma.apiKey.update({ where: { id: apiKey.id }, data: { usage: { ...apiKey.usage, lastUsedAt: new Date() } } });

                const user = await prisma.user.findUnique({
                    where: { id: apiKey.createdById },
                    include: { organisation: true }
                });

                if (user) {
                    const userWithoutPassword = { ...user };
                    delete (userWithoutPassword as any).password;

                    // Check if user manages any branch
                    const branchManaged = await prisma.branch.findFirst({
                        where: { managerId: user.id, isDeleted: false }
                    });

                    req.user = {
                        ...userWithoutPassword,
                        isSuperAdmin: checkSuperAdmin(user),
                        isBranchManager: !!branchManaged
                    };
                    return next();
                }
            }
        } catch (error) {
            console.error('[AuthMiddleware] API Key Error:', error);
            // Fallthrough to 401
        }
    }

    if (!token && !req.user) {
        res.status(401).json({ message: 'Not authorized, no token' });
        return;
    }
};

export const admin = (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user && (normalizeRole(req.user.role) === 'admin' || checkSuperAdmin(req.user))) {
        next();
    } else {
        res.status(403).json({ message: 'Not authorized as an admin' });
    }
};

export const authorize = (...roles: string[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const user = req.user;
        const userRole = user ? normalizeRole(user.role) : '';
        const userRoleName = (user as any)?.roleName ? normalizeRole((user as any).roleName) : '';
        const normRoles = roles.map(r => r.toLowerCase().replace(/[\s-]/g, '_'));

        let isAuthorized = normRoles.includes(userRole) || (userRoleName && normRoles.includes(userRoleName));
        if (!isAuthorized && normRoles.includes('manager')) {
            isAuthorized = isManager(user);
        }

        if (!req.user || !isAuthorized) {
            return res.status(403).json({ message: `User role ${req.user?.role} is not authorized` });
        }
        next();
    };
};
