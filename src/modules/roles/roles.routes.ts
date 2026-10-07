import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { PERMISSION_GROUPS, sanitizePermissions } from '../../permissions/registry';

export const rolesRouter = Router();

const roleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).default([]),
});

/** The catalogue the Settings UI renders its permission matrix from. */
rolesRouter.get(
  '/permissions',
  requirePermission('settings.roles.manage'),
  asyncHandler(async (_req, res) => ok(res, { groups: PERMISSION_GROUPS })),
);

rolesRouter.get(
  '/',
  requirePermission('settings.roles.manage', 'settings.users.manage'),
  asyncHandler(async (_req, res) => {
    const roles = await prisma.role.findMany({
      orderBy: [{ isAdmin: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { users: true } } },
    });
    return ok(res, roles);
  }),
);

rolesRouter.get(
  '/:id',
  requirePermission('settings.roles.manage'),
  asyncHandler(async (req, res) => {
    const role = await prisma.role.findUnique({
      where: { id: req.params.id },
      include: {
        users: {
          where: { deletedAt: null },
          select: { id: true, name: true, email: true, status: true },
        },
      },
    });
    if (!role) throw notFound('Role');
    return ok(res, role);
  }),
);

rolesRouter.post(
  '/',
  requirePermission('settings.roles.manage'),
  validateBody(roleBody),
  asyncHandler(async (req, res) => {
    const permissions = sanitizePermissions(req.body.permissions);
    const role = await prisma.role.create({
      data: {
        name: req.body.name,
        description: req.body.description ?? null,
        permissions,
      },
    });
    await auditFromRequest(req, {
      action: 'PERMISSION_CHANGE',
      entityType: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      summary: `Created role "${role.name}" with ${permissions.length} permission(s)`,
      diff: { permissions: { from: [], to: permissions } },
    });
    return created(res, role);
  }),
);

rolesRouter.patch(
  '/:id',
  requirePermission('settings.roles.manage'),
  validateBody(roleBody.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Role');

    // The admin role implicitly holds everything; editing its permission list
    // would be misleading, and stripping it could lock the org out entirely.
    if (existing.isAdmin && req.body.permissions) {
      throw badRequest('The administrator role always holds every permission');
    }

    const permissions = req.body.permissions
      ? sanitizePermissions(req.body.permissions)
      : undefined;

    const role = await prisma.role.update({
      where: { id: req.params.id },
      data: {
        name: req.body.name,
        description: req.body.description,
        ...(permissions ? { permissions } : {}),
      },
    });

    await auditFromRequest(req, {
      action: 'PERMISSION_CHANGE',
      entityType: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      summary: `Updated role "${role.name}"`,
      diff:
        diffRecords(existing, {
          name: role.name,
          description: role.description,
          permissions: role.permissions,
        }) ?? undefined,
    });

    return ok(res, role);
  }),
);

rolesRouter.delete(
  '/:id',
  requirePermission('settings.roles.manage'),
  asyncHandler(async (req, res) => {
    const role = await prisma.role.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw notFound('Role');
    if (role.isSystem) throw badRequest('System roles cannot be deleted');
    if (role._count.users) {
      throw conflict(
        `${role._count.users} user(s) still have this role - reassign them first`,
      );
    }

    await prisma.role.delete({ where: { id: role.id } });
    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Role',
      entityId: role.id,
      entityLabel: role.name,
      summary: `Deleted role "${role.name}"`,
    });
    return noContent(res);
  }),
);
