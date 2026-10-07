import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hrSubjectWhere } from '../../lib/scope';
import { notify } from '../../lib/notify';

export const performanceRouter = Router();

// ---------------------------------------------------------------- review cycles
performanceRouter.get(
  '/cycles',
  requirePermission('performance.manage', 'performance.view.all', 'performance.view.team'),
  asyncHandler(async (_req, res) => {
    const cycles = await prisma.reviewCycle.findMany({
      orderBy: { periodStart: 'desc' },
      include: { _count: { select: { reviews: true } } },
    });
    return ok(res, cycles);
  }),
);

performanceRouter.post(
  '/cycles',
  requirePermission('performance.manage'),
  validateBody(
    z.object({
      name: z.string().trim().min(2).max(120),
      periodStart: z.coerce.date(),
      periodEnd: z.coerce.date(),
      dueDate: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { name: string; periodStart: Date; periodEnd: Date; dueDate?: Date | null };
    if (body.periodEnd <= body.periodStart) {
      throw badRequest('The period end must be after the start');
    }

    const cycle = await prisma.reviewCycle.create({ data: body });
    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'ReviewCycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      summary: `Created review cycle "${cycle.name}"`,
    });
    return created(res, cycle);
  }),
);

/**
 * Opening a cycle generates one review per active employee, each pre-assigned
 * to their reporting manager, and notifies everyone that self-review is open.
 */
performanceRouter.post(
  '/cycles/:id/open',
  requirePermission('performance.manage'),
  asyncHandler(async (req, res) => {
    const cycle = await prisma.reviewCycle.findUnique({ where: { id: req.params.id } });
    if (!cycle) throw notFound('Review cycle');
    if (cycle.status === 'CLOSED') throw badRequest('That cycle is closed');

    const employees = await prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_NOTICE'] } },
      select: { id: true, userId: true, reportingToId: true },
    });

    const result = await prisma.$transaction(async (tx) => {
      await tx.reviewCycle.update({ where: { id: cycle.id }, data: { status: 'OPEN' } });
      const createResult = await tx.performanceReview.createMany({
        data: employees.map((employee) => ({
          cycleId: cycle.id,
          employeeId: employee.id,
          reviewerId: employee.reportingToId,
        })),
        skipDuplicates: true,
      });
      return createResult.count;
    });

    await notify({
      userIds: employees.map((e) => e.userId),
      type: 'SYSTEM',
      title: `${cycle.name}: self-review is open`,
      body: cycle.dueDate ? `Please complete it by ${cycle.dueDate.toDateString()}.` : undefined,
      link: '/performance/my',
      email: true,
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'ReviewCycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      summary: `Opened review cycle "${cycle.name}" with ${result} review(s)`,
    });

    return ok(res, { reviewsCreated: result });
  }),
);

performanceRouter.post(
  '/cycles/:id/close',
  requirePermission('performance.manage'),
  asyncHandler(async (req, res) => {
    const cycle = await prisma.reviewCycle.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { reviews: { where: { status: { not: 'COMPLETED' } } } } } },
    });
    if (!cycle) throw notFound('Review cycle');
    if (cycle._count.reviews) {
      throw conflict(`${cycle._count.reviews} review(s) are still incomplete`);
    }

    await prisma.reviewCycle.update({ where: { id: cycle.id }, data: { status: 'CLOSED' } });
    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'ReviewCycle',
      entityId: cycle.id,
      entityLabel: cycle.name,
      summary: `Closed review cycle "${cycle.name}"`,
    });
    return ok(res, { closed: true });
  }),
);

// --------------------------------------------------------------------- reviews
performanceRouter.get(
  '/reviews',
  requirePermission('performance.view.all', 'performance.view.team', 'performance.view.own'),
  validate({
    query: paginationSchema.extend({
      cycleId: z.string().cuid().optional(),
      employeeId: z.string().cuid().optional(),
      status: z.enum(['PENDING_SELF', 'PENDING_MANAGER', 'COMPLETED']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      cycleId?: string;
      employeeId?: string;
      status?: 'PENDING_SELF' | 'PENDING_MANAGER' | 'COMPLETED';
    };
    const scope = hrSubjectWhere(req.ctx, {
      all: 'performance.view.all',
      team: 'performance.view.team',
    });

    const where = {
      ...scope,
      ...(q.cycleId ? { cycleId: q.cycleId } : {}),
      ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }, scope] } : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.performanceReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          cycle: { select: { id: true, name: true, status: true, dueDate: true } },
          employee: {
            select: {
              id: true,
              employeeCode: true,
              user: { select: { name: true, avatar: { select: { url: true } } } },
              designation: { select: { title: true } },
            },
          },
          reviewer: { select: { id: true, user: { select: { name: true } } } },
        },
        ...skipTake(q),
      }),
      prisma.performanceReview.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/** The caller's own reviews - no view permission needed beyond the baseline. */
performanceRouter.get(
  '/reviews/my',
  requirePermission('performance.view.own'),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) return ok(res, []);

    const reviews = await prisma.performanceReview.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      include: {
        cycle: true,
        reviewer: { select: { id: true, user: { select: { name: true } } } },
      },
    });
    return ok(res, reviews);
  }),
);

performanceRouter.get(
  '/reviews/:id',
  requirePermission('performance.view.own', 'performance.view.team', 'performance.view.all'),
  asyncHandler(async (req, res) => {
    const review = await prisma.performanceReview.findUnique({
      where: { id: req.params.id },
      include: {
        cycle: true,
        employee: {
          select: {
            id: true,
            reportingToId: true,
            user: { select: { name: true } },
            designation: { select: { title: true } },
          },
        },
        reviewer: { select: { id: true, user: { select: { name: true } } } },
      },
    });
    if (!review) throw notFound('Review');

    const isSubject = review.employeeId === req.ctx.employeeId;
    const isReviewer = review.reviewerId === req.ctx.employeeId;
    if (!isSubject && !isReviewer && !req.ctx.has('performance.view.all')) {
      if (!(req.ctx.has('performance.view.team') && review.employee.reportingToId === req.ctx.employeeId)) {
        throw forbidden();
      }
    }

    // Manager comments stay hidden from the subject until the review is done.
    const payload: Record<string, unknown> = { ...review };
    if (isSubject && review.status !== 'COMPLETED') {
      delete payload.managerComments;
      delete payload.managerRating;
    }

    return ok(res, payload);
  }),
);

/** Self-assessment, by the subject only. */
performanceRouter.post(
  '/reviews/:id/self',
  requirePermission('performance.view.own'),
  validateBody(
    z.object({
      selfRating: z.coerce.number().int().min(1).max(5),
      selfComments: z.string().trim().min(10).max(5000),
    }),
  ),
  asyncHandler(async (req, res) => {
    const review = await prisma.performanceReview.findUnique({
      where: { id: req.params.id },
      include: { cycle: { select: { status: true, name: true } }, reviewer: { select: { userId: true } } },
    });
    if (!review) throw notFound('Review');
    if (review.employeeId !== req.ctx.employeeId) {
      throw forbidden('This is not your review');
    }
    if (review.cycle.status !== 'OPEN') throw badRequest('That review cycle is not open');
    if (review.status !== 'PENDING_SELF') throw badRequest('You have already submitted this');

    const updated = await prisma.performanceReview.update({
      where: { id: review.id },
      data: {
        ...req.body,
        status: 'PENDING_MANAGER',
        submittedAt: new Date(),
      },
    });

    if (review.reviewer) {
      await notify({
        userIds: [review.reviewer.userId],
        type: 'SYSTEM',
        title: `A self-review is ready for your input`,
        body: review.cycle.name,
        link: `/performance/reviews/${review.id}`,
      });
    }

    return ok(res, updated);
  }),
);

/** Manager assessment; completing it is what reveals it to the subject. */
performanceRouter.post(
  '/reviews/:id/manager',
  requirePermission('performance.manage', 'performance.view.team'),
  validateBody(
    z.object({
      managerRating: z.coerce.number().int().min(1).max(5),
      managerComments: z.string().trim().min(10).max(5000),
      strengths: z.string().trim().max(2000).optional(),
      improvements: z.string().trim().max(2000).optional(),
      complete: z.boolean().default(true),
    }),
  ),
  asyncHandler(async (req, res) => {
    const review = await prisma.performanceReview.findUnique({
      where: { id: req.params.id },
      include: {
        cycle: { select: { status: true, name: true } },
        employee: { select: { userId: true, reportingToId: true } },
      },
    });
    if (!review) throw notFound('Review');
    if (review.employeeId === req.ctx.employeeId) {
      throw forbidden('You cannot write your own manager review');
    }
    if (
      review.reviewerId !== req.ctx.employeeId &&
      !req.ctx.has('performance.manage') &&
      review.employee.reportingToId !== req.ctx.employeeId
    ) {
      throw forbidden('You are not the reviewer for this employee');
    }
    if (review.cycle.status !== 'OPEN') throw badRequest('That review cycle is not open');

    const { complete, ...data } = req.body as {
      complete: boolean;
      managerRating: number;
      managerComments: string;
      strengths?: string;
      improvements?: string;
    };

    const updated = await prisma.performanceReview.update({
      where: { id: review.id },
      data: {
        ...data,
        reviewerId: review.reviewerId ?? req.ctx.employeeId,
        ...(complete ? { status: 'COMPLETED', completedAt: new Date() } : {}),
      },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'PerformanceReview',
      entityId: review.id,
      summary: `${complete ? 'Completed' : 'Saved'} a manager review for ${review.cycle.name}`,
    });

    if (complete) {
      await notify({
        userIds: [review.employee.userId],
        type: 'SYSTEM',
        title: 'Your performance review is ready',
        body: review.cycle.name,
        link: `/performance/reviews/${review.id}`,
        email: true,
      });
    }

    return ok(res, updated);
  }),
);

// ----------------------------------------------------------------------- goals
performanceRouter.get(
  '/goals',
  requirePermission('performance.view.own', 'performance.view.team', 'performance.view.all'),
  validate({
    query: paginationSchema.extend({
      employeeId: z.string().cuid().optional(),
      status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'MISSED']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      employeeId?: string;
      status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'ACHIEVED' | 'MISSED';
    };
    const scope = hrSubjectWhere(req.ctx, {
      all: 'performance.view.all',
      team: 'performance.view.team',
    });

    const where = {
      ...scope,
      ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }, scope] } : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.goal.findMany({
        where,
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
        include: {
          employee: {
            select: { id: true, user: { select: { name: true } } },
          },
        },
        ...skipTake(q),
      }),
      prisma.goal.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

performanceRouter.post(
  '/goals',
  requirePermission('performance.goals.manage', 'performance.view.own'),
  validateBody(
    z.object({
      employeeId: z.string().cuid().optional(),
      title: z.string().trim().min(2).max(200),
      description: z.string().trim().max(2000).optional(),
      metric: z.string().trim().max(200).optional(),
      target: z.string().trim().max(120).optional(),
      weight: z.coerce.number().int().min(0).max(100).default(0),
      dueDate: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { employeeId: requestedEmployeeId, ...goalData } = req.body as {
      employeeId?: string;
      title: string;
      description?: string;
      metric?: string;
      target?: string;
      weight: number;
      dueDate?: Date | null;
    };
    const employeeId = requestedEmployeeId ?? req.ctx.employeeId;
    if (!employeeId) throw badRequest('No employee to attach the goal to');

    // Setting goals for someone else is a separate right from setting your own.
    if (employeeId !== req.ctx.employeeId && !req.ctx.has('performance.goals.manage')) {
      throw forbidden('You can only set your own goals');
    }

    const goal = await prisma.goal.create({ data: { ...goalData, employeeId } });
    return created(res, goal);
  }),
);

performanceRouter.patch(
  '/goals/:id',
  requirePermission('performance.goals.manage', 'performance.view.own'),
  validateBody(
    z.object({
      title: z.string().trim().min(2).max(200).optional(),
      description: z.string().trim().max(2000).nullish(),
      metric: z.string().trim().max(200).nullish(),
      target: z.string().trim().max(120).nullish(),
      current: z.string().trim().max(120).nullish(),
      weight: z.coerce.number().int().min(0).max(100).optional(),
      status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'MISSED']).optional(),
      dueDate: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const goal = await prisma.goal.findUnique({ where: { id: req.params.id } });
    if (!goal) throw notFound('Goal');
    if (goal.employeeId !== req.ctx.employeeId && !req.ctx.has('performance.goals.manage')) {
      throw forbidden('You can only edit your own goals');
    }

    const updated = await prisma.goal.update({
      where: { id: goal.id },
      data: req.body as Record<string, never>,
    });
    return ok(res, updated);
  }),
);

performanceRouter.delete(
  '/goals/:id',
  requirePermission('performance.goals.manage'),
  asyncHandler(async (req, res) => {
    await prisma.goal.delete({ where: { id: req.params.id } });
    return noContent(res);
  }),
);
