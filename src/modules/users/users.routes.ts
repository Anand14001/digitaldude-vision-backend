import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { randomToken } from '../../lib/password';
import { layout, sendMail } from '../../lib/mailer';
import { env } from '../../config/env';
import { isKnownPermission } from '../../permissions/registry';

export const usersRouter = Router();

const INVITE_TTL_DAYS = 7;

const listQuery = paginationSchema.extend({
  kind: z.enum(['STAFF', 'CLIENT']).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED']).optional(),
  roleId: z.string().cuid().optional(),
});

usersRouter.get(
  '/',
  requirePermission('settings.users.manage'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      deletedAt: null,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.roleId ? { roleId: q.roleId } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          kind: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          role: { select: { id: true, name: true, isAdmin: true } },
          employee: { select: { id: true, employeeCode: true } },
          clientContact: { select: { client: { select: { id: true, name: true } } } },
        },
        ...skipTake(q),
      }),
      prisma.user.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

usersRouter.get(
  '/:id',
  requirePermission('settings.users.manage'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        kind: true,
        status: true,
        phone: true,
        lastLoginAt: true,
        createdAt: true,
        role: { select: { id: true, name: true, isAdmin: true } },
        permissionGrants: { select: { id: true, permission: true, allow: true } },
        employee: { select: { id: true, employeeCode: true } },
      },
    });
    if (!user) throw notFound('User');
    return ok(res, user);
  }),
);

/** Changes which role a staff user holds. */
usersRouter.patch(
  '/:id/role',
  requirePermission('settings.users.manage'),
  validateBody(z.object({ roleId: z.string().cuid().nullable() })),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, kind: true, roleId: true, role: { select: { name: true, isAdmin: true } } },
    });
    if (!target) throw notFound('User');
    if (target.kind !== 'STAFF') throw badRequest('Only staff accounts have roles');

    // Guard against removing the last administrator.
    if (target.role?.isAdmin) {
      const admins = await prisma.user.count({
        where: { deletedAt: null, status: 'ACTIVE', role: { isAdmin: true } },
      });
      if (admins <= 1) throw badRequest('At least one administrator must remain');
    }

    const nextRole = req.body.roleId
      ? await prisma.role.findUnique({ where: { id: req.body.roleId }, select: { name: true } })
      : null;
    if (req.body.roleId && !nextRole) throw notFound('Role');

    await prisma.user.update({
      where: { id: target.id },
      data: { roleId: req.body.roleId },
    });

    await auditFromRequest(req, {
      action: 'PERMISSION_CHANGE',
      entityType: 'User',
      entityId: target.id,
      entityLabel: target.name,
      summary: `Changed ${target.name}'s role to ${nextRole?.name ?? 'none'}`,
      diff: { role: { from: target.role?.name ?? null, to: nextRole?.name ?? null } },
    });

    return noContent(res);
  }),
);

/** Per-user exception on top of their role. */
usersRouter.put(
  '/:id/permission-overrides',
  requirePermission('settings.roles.manage'),
  validateBody(
    z.object({
      overrides: z
        .array(z.object({ permission: z.string(), allow: z.boolean() }))
        .max(100),
    }),
  ),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, kind: true },
    });
    if (!target) throw notFound('User');
    if (target.kind !== 'STAFF') {
      throw badRequest('Client portal accounts are scoped by account, not by permissions');
    }

    const overrides = (req.body.overrides as { permission: string; allow: boolean }[]).filter(
      (o) => isKnownPermission(o.permission),
    );

    await prisma.$transaction(async (tx) => {
      await tx.userPermissionOverride.deleteMany({ where: { userId: target.id } });
      if (overrides.length) {
        await tx.userPermissionOverride.createMany({
          data: overrides.map((o) => ({
            userId: target.id,
            permission: o.permission,
            allow: o.allow,
          })),
        });
      }
    });

    await auditFromRequest(req, {
      action: 'PERMISSION_CHANGE',
      entityType: 'User',
      entityId: target.id,
      entityLabel: target.name,
      summary: `Set ${overrides.length} permission override(s) on ${target.name}`,
      diff: { overrides: { from: null, to: overrides } },
    });

    return ok(res, { overrides });
  }),
);

/** Re-sends (or first sends) an invite link. */
usersRouter.post(
  '/:id/resend-invite',
  requirePermission('settings.users.manage'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, email: true, status: true, kind: true },
    });
    if (!user) throw notFound('User');
    if (user.status === 'ACTIVE') throw badRequest('This account is already active');

    const token = randomToken();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        inviteToken: token,
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        status: 'INVITED',
      },
    });

    const base = env.webOrigins[0] ?? '';
    const path = user.kind === 'CLIENT' ? '/portal/accept-invite' : '/accept-invite';
    await sendMail({
      to: user.email,
      subject: 'Your Vision invitation',
      html: layout({
        heading: 'You have been invited',
        body: `<p>Hi ${user.name.split(' ')[0] ?? 'there'},</p><p>An account has been created for you on Vision, the Digital Dude workspace. Set your password to get started. This link expires in ${INVITE_TTL_DAYS} days.</p>`,
        ctaLabel: 'Set your password',
        ctaUrl: `${base}${path}?token=${token}`,
      }),
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      entityLabel: user.name,
      summary: `Sent an invitation to ${user.email}`,
    });

    return created(res, { sent: true });
  }),
);

usersRouter.patch(
  '/:id/status',
  requirePermission('settings.users.manage'),
  validateBody(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) })),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, status: true, role: { select: { isAdmin: true } } },
    });
    if (!target) throw notFound('User');
    if (target.id === req.ctx.user.id) throw badRequest('You cannot change your own status');

    if (req.body.status === 'SUSPENDED' && target.role?.isAdmin) {
      const admins = await prisma.user.count({
        where: { deletedAt: null, status: 'ACTIVE', role: { isAdmin: true } },
      });
      if (admins <= 1) throw badRequest('At least one active administrator must remain');
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { status: req.body.status } });
      if (req.body.status === 'SUSPENDED') {
        // Suspension must take effect immediately, not when the token expires.
        await tx.refreshToken.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });

    await auditFromRequest(req, {
      action: 'STATUS_CHANGE',
      entityType: 'User',
      entityId: target.id,
      entityLabel: target.name,
      summary: `${req.body.status === 'SUSPENDED' ? 'Suspended' : 'Reactivated'} ${target.name}`,
      diff: { status: { from: target.status, to: req.body.status } },
    });

    return noContent(res);
  }),
);

/** Forces a password change on next sign-in and ends current sessions. */
usersRouter.post(
  '/:id/force-password-reset',
  requirePermission('settings.users.manage'),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    if (!target) throw notFound('User');

    const token = randomToken();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: {
          mustChangePassword: true,
          resetToken: token,
          resetExpiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await sendMail({
      to: target.email,
      subject: 'Set a new Vision password',
      html: layout({
        heading: 'Password reset required',
        body: '<p>An administrator has asked you to set a new password. The link below is valid for one hour.</p>',
        ctaLabel: 'Set a new password',
        ctaUrl: `${env.webOrigins[0] ?? ''}/reset-password?token=${token}`,
      }),
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: target.id,
      entityLabel: target.name,
      summary: `Forced a password reset for ${target.name}`,
    });

    return noContent(res);
  }),
);
