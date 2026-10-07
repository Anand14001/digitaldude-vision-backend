import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, noContent, ok, paged } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

/** Notifications are personal, so no permission applies - only ownership. */
notificationsRouter.get(
  '/',
  validate({ query: paginationSchema.extend({ unreadOnly: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      unreadOnly?: boolean;
    };
    const where = {
      userId: req.ctx.user.id,
      ...(q.unreadOnly ? { readAt: null } : {}),
    };

    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.ctx.user.id, readAt: null } }),
    ]);

    return res.json({ data: items, meta: { ...pageMeta(q, total), unread } });
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const unread = await prisma.notification.count({
      where: { userId: req.ctx.user.id, readAt: null },
    });
    return ok(res, { unread });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.ctx.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return noContent(res);
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { userId: req.ctx.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return ok(res, { marked: result.count });
  }),
);

notificationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.ctx.user.id },
    });
    return noContent(res);
  }),
);
