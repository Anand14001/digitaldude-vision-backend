import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { orderByFrom, pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { retainerWhere } from '../../lib/scope';
import { nextSequence } from '../../lib/sequence';
import { cyclePeriod, dayjs } from '../../lib/dates';
import { firstStageOf, seedStageTasks } from '../../lib/workflowRuntime';

export const retainersRouter = Router();

const SORTABLE = ['createdAt', 'name', 'startDate', 'endDate', 'status'] as const;
const CYCLES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL'] as const;

const retainerBody = z.object({
  name: z.string().trim().min(2).max(160),
  clientId: z.string().cuid(),
  serviceLineId: z.string().cuid().nullish(),
  projectTypeId: z.string().cuid().nullish(),
  workflowId: z.string().cuid(),
  managerId: z.string().cuid().nullish(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).default('ACTIVE'),
  billingCycle: z.enum(CYCLES).default('MONTHLY'),
  amountPerCycle: z.coerce.number().min(0).max(1_000_000_000).nullish(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullish(),
  cycleStartDay: z.coerce.number().int().min(1).max(28).default(1),
  autoGenerateCycles: z.boolean().default(true),
  scopeNotes: z.string().trim().max(4000).optional(),
  /** Open the first cycle immediately. */
  openFirstCycle: z.boolean().default(true),
});

const listQuery = paginationSchema.extend({
  status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(),
  clientId: z.string().cuid().optional(),
  managerId: z.string().cuid().optional(),
  /** Retainers ending within this many days - the renewals view. */
  renewalWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * Opens a cycle for a retainer, seeding the first stage's checklist. Shared by
 * the create endpoint, the manual "open next cycle" action and the nightly job.
 */
export async function openCycle(opts: {
  retainerId: string;
  periodStart?: Date;
  actorUserId?: string | null;
}): Promise<{ id: string; label: string } | null> {
  return prisma.$transaction(async (tx) => {
    const retainer = await tx.retainer.findFirst({
      where: { id: opts.retainerId, deletedAt: null },
      include: { cycles: { orderBy: { periodStart: 'desc' }, take: 1 } },
    });
    if (!retainer) throw notFound('Retainer');
    if (retainer.status !== 'ACTIVE') {
      throw badRequest('Only an active retainer can open a new cycle');
    }

    const last = retainer.cycles[0];
    const start =
      opts.periodStart ??
      (last
        ? dayjs(last.periodEnd).add(1, 'day').startOf('day').toDate()
        : dayjs(retainer.startDate).startOf('day').toDate());

    if (retainer.endDate && start > retainer.endDate) return null;

    const { periodStart, periodEnd, label } = cyclePeriod(start, retainer.billingCycle);

    const existing = await tx.retainerCycle.findFirst({
      where: { retainerId: retainer.id, periodStart },
      select: { id: true, label: true },
    });
    if (existing) return existing;

    const stage = await firstStageOf(retainer.workflowId, tx);

    const cycle = await tx.retainerCycle.create({
      data: {
        retainerId: retainer.id,
        label,
        periodStart,
        periodEnd,
        status: periodStart <= new Date() ? 'IN_PROGRESS' : 'UPCOMING',
        currentStageId: stage?.id ?? null,
      },
    });

    if (stage) {
      await seedStageTasks({
        tx,
        stageId: stage.id,
        workflowId: retainer.workflowId,
        retainerCycleId: cycle.id,
        anchorDate: periodStart,
        createdById: opts.actorUserId ?? null,
      });
    }

    return { id: cycle.id, label: cycle.label };
  });
}

// -------------------------------------------------------------------- listing
retainersRouter.get(
  '/',
  requirePermission('retainers.view.all', 'retainers.view.assigned'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...retainerWhere(req.ctx),
      ...(q.status ? { status: q.status } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.managerId ? { managerId: q.managerId } : {}),
      ...(q.renewalWithinDays
        ? {
            status: 'ACTIVE' as const,
            endDate: {
              not: null,
              lte: dayjs().add(q.renewalWithinDays, 'day').toDate(),
              gte: new Date(),
            },
          }
        : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { code: { contains: q.q, mode: 'insensitive' as const } },
              { client: { name: { contains: q.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.retainer.findMany({
        where,
        orderBy: orderByFrom(q.sort, q.order, SORTABLE, 'createdAt'),
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          billingCycle: true,
          amountPerCycle: req.ctx.has('reports.financial.view'),
          startDate: true,
          endDate: true,
          client: { select: { id: true, name: true } },
          serviceLine: { select: { id: true, name: true } },
          cycles: {
            orderBy: { periodStart: 'desc' },
            take: 1,
            select: { id: true, label: true, status: true, periodStart: true, periodEnd: true },
          },
          _count: { select: { cycles: true } },
        },
        ...skipTake(q),
      }),
      prisma.retainer.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

retainersRouter.get(
  '/:id',
  requirePermission('retainers.view.all', 'retainers.view.assigned'),
  asyncHandler(async (req, res) => {
    const retainer = await prisma.retainer.findFirst({
      where: { AND: [retainerWhere(req.ctx), { id: req.params.id }] },
      include: {
        client: { select: { id: true, name: true, logo: { select: { url: true } } } },
        serviceLine: { select: { id: true, name: true } },
        workflow: {
          include: {
            stages: { orderBy: { sortOrder: 'asc' } },
            taskStatuses: { orderBy: { sortOrder: 'asc' } },
          },
        },
        cycles: {
          orderBy: { periodStart: 'desc' },
          include: {
            currentStage: { select: { id: true, name: true, color: true } },
            _count: { select: { tasks: true, deliverables: true } },
          },
        },
      },
    });
    if (!retainer) throw notFound('Retainer');

    const payload: Record<string, unknown> = { ...retainer };
    if (!req.ctx.has('reports.financial.view')) delete payload.amountPerCycle;

    return ok(res, payload);
  }),
);

retainersRouter.post(
  '/',
  requirePermission('retainers.create'),
  validateBody(retainerBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof retainerBody>;

    const [client, workflow] = await Promise.all([
      prisma.client.findFirst({
        where: { id: body.clientId, deletedAt: null },
        select: { id: true, name: true },
      }),
      prisma.workflowTemplate.findUnique({
        where: { id: body.workflowId },
        select: { id: true, isArchived: true },
      }),
    ]);
    if (!client) throw badRequest('That client does not exist');
    if (!workflow || workflow.isArchived) throw badRequest('That workflow is not usable');
    if (body.endDate && body.endDate <= body.startDate) {
      throw badRequest('The end date must be after the start date');
    }

    const retainer = await prisma.$transaction(async (tx) => {
      const code = await nextSequence('retainer', 'RET', tx);
      const { openFirstCycle: _ignored, ...data } = body;
      return tx.retainer.create({ data: { ...data, code } });
    });

    if (body.openFirstCycle) {
      await openCycle({ retainerId: retainer.id, actorUserId: req.ctx.user.id });
    }

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Retainer',
      entityId: retainer.id,
      entityLabel: `${retainer.code} ${retainer.name}`,
      summary: `Created ${retainer.billingCycle.toLowerCase()} retainer ${retainer.code} for ${client.name}`,
    });

    const full = await prisma.retainer.findUnique({
      where: { id: retainer.id },
      include: { cycles: true },
    });
    return created(res, full);
  }),
);

retainersRouter.patch(
  '/:id',
  requirePermission('retainers.update'),
  validateBody(retainerBody.partial().omit({ openFirstCycle: true, workflowId: true })),
  asyncHandler(async (req, res) => {
    const before = await prisma.retainer.findFirst({
      where: { AND: [retainerWhere(req.ctx), { id: req.params.id }] },
    });
    if (!before) throw notFound('Retainer');

    const data = req.body as Partial<Omit<z.infer<typeof retainerBody>, 'openFirstCycle' | 'workflowId'>>;
    const retainer = await prisma.retainer.update({ where: { id: before.id }, data });

    await auditFromRequest(req, {
      action: data.status && data.status !== before.status ? 'STATUS_CHANGE' : 'UPDATE',
      entityType: 'Retainer',
      entityId: retainer.id,
      entityLabel: `${retainer.code} ${retainer.name}`,
      summary: `Updated retainer ${retainer.code}`,
      diff: diffRecords(before, data as Record<string, unknown>) ?? undefined,
    });

    return ok(res, retainer);
  }),
);

/** Opens the next cycle by hand, for when auto-generation is off. */
retainersRouter.post(
  '/:id/cycles',
  requirePermission('retainers.cycles.manage'),
  validateBody(z.object({ periodStart: z.coerce.date().optional() })),
  asyncHandler(async (req, res) => {
    const retainer = await prisma.retainer.findFirst({
      where: { AND: [retainerWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, code: true, name: true },
    });
    if (!retainer) throw notFound('Retainer');

    const cycle = await openCycle({
      retainerId: retainer.id,
      periodStart: req.body.periodStart,
      actorUserId: req.ctx.user.id,
    });
    if (!cycle) throw badRequest('This retainer has reached its end date');

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'RetainerCycle',
      entityId: cycle.id,
      entityLabel: cycle.label,
      summary: `Opened cycle ${cycle.label} on retainer ${retainer.code}`,
    });

    return created(res, cycle);
  }),
);

retainersRouter.get(
  '/cycles/:cycleId',
  requirePermission('retainers.view.all', 'retainers.view.assigned'),
  asyncHandler(async (req, res) => {
    const cycle = await prisma.retainerCycle.findFirst({
      where: {
        id: req.params.cycleId,
        retainer: retainerWhere(req.ctx),
      },
      include: {
        retainer: {
          include: {
            client: { select: { id: true, name: true } },
            workflow: {
              include: {
                stages: { orderBy: { sortOrder: 'asc' } },
                taskStatuses: { orderBy: { sortOrder: 'asc' } },
              },
            },
          },
        },
        currentStage: true,
        deliverables: {
          include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
        },
      },
    });
    if (!cycle) throw notFound('Cycle');
    return ok(res, cycle);
  }),
);

retainersRouter.patch(
  '/cycles/:cycleId',
  requirePermission('retainers.cycles.manage'),
  validateBody(
    z.object({
      status: z.enum(['UPCOMING', 'IN_PROGRESS', 'DELIVERED', 'CLOSED']).optional(),
      currentStageId: z.string().cuid().nullish(),
      notes: z.string().trim().max(4000).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const before = await prisma.retainerCycle.findFirst({
      where: { id: req.params.cycleId, retainer: retainerWhere(req.ctx) },
      include: { retainer: { select: { workflowId: true, code: true } } },
    });
    if (!before) throw notFound('Cycle');

    if (req.body.currentStageId) {
      const stage = await prisma.workflowStage.findFirst({
        where: { id: req.body.currentStageId, workflowId: before.retainer.workflowId },
      });
      if (!stage) throw badRequest('That stage does not belong to this retainer’s workflow');
    }

    if (req.body.status === 'CLOSED') {
      const open = await prisma.task.count({
        where: {
          retainerCycleId: before.id,
          deletedAt: null,
          completedAt: null,
          status: { category: { notIn: ['DONE', 'CANCELLED'] } },
        },
      });
      if (open) throw conflict(`${open} task(s) in this cycle are still open`);
    }

    const cycle = await prisma.retainerCycle.update({
      where: { id: before.id },
      data: {
        ...req.body,
        ...(req.body.status === 'DELIVERED' && !before.deliveredAt
          ? { deliveredAt: new Date() }
          : {}),
      },
    });

    await auditFromRequest(req, {
      action: req.body.status ? 'STATUS_CHANGE' : 'UPDATE',
      entityType: 'RetainerCycle',
      entityId: cycle.id,
      entityLabel: cycle.label,
      summary: `Updated cycle ${cycle.label} on ${before.retainer.code}`,
      diff: diffRecords(before, req.body as Record<string, unknown>) ?? undefined,
    });

    return ok(res, cycle);
  }),
);

retainersRouter.delete(
  '/:id',
  requirePermission('retainers.delete'),
  asyncHandler(async (req, res) => {
    const retainer = await prisma.retainer.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!retainer) throw notFound('Retainer');
    if (retainer.status === 'ACTIVE') {
      throw conflict('End this retainer before archiving it');
    }

    await prisma.retainer.update({
      where: { id: retainer.id },
      data: { deletedAt: new Date() },
    });

    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Retainer',
      entityId: retainer.id,
      entityLabel: `${retainer.code} ${retainer.name}`,
      summary: `Archived retainer ${retainer.code}`,
    });

    return noContent(res);
  }),
);
