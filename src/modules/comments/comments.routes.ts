import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { clientWhere, projectWhere, retainerWhere, taskWhere } from '../../lib/scope';
import { notify } from '../../lib/notify';
import type { AuthContext } from '../../types/express';

export const commentsRouter = Router();

const ENTITIES = ['TASK', 'PROJECT', 'CLIENT', 'LEAD', 'DELIVERABLE', 'RETAINER_CYCLE'] as const;
type Entity = (typeof ENTITIES)[number];

/**
 * Comments ride on the visibility of whatever they are attached to: if the
 * caller cannot read the parent record, they cannot read or post its comments.
 * Client-portal users additionally only ever see non-internal comments.
 */
async function assertCanSeeEntity(
  ctx: AuthContext,
  entityType: Entity,
  entityId: string,
): Promise<void> {
  const exists = await (async () => {
    switch (entityType) {
      case 'TASK':
        return prisma.task.count({ where: { AND: [taskWhere(ctx), { id: entityId }] } });
      case 'PROJECT':
        return prisma.project.count({ where: { AND: [projectWhere(ctx), { id: entityId }] } });
      case 'CLIENT':
        return prisma.client.count({ where: { AND: [clientWhere(ctx), { id: entityId }] } });
      case 'LEAD':
        if (!ctx.hasAny('leads.view.all', 'leads.view.own')) return 0;
        return prisma.lead.count({ where: { id: entityId, deletedAt: null } });
      case 'DELIVERABLE':
        return prisma.deliverable.count({
          where: {
            id: entityId,
            OR: [
              { project: projectWhere(ctx) },
              { retainerCycle: { retainer: retainerWhere(ctx) } },
            ],
          },
        });
      case 'RETAINER_CYCLE':
        return prisma.retainerCycle.count({
          where: { id: entityId, retainer: retainerWhere(ctx) },
        });
      default:
        return 0;
    }
  })();

  if (!exists) throw notFound('That record');
}

commentsRouter.use(requireAuth);

commentsRouter.get(
  '/',
  validate({
    query: z.object({
      entityType: z.enum(ENTITIES),
      entityId: z.string().cuid(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { entityType: Entity; entityId: string };
    await assertCanSeeEntity(req.ctx, q.entityType, q.entityId);

    const comments = await prisma.comment.findMany({
      where: {
        entityType: q.entityType,
        entityId: q.entityId,
        deletedAt: null,
        // The portal never sees internal chatter.
        ...(req.ctx.user.kind === 'CLIENT' ? { isInternal: false } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: {
        author: {
          select: { id: true, name: true, kind: true, avatar: { select: { url: true } } },
        },
      },
    });

    return ok(res, comments);
  }),
);

commentsRouter.post(
  '/',
  validateBody(
    z.object({
      entityType: z.enum(ENTITIES),
      entityId: z.string().cuid(),
      body: z.string().trim().min(1).max(8000),
      parentId: z.string().cuid().nullish(),
      mentions: z.array(z.string().cuid()).max(30).default([]),
      /** Staff may post client-visible comments; the portal never can post internal. */
      isInternal: z.boolean().default(true),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as {
      entityType: Entity;
      entityId: string;
      body: string;
      parentId?: string | null;
      mentions: string[];
      isInternal: boolean;
    };
    await assertCanSeeEntity(req.ctx, body.entityType, body.entityId);

    const isInternal = req.ctx.user.kind === 'CLIENT' ? false : body.isInternal;

    // A client must never be notified of, or reply into, an internal thread.
    if (body.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: body.parentId },
        select: { entityId: true, entityType: true, isInternal: true, authorId: true },
      });
      if (!parent || parent.entityId !== body.entityId) throw badRequest('Invalid parent comment');
      if (parent.isInternal && req.ctx.user.kind === 'CLIENT') throw forbidden();
    }

    const comment = await prisma.comment.create({
      data: {
        entityType: body.entityType,
        entityId: body.entityId,
        authorId: req.ctx.user.id,
        body: body.body,
        parentId: body.parentId ?? null,
        mentions: isInternal ? body.mentions : [],
        isInternal,
      },
      include: {
        author: { select: { id: true, name: true, kind: true, avatar: { select: { url: true } } } },
      },
    });

    // Mentions only ever reach staff accounts.
    if (comment.mentions.length) {
      const mentioned = await prisma.user.findMany({
        where: { id: { in: comment.mentions }, kind: 'STAFF', status: 'ACTIVE', deletedAt: null },
        select: { id: true },
      });
      await notify({
        userIds: mentioned.map((m) => m.id).filter((id) => id !== req.ctx.user.id),
        type: 'MENTION',
        title: `${req.ctx.user.name} mentioned you`,
        body: body.body.slice(0, 160),
        link:
          body.entityType === 'TASK'
            ? `/tasks/${body.entityId}`
            : body.entityType === 'PROJECT'
              ? `/projects/${body.entityId}`
              : undefined,
        entityType: body.entityType,
        entityId: body.entityId,
        email: true,
      });
    }

    // Task watchers hear about every comment on their task.
    if (body.entityType === 'TASK') {
      const watchers = await prisma.taskWatcher.findMany({
        where: { taskId: body.entityId, userId: { not: req.ctx.user.id } },
        select: { userId: true, user: { select: { kind: true } } },
      });
      await notify({
        userIds: watchers
          .filter((w) => !isInternal || w.user.kind === 'STAFF')
          .map((w) => w.userId)
          .filter((id) => !comment.mentions.includes(id)),
        type: 'COMMENT_REPLY',
        title: `New comment from ${req.ctx.user.name}`,
        body: body.body.slice(0, 160),
        link: `/tasks/${body.entityId}`,
        entityType: 'TASK',
        entityId: body.entityId,
      });
    }

    return created(res, comment);
  }),
);

commentsRouter.patch(
  '/:id',
  validateBody(z.object({ body: z.string().trim().min(1).max(8000) })),
  asyncHandler(async (req, res) => {
    const comment = await prisma.comment.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!comment) throw notFound('Comment');
    if (comment.authorId !== req.ctx.user.id) {
      throw forbidden('You can only edit your own comments');
    }

    const updated = await prisma.comment.update({
      where: { id: comment.id },
      data: { body: req.body.body, editedAt: new Date() },
    });
    return ok(res, updated);
  }),
);

commentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const comment = await prisma.comment.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, authorId: true },
    });
    if (!comment) throw notFound('Comment');
    // Authors delete their own; admins can remove anything.
    if (comment.authorId !== req.ctx.user.id && !req.ctx.user.isAdmin) {
      throw forbidden('You can only delete your own comments');
    }

    await prisma.comment.update({
      where: { id: comment.id },
      data: { deletedAt: new Date() },
    });
    return noContent(res);
  }),
);
