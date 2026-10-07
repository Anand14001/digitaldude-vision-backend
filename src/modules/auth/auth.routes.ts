import { Router } from 'express';
import { asyncHandler, noContent, ok } from '../../lib/http';
import { validateBody } from '../../middleware/validate';
import { requireAuth, optionalAuth } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import * as service from './auth.service';
import {
  acceptInviteSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  preferencesSchema,
  resetPasswordSchema,
} from './auth.schema';

export const authRouter = Router();

authRouter.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => ok(res, await service.login(req, res, req.body))),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => ok(res, await service.refresh(req, res))),
);

authRouter.post(
  '/logout',
  optionalAuth,
  asyncHandler(async (req, res) => {
    await service.logout(req, res);
    return noContent(res);
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => ok(res, await service.me(req.ctx.user.id))),
);

authRouter.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await service.changePassword(req, req.body);
    return noContent(res);
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    await service.forgotPassword(req, req.body.email);
    // Always 204, whether or not the address matched an account.
    return noContent(res);
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    await service.resetPassword(req, req.body);
    return noContent(res);
  }),
);

authRouter.post(
  '/accept-invite',
  authLimiter,
  validateBody(acceptInviteSchema),
  asyncHandler(async (req, res) => ok(res, await service.acceptInvite(req, res, req.body))),
);

authRouter.patch(
  '/preferences',
  requireAuth,
  validateBody(preferencesSchema),
  asyncHandler(async (req, res) =>
    ok(res, await service.updatePreferences(req.ctx.user.id, req.body)),
  ),
);
