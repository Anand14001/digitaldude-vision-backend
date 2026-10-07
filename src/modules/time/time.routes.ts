import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hrSubjectWhere } from '../../lib/scope';
import { dayjs, weekEnd, weekStart } from '../../lib/dates';
import { notify } from '../../lib/notify';

export const timeRouter = Router();

const MAX_HOURS_PER_DAY = 16;

const entryBody = z.object({
  taskId: z.string().cuid().nullish(),
  projectId: z.string().cuid().nullish(),
  workDate: z.coerce.date(),
  hours: z.coerce.number().min(0.25).max(MAX_HOURS_PER_DAY),
  billable: z.boolean().default(true),
  note: z.string().trim().max(500).optional(),
  /** Admins and managers may log on someone else's behalf. */
  employeeId: z.string().cuid().optional(),
});

const listQuery = paginationSchema.extend({
  employeeId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  taskId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  billable: z.coerce.boolean().optional(),
});

/** The week a date belongs to, as a Monday-Sunday pair. */
const weekOf = (date: Date) => ({ start: weekStart(date), end: weekEnd(date) });

/**
 * Finds or opens the employee's timesheet for that week. Entries always hang
 * off a timesheet so approval has something to act on.
 */
async function timesheetFor(employeeId: string, date: Date, tx: Prisma.TransactionClient) {
  const { start, end } = weekOf(date);
  const existing = await tx.timesheet.findUnique({
    where: { employeeId_weekStart: { employeeId, weekStart: start } },
  });
  if (existing) return existing;
  return tx.timesheet.create({
    data: { employeeId, weekStart: start, weekEnd: end },
  });
}

// ---------------------------------------------------------------- time entries
timeRouter.get(
  '/entries',
  requirePermission('timesheets.log.own', 'timesheets.view.all', 'timesheets.view.team'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const scope = hrSubjectWhere(req.ctx, {
      all: 'timesheets.view.all',
      team: 'timesheets.view.team',
    });

    const where = {
      ...scope,
      ...(q.employeeId
        ? // An explicit employee filter must still sit inside the caller's scope.
          { AND: [{ employeeId: q.employeeId }, scope] }
        : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.taskId ? { taskId: q.taskId } : {}),
      ...(q.billable !== undefined ? { billable: q.billable } : {}),
      ...(q.from || q.to
        ? {
            workDate: {
              ...(q.from ? { gte: q.from } : {}),
              ...(q.to ? { lte: q.to } : {}),
            },
          }
        : {}),
    };

    const [items, total, totals] = await Promise.all([
      prisma.timeEntry.findMany({
        where,
        orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          employee: { select: { id: true, user: { select: { name: true } } } },
          task: { select: { id: true, reference: true, title: true } },
          project: { select: { id: true, code: true, name: true, client: { select: { name: true } } } },
          timesheet: { select: { id: true, status: true } },
        },
        ...skipTake(q),
      }),
      prisma.timeEntry.count({ where }),
      prisma.timeEntry.aggregate({ where, _sum: { hours: true } }),
    ]);

    return res.json({
      data: items,
      meta: { ...pageMeta(q, total), totalHours: Number(totals._sum.hours ?? 0) },
    });
  }),
);

timeRouter.post(
  '/entries',
  requirePermission('timesheets.log.own'),
  validateBody(entryBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof entryBody>;

    const employeeId = body.employeeId ?? req.ctx.employeeId;
    if (!employeeId) throw badRequest('Only employees can log time');
    if (employeeId !== req.ctx.employeeId && !req.ctx.has('timesheets.edit.others')) {
      throw forbidden('You can only log your own time');
    }
    if (!body.taskId && !body.projectId) {
      throw badRequest('Attach the time to a task or at least a project');
    }
    if (dayjs(body.workDate).isAfter(dayjs().endOf('day'))) {
      throw badRequest('Time cannot be logged against a future date');
    }

    // Derive the project from the task so reports stay consistent.
    let projectId = body.projectId ?? null;
    if (body.taskId) {
      const task = await prisma.task.findFirst({
        where: { id: body.taskId, deletedAt: null },
        select: { projectId: true },
      });
      if (!task) throw badRequest('That task does not exist');
      projectId = task.projectId ?? projectId;
    }

    const entry = await prisma.$transaction(async (tx) => {
      const timesheet = await timesheetFor(employeeId, body.workDate, tx);
      if (timesheet.status === 'APPROVED') {
        throw conflict('That week has already been approved - ask for it to be reopened');
      }

      const dayTotal = await tx.timeEntry.aggregate({
        where: { employeeId, workDate: body.workDate },
        _sum: { hours: true },
      });
      if (Number(dayTotal._sum.hours ?? 0) + body.hours > MAX_HOURS_PER_DAY) {
        throw badRequest(`That would take the day past ${MAX_HOURS_PER_DAY} hours`);
      }

      return tx.timeEntry.create({
        data: {
          employeeId,
          taskId: body.taskId ?? null,
          projectId,
          timesheetId: timesheet.id,
          workDate: body.workDate,
          hours: body.hours,
          billable: body.billable,
          note: body.note ?? null,
        },
      });
    });

    return created(res, entry);
  }),
);

timeRouter.patch(
  '/entries/:id',
  requirePermission('timesheets.log.own'),
  validateBody(entryBody.partial().omit({ employeeId: true })),
  asyncHandler(async (req, res) => {
    const entry = await prisma.timeEntry.findUnique({
      where: { id: req.params.id },
      include: { timesheet: { select: { status: true } } },
    });
    if (!entry) throw notFound('Time entry');
    if (entry.employeeId !== req.ctx.employeeId && !req.ctx.has('timesheets.edit.others')) {
      throw forbidden('You can only edit your own time');
    }
    if (entry.timesheet?.status === 'APPROVED' && !req.ctx.has('timesheets.edit.others')) {
      throw conflict('That week has been approved and is locked');
    }

    const updated = await prisma.timeEntry.update({
      where: { id: entry.id },
      data: req.body as Record<string, never>,
    });
    return ok(res, updated);
  }),
);

timeRouter.delete(
  '/entries/:id',
  requirePermission('timesheets.log.own'),
  asyncHandler(async (req, res) => {
    const entry = await prisma.timeEntry.findUnique({
      where: { id: req.params.id },
      include: { timesheet: { select: { status: true } } },
    });
    if (!entry) throw notFound('Time entry');
    if (entry.employeeId !== req.ctx.employeeId && !req.ctx.has('timesheets.edit.others')) {
      throw forbidden('You can only delete your own time');
    }
    if (entry.timesheet?.status === 'APPROVED') {
      throw conflict('That week has been approved and is locked');
    }
    await prisma.timeEntry.delete({ where: { id: entry.id } });
    return noContent(res);
  }),
);

// ------------------------------------------------------------------ timesheets
/** The caller's own week, used by the weekly timesheet grid. */
timeRouter.get(
  '/timesheets/my',
  requirePermission('timesheets.log.own'),
  validate({ query: z.object({ weekStart: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw badRequest('Only employees have timesheets');

    const { start, end } = weekOf((req.query as { weekStart?: Date }).weekStart ?? new Date());

    const timesheet = await prisma.timesheet.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: start } },
      include: {
        entries: {
          orderBy: { workDate: 'asc' },
          include: {
            task: { select: { id: true, reference: true, title: true } },
            project: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    return ok(res, {
      weekStart: start,
      weekEnd: end,
      timesheet,
      totalHours: timesheet
        ? timesheet.entries.reduce((sum, e) => sum + Number(e.hours), 0)
        : 0,
    });
  }),
);

timeRouter.get(
  '/timesheets',
  requirePermission('timesheets.view.all', 'timesheets.view.team', 'timesheets.approve'),
  validate({
    query: paginationSchema.extend({
      status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
      employeeId: z.string().cuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
      employeeId?: string;
    };
    const scope = hrSubjectWhere(req.ctx, {
      all: 'timesheets.view.all',
      team: 'timesheets.view.team',
    });

    const where = {
      ...scope,
      ...(q.status ? { status: q.status } : {}),
      ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }, scope] } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.timesheet.findMany({
        where,
        orderBy: [{ weekStart: 'desc' }],
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              user: { select: { name: true } },
              reportingTo: { select: { id: true } },
            },
          },
          entries: { select: { hours: true, billable: true } },
        },
        ...skipTake(q),
      }),
      prisma.timesheet.count({ where }),
    ]);

    const rows = items.map((sheet) => ({
      ...sheet,
      entries: undefined,
      totalHours: sheet.entries.reduce((sum, e) => sum + Number(e.hours), 0),
      billableHours: sheet.entries
        .filter((e) => e.billable)
        .reduce((sum, e) => sum + Number(e.hours), 0),
    }));

    return paged(res, rows, pageMeta(q, total));
  }),
);

timeRouter.post(
  '/timesheets/submit',
  requirePermission('timesheets.log.own'),
  validateBody(z.object({ weekStart: z.coerce.date() })),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw badRequest('Only employees have timesheets');

    const { start } = weekOf(req.body.weekStart);
    const timesheet = await prisma.timesheet.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart: start } },
      include: { entries: { select: { hours: true } }, employee: { select: { reportingToId: true, user: { select: { name: true } } } } },
    });
    if (!timesheet) throw badRequest('There is nothing logged for that week');
    if (!timesheet.entries.length) throw badRequest('Log some time before submitting');
    if (timesheet.status === 'SUBMITTED' || timesheet.status === 'APPROVED') {
      throw conflict('That week has already been submitted');
    }

    const updated = await prisma.timesheet.update({
      where: { id: timesheet.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(), rejectReason: null },
    });

    if (timesheet.employee.reportingToId) {
      const manager = await prisma.employee.findUnique({
        where: { id: timesheet.employee.reportingToId },
        select: { userId: true },
      });
      if (manager) {
        await notify({
          userIds: [manager.userId],
          type: 'TIMESHEET_SUBMITTED',
          title: `${timesheet.employee.user.name} submitted a timesheet`,
          body: `Week of ${dayjs(start).format('DD MMM YYYY')} - ${timesheet.entries.reduce((s, e) => s + Number(e.hours), 0)} hours`,
          link: `/timesheets/${timesheet.id}`,
          entityType: 'Timesheet',
          entityId: timesheet.id,
        });
      }
    }

    return ok(res, updated);
  }),
);

timeRouter.post(
  '/timesheets/:id/decision',
  requirePermission('timesheets.approve'),
  validateBody(
    z.object({
      decision: z.enum(['APPROVED', 'REJECTED']),
      reason: z.string().trim().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const timesheet = await prisma.timesheet.findUnique({
      where: { id: req.params.id },
      include: {
        employee: {
          select: { id: true, userId: true, reportingToId: true, user: { select: { name: true } } },
        },
      },
    });
    if (!timesheet) throw notFound('Timesheet');
    if (timesheet.status !== 'SUBMITTED') {
      throw badRequest('Only a submitted timesheet can be approved or rejected');
    }
    if (timesheet.employee.id === req.ctx.employeeId) {
      throw forbidden('You cannot approve your own timesheet');
    }
    if (
      !req.ctx.has('timesheets.view.all') &&
      timesheet.employee.reportingToId !== req.ctx.employeeId
    ) {
      throw forbidden('You can only approve your own team’s timesheets');
    }
    if (req.body.decision === 'REJECTED' && !req.body.reason) {
      throw badRequest('Give a reason when rejecting a timesheet');
    }

    const updated = await prisma.timesheet.update({
      where: { id: timesheet.id },
      data: {
        status: req.body.decision,
        approvedById: req.ctx.user.id,
        approvedAt: new Date(),
        rejectReason: req.body.decision === 'REJECTED' ? req.body.reason : null,
      },
    });

    await auditFromRequest(req, {
      action: req.body.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
      entityType: 'Timesheet',
      entityId: timesheet.id,
      entityLabel: `${timesheet.employee.user.name} - ${dayjs(timesheet.weekStart).format('DD MMM YYYY')}`,
      summary: `${req.body.decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${timesheet.employee.user.name}'s timesheet`,
    });

    await notify({
      userIds: [timesheet.employee.userId],
      type: 'TIMESHEET_DECIDED',
      title: `Your timesheet was ${req.body.decision.toLowerCase()}`,
      body: req.body.reason,
      link: '/timesheets/my',
    });

    return ok(res, updated);
  }),
);

/** Reopens an approved week so a correction can be made. */
timeRouter.post(
  '/timesheets/:id/reopen',
  requirePermission('timesheets.approve'),
  asyncHandler(async (req, res) => {
    const timesheet = await prisma.timesheet.findUnique({
      where: { id: req.params.id },
      include: { employee: { select: { userId: true, user: { select: { name: true } } } } },
    });
    if (!timesheet) throw notFound('Timesheet');

    const updated = await prisma.timesheet.update({
      where: { id: timesheet.id },
      data: { status: 'DRAFT', approvedAt: null, approvedById: null, submittedAt: null },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Timesheet',
      entityId: timesheet.id,
      summary: `Reopened ${timesheet.employee.user.name}'s timesheet`,
    });

    await notify({
      userIds: [timesheet.employee.userId],
      type: 'TIMESHEET_DECIDED',
      title: 'Your timesheet was reopened for edits',
      link: '/timesheets/my',
    });

    return ok(res, updated);
  }),
);
