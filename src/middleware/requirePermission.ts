import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../lib/errors';
import { isKnownPermission } from '../permissions/registry';

/**
 * Route guard. The API is the only real gate - the SPA merely hides UI - so
 * every mutating route declares what it needs.
 *
 * Passing several keys means "any of these", which is how scoped reads work:
 * requirePermission('projects.view.all', 'projects.view.assigned') lets the
 * handler through and the service layer then narrows the query.
 */
export const requirePermission = (...permissions: string[]): RequestHandler => {
  for (const p of permissions) {
    if (!isKnownPermission(p)) {
      // A typo here would silently lock a route open or shut, so fail at boot.
      throw new Error(`Unknown permission key referenced by a route: ${p}`);
    }
  }
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.user.kind !== 'STAFF') return next(forbidden('Staff access only'));
    if (!req.auth.hasAny(...permissions)) {
      return next(forbidden('Your role does not allow this action'));
    }
    next();
  };
};

/** Requires every listed permission rather than any one of them. */
export const requireAllPermissions = (...permissions: string[]): RequestHandler => {
  permissions.forEach((p) => {
    if (!isKnownPermission(p)) throw new Error(`Unknown permission key: ${p}`);
  });
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!permissions.every((p) => req.auth?.has(p))) {
      return next(forbidden('Your role does not allow this action'));
    }
    next();
  };
};
