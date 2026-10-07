import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { projectWhere, retainerWhere } from '../../lib/scope';
import { notify } from '../../lib/notify';

export const deliverablesRouter = Router();

const STATUSES = [
  'DRAFT',
  'INTERNAL_REVIEW',
  'CLIENT_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHED',
] as const;

const deliverableBody = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  projectId: z.string().cuid().nullish(),
  retainerCycleId: z.string().cuid().nullish(),
  dueDate: z.coerce.date().nullish(),
});

const listQuery = paginationSchema.extend({
  projectId: z.string().cuid().optional(),
  retainerCycleId: z.string().cuid().optional(),
  status: z.enum(STATUSES).optional(),
  /** Only those sitting with the client. */
  awaitingClient: z.coerce.boolean().optional(),
});

const deliverableInclude = {
  project: {
    select: { id: true, code: true, name: true, client: { select: { id: true, name: true } } },
  },
  retainerCycle: {
    select: {
      id: true,
      label: true,
      retainer: { select: { id: true, name: true, client: { select: { id: true, name: true } } } },
    },
  },
  versions: {
    orderBy: { versionNumber: 'desc' as const },
    include: {
      files: {
        where: { deletedAt: null },
        select: { id: true, originalName: true, url: true, mimeType: true, sizeBytes: true },
      },
    },
  },
  approvals: {
    orderBy: { requestedAt: 'desc' as const },
    include: { decidedBy: { select: { id: true, name: true, kind: true } } },
  },
} as const;

/**
 * A deliverable is reachable only through a project or retainer the caller can
 * already see, so visibility rides on the existing project/retainer scoping.
 */
function reachableWhere(ctx: Parameters<typeof projectWhere>[0]) {
  return {
    OR: [{ project: projectWhere(ctx) }, { retainerCycle: { retainer: retainerWhere(ctx) } }],
  };
}

deliverablesRouter.get(
  '/',
  requirePermission('deliverables.view'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...reachableWhere(req.ctx),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.retainerCycleId ? { retainerCycleId: q.retainerCycleId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.awaitingClient ? { status: 'CLIENT_REVIEW' as const } : {}),
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.deliverable.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: deliverableInclude,
        ...skipTake(q),
      }),
      prisma.deliverable.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

deliverablesRouter.get(
  '/:id',
  requirePermission('deliverables.view'),
  asyncHandler(async (req, res) => {
    const deliverable = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
      include: deliverableInclude,
    });
    if (!deliverable) throw notFound('Deliverable');
    return ok(res, deliverable);
  }),
);

deliverablesRouter.post(
  '/',
  requirePermission('deliverables.manage'),
  validateBody(deliverableBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof deliverableBody>;
    if (!!body.projectId === !!body.retainerCycleId) {
      throw badRequest('A deliverable belongs to exactly one of a project or a retainer cycle');
    }

    const deliverable = await prisma.deliverable.create({
      data: { ...body, createdById: req.ctx.user.id },
      include: deliverableInclude,
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Created deliverable "${deliverable.title}"`,
    });

    return created(res, deliverable);
  }),
);

deliverablesRouter.patch(
  '/:id',
  requirePermission('deliverables.manage'),
  validateBody(deliverableBody.partial().omit({ projectId: true, retainerCycleId: true })),
  asyncHandler(async (req, res) => {
    const before = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
    });
    if (!before) throw notFound('Deliverable');

    const deliverable = await prisma.deliverable.update({
      where: { id: before.id },
      data: req.body as Partial<z.infer<typeof deliverableBody>>,
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Updated deliverable "${deliverable.title}"`,
      diff: diffRecords(before, req.body as Record<string, unknown>) ?? undefined,
    });

    return ok(res, deliverable);
  }),
);

/**
 * Adds a version. Files are uploaded separately and attached by id, which keeps
 * this endpoint JSON and lets a version carry several assets.
 */
deliverablesRouter.post(
  '/:id/versions',
  requirePermission('deliverables.version.upload'),
  validateBody(
    z.object({
      notes: z.string().trim().max(2000).optional(),
      fileIds: z.array(z.string().cuid()).min(1, 'Attach at least one file').max(50),
    }),
  ),
  asyncHandler(async (req, res) => {
    const deliverable = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!deliverable) throw notFound('Deliverable');

    const fileIds = req.body.fileIds as string[];
    const files = await prisma.fileObject.findMany({
      where: { id: { in: fileIds }, deletedAt: null },
      select: { id: true },
    });
    if (files.length !== fileIds.length) throw badRequest('One or more files were not found');

    const nextNumber = (deliverable.versions[0]?.versionNumber ?? 0) + 1;

    const version = await prisma.$transaction(async (tx) => {
      const createdVersion = await tx.deliverableVersion.create({
        data: {
          deliverableId: deliverable.id,
          versionNumber: nextNumber,
          notes: req.body.notes ?? null,
          submittedById: req.ctx.user.id,
        },
      });
      await tx.fileObject.updateMany({
        where: { id: { in: fileIds } },
        data: { deliverableVersionId: createdVersion.id },
      });
      // A new version always resets the review state.
      await tx.deliverable.update({
        where: { id: deliverable.id },
        data: { status: 'INTERNAL_REVIEW', approvedAt: null },
      });
      return createdVersion;
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Uploaded version ${nextNumber} of "${deliverable.title}"`,
    });

    return created(res, version);
  }),
);

/** Internal sign-off before anything reaches the client. */
deliverablesRouter.post(
  '/:id/internal-approval',
  requirePermission('deliverables.approve.internal'),
  validateBody(
    z.object({
      decision: z.enum(['APPROVED', 'CHANGES_REQUESTED']),
      comment: z.string().trim().max(2000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const deliverable = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!deliverable) throw notFound('Deliverable');
    const version = deliverable.versions[0];
    if (!version) throw badRequest('Upload a version before reviewing it');

    const approved = req.body.decision === 'APPROVED';

    await prisma.$transaction(async (tx) => {
      await tx.approval.create({
        data: {
          deliverableId: deliverable.id,
          versionId: version.id,
          stage: 'INTERNAL',
          decision: req.body.decision,
          decidedById: req.ctx.user.id,
          decidedAt: new Date(),
          comment: req.body.comment ?? null,
        },
      });
      await tx.deliverable.update({
        where: { id: deliverable.id },
        data: { status: approved ? 'APPROVED' : 'CHANGES_REQUESTED' },
      });
    });

    await auditFromRequest(req, {
      action: approved ? 'APPROVE' : 'REJECT',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `${approved ? 'Internally approved' : 'Requested changes on'} "${deliverable.title}" v${version.versionNumber}`,
    });

    return ok(res, { decision: req.body.decision });
  }),
);

/** Sends the current version to the client contacts who may approve. */
deliverablesRouter.post(
  '/:id/request-client-approval',
  requirePermission('deliverables.request.client'),
  validateBody(z.object({ message: z.string().trim().max(2000).optional() })),
  asyncHandler(async (req, res) => {
    const deliverable = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
      include: {
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
        project: { select: { clientId: true, name: true } },
        retainerCycle: { select: { retainer: { select: { clientId: true, name: true } } } },
      },
    });
    if (!deliverable) throw notFound('Deliverable');
    const version = deliverable.versions[0];
    if (!version) throw badRequest('Upload a version first');

    const clientId =
      deliverable.project?.clientId ?? deliverable.retainerCycle?.retainer.clientId;
    if (!clientId) throw badRequest('This deliverable is not linked to a client');

    await prisma.$transaction(async (tx) => {
      await tx.approval.create({
        data: {
          deliverableId: deliverable.id,
          versionId: version.id,
          stage: 'CLIENT',
          decision: 'PENDING',
          comment: req.body.message ?? null,
        },
      });
      await tx.deliverable.update({
        where: { id: deliverable.id },
        data: { status: 'CLIENT_REVIEW' },
      });
    });

    const approvers = await prisma.clientContact.findMany({
      where: { clientId, portalEnabled: true, canApprove: true, userId: { not: null } },
      select: { userId: true },
    });

    await notify({
      userIds: approvers.map((a) => a.userId as string),
      type: 'APPROVAL_REQUESTED',
      title: `Approval needed: ${deliverable.title}`,
      body: req.body.message ?? 'A new deliverable is ready for your review.',
      link: `/portal/approvals/${deliverable.id}`,
      entityType: 'Deliverable',
      entityId: deliverable.id,
      email: true,
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Sent "${deliverable.title}" v${version.versionNumber} to the client for approval`,
    });

    return ok(res, { sentTo: approvers.length });
  }),
);

deliverablesRouter.post(
  '/:id/publish',
  requirePermission('deliverables.publish'),
  asyncHandler(async (req, res) => {
    const deliverable = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
    });
    if (!deliverable) throw notFound('Deliverable');
    if (deliverable.status !== 'APPROVED') {
      throw badRequest('Only an approved deliverable can be published');
    }

    const updated = await prisma.deliverable.update({
      where: { id: deliverable.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Published "${deliverable.title}"`,
    });

    return ok(res, updated);
  }),
);

deliverablesRouter.delete(
  '/:id',
  requirePermission('deliverables.manage'),
  asyncHandler(async (req, res) => {
    const deliverable = await prisma.deliverable.findFirst({
      where: { AND: [reachableWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, title: true, status: true },
    });
    if (!deliverable) throw notFound('Deliverable');
    if (deliverable.status === 'PUBLISHED') {
      throw badRequest('A published deliverable cannot be deleted');
    }

    await prisma.deliverable.delete({ where: { id: deliverable.id } });
    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Deliverable',
      entityId: deliverable.id,
      entityLabel: deliverable.title,
      summary: `Deleted deliverable "${deliverable.title}"`,
    });
    return noContent(res);
  }),
);
