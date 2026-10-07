import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import {
  ALL_PERMISSIONS,
  BASELINE_STAFF_PERMISSIONS,
  expandPermissions,
} from '../permissions/registry';
import type { AuthContext } from '../types/express';

/**
 * Resolves the caller's effective permissions:
 *   admin role            -> everything in the registry
 *   staff                 -> baseline + role grants + per-user overrides
 *   client portal user    -> no staff permissions at all; scoped by clientId
 *
 * Client users are deliberately given an empty permission set. Portal routes
 * authorise on `kind === 'CLIENT'` plus ownership of the record, never on a
 * permission key, so a misconfigured role can never expose client-side data.
 */
async function loadContext(userId: string): Promise<AuthContext> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      kind: true,
      status: true,
      mustChangePassword: true,
      roleId: true,
      role: { select: { name: true, isAdmin: true, permissions: true } },
      employee: { select: { id: true } },
      clientContact: { select: { clientId: true, portalEnabled: true, canApprove: true } },
      permissionGrants: { select: { permission: true, allow: true } },
    },
  });

  if (!user) throw unauthorized('Account no longer exists');
  if (user.status === 'SUSPENDED') throw forbidden('This account has been suspended');
  if (user.status === 'INVITED') throw forbidden('Please accept your invitation first');

  let permissions = new Set<string>();

  if (user.kind === 'STAFF') {
    if (user.role?.isAdmin) {
      permissions = new Set(ALL_PERMISSIONS);
    } else {
      const granted = [...BASELINE_STAFF_PERMISSIONS, ...(user.role?.permissions ?? [])];
      permissions = expandPermissions(granted);
      // Overrides are applied last so an explicit revoke always wins.
      for (const g of user.permissionGrants) {
        if (g.allow) for (const k of expandPermissions([g.permission])) permissions.add(k);
      }
      for (const g of user.permissionGrants) {
        if (!g.allow) permissions.delete(g.permission);
      }
    }
  } else if (!user.clientContact?.portalEnabled) {
    throw forbidden('Portal access has been disabled for this account');
  }

  const ctx: AuthContext = {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      kind: user.kind,
      status: user.status,
      roleId: user.roleId,
      roleName: user.role?.name ?? null,
      isAdmin: user.role?.isAdmin ?? false,
      mustChangePassword: user.mustChangePassword,
    },
    permissions,
    employeeId: user.employee?.id ?? null,
    clientId: user.clientContact?.clientId ?? null,
    canApprove: user.clientContact?.canApprove ?? false,
    has: (p) => permissions.has(p),
    hasAny: (...ps) => ps.some((p) => permissions.has(p)),
  };

  return ctx;
}

const bearerFrom = (req: Request): string | null => {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
};

/** Rejects the request unless a valid access token is present. */
export const requireAuth: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const token = bearerFrom(req);
      if (!token) throw unauthorized();

      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch {
        throw unauthorized('Session expired');
      }

      const ctx = await loadContext(payload.sub);
      req.auth = ctx;
      req.ctx = ctx;
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/** Populates req.auth when a token is present but never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    const token = bearerFrom(req);
    if (!token) return next();
    try {
      const payload = verifyAccessToken(token);
      const ctx = await loadContext(payload.sub);
      req.auth = ctx;
      req.ctx = ctx;
    } catch {
      // Ignored by design - the route treats the caller as anonymous.
    }
    next();
  })();
};

/** Staff-only routes: everything under /api except the portal. */
export const requireStaff: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (req.auth.user.kind !== 'STAFF') return next(forbidden('Staff access only'));
  next();
};

/** Portal-only routes. */
export const requireClient: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (req.auth.user.kind !== 'CLIENT' || !req.auth.clientId) {
    return next(forbidden('Client portal access only'));
  }
  next();
};

/**
 * Blocks everything except the change-password endpoint while a forced password
 * change is outstanding, so an admin-reset account cannot keep working.
 */
export const blockIfPasswordChangeRequired: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  if (req.auth?.user.mustChangePassword) {
    return next(forbidden('You must change your password before continuing'));
  }
  next();
};
