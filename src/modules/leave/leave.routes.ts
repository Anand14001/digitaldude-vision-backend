import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hrSubjectWhere } from '../../lib/scope';
import { dayjs, startOfDay, workingDaysBetween } from '../../lib/dates';
import { notify } from '../../lib/notify';

export const leaveRouter = Router();

const listQuery = paginationSchema.extend({
  employeeId: z.string().cuid().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  leaveTypeId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Working days in a range, excluding weekly offs and holidays. */
async function chargeableDays(start: Date, end: Date, halfDay: boolean): Promise<number> {
  const [schedule, holidays] = await Promise.all([
    prisma.workSchedule.findFirst({ where: { isDefault: true } }),
    prisma.holiday.findMany({
      where: { date: { gte: startOfDay(start), lte: startOfDay(end) }, isOptional: false },
      select: { date: true },
    }),
  ]);

  const days = workingDaysBetween(start, end, {
    workingDays: schedule?.workingDays ?? [1, 2, 3, 4, 5, 6],
    holidays: holidays.map((h) => h.date),
  });

  if (halfDay) {
    if (days !== 1) throw badRequest('A half day must cover a single date');
    return 0.5;
  }
  return days;
}

// -------------------------------------------------------------------- balances
leaveRouter.get(
  '/balances/my',
  requirePermission('leave.request.own'),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw forbidden('Only employees have leave balances');

    const year = new Date().getFullYear();
    const balances = await prisma.leaveBalance.findMany({
      where: { employeeId, year },
      include: { leaveType: true },
      orderBy: { leaveType: { name: 'asc' } },
    });

    return ok(
      res,
      balances.map((b) => ({
        ...b,
        available: Number(b.entitled) + Number(b.carriedOver) - Number(b.used),
      })),
    );
  }),
);

leaveRouter.get(
  '/balances',
  requirePermission('leave.view.all', 'leave.view.team'),
  validate({ query: z.object({ year: z.coerce.number().int().optional() }) }),
  asyncHandler(async (req, res) => {
    const year = (req.query as { year?: number }).year ?? new Date().getFullYear();
    const scope = hrSubjectWhere(req.ctx, { all: 'leave.view.all', team: 'leave.view.team' });

    const balances = await prisma.leaveBalance.findMany({
      where: { ...scope, year },
      include: {
        leaveType: { select: { id: true, name: true, code: true } },
        employee: {
          select: { id: true, employeeCode: true, user: { select: { name: true } } },
        },
      },
    });

    return ok(res, balances);
  }),
);

leaveRouter.put(
  '/balances/:id',
  requirePermission('leave.balance.manage'),
  validateBody(
    z.object({
      entitled: z.coerce.number().min(0).max(365),
      carriedOver: z.coerce.number().min(0).max(365).default(0),
      used: z.coerce.number().min(0).max(365).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const balance = await prisma.leaveBalance.findUnique({
      where: { id: req.params.id },
      include: {
        employee: { select: { user: { select: { name: true } } } },
        leaveType: { select: { name: true } },
      },
    });
    if (!balance) throw notFound('Leave balance');

    const updated = await prisma.leaveBalance.update({
      where: { id: balance.id },
      data: req.body as Record<string, never>,
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'LeaveBalance',
      entityId: balance.id,
      entityLabel: `${balance.employee.user.name} - ${balance.leaveType.name}`,
      summary: `Adjusted ${balance.leaveType.name} balance for ${balance.employee.user.name}`,
      diff: {
        entitled: { from: Number(balance.entitled), to: updated.entitled },
        carriedOver: { from: Number(balance.carriedOver), to: updated.carriedOver },
        used: { from: Number(balance.used), to: updated.used },
      },
    });

    return ok(res, updated);
  }),
);

// -------------------------------------------------------------------- requests
leaveRouter.get(
  '/requests',
  requirePermission('leave.request.own', 'leave.view.all', 'leave.view.team'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const scope = hrSubjectWhere(req.ctx, { all: 'leave.view.all', team: 'leave.view.team' });

    const where = {
      ...scope,
      ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }, scope] } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.leaveTypeId ? { leaveTypeId: q.leaveTypeId } : {}),
      ...(q.from || q.to
        ? {
            startDate: q.to ? { lte: startOfDay(q.to) } : undefined,
            endDate: q.from ? { gte: startOfDay(q.from) } : undefined,
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
        include: {
          leaveType: { select: { id: true, name: true, code: true, isPaid: true } },
          employee: {
            select: {
              id: true,
              employeeCode: true,
              user: { select: { name: true, avatar: { select: { url: true } } } },
              reportingTo: { select: { id: true } },
            },
          },
          approver: { select: { id: true, user: { select: { name: true } } } },
          proofFile: { select: { id: true, url: true, originalName: true } },
        },
        ...skipTake(q),
      }),
      prisma.leaveRequest.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

leaveRouter.post(
  '/requests',
  requirePermission('leave.request.own'),
  validateBody(
    z.object({
      leaveTypeId: z.string().cuid(),
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
      halfDay: z.boolean().default(false),
      reason: z.string().trim().max(1000).optional(),
      proofFileId: z.string().cuid().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw forbidden('Only employees can request leave');

    const body = req.body as {
      leaveTypeId: string;
      startDate: Date;
      endDate: Date;
      halfDay: boolean;
      reason?: string;
      proofFileId?: string | null;
    };

    if (dayjs(body.endDate).isBefore(dayjs(body.startDate), 'day')) {
      throw badRequest('The end date cannot be before the start date');
    }

    const leaveType = await prisma.leaveType.findFirst({
      where: { id: body.leaveTypeId, active: true },
    });
    if (!leaveType) throw badRequest('That leave type is not available');
    if (leaveType.requiresProof && !body.proofFileId) {
      throw badRequest(`${leaveType.name} requires supporting documentation`);
    }

    // Reject overlaps rather than silently double-counting a day.
    const overlap = await prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: startOfDay(body.endDate) },
        endDate: { gte: startOfDay(body.startDate) },
      },
      select: { id: true, startDate: true, endDate: true },
    });
    if (overlap) {
      throw conflict(
        `You already have leave between ${dayjs(overlap.startDate).format('DD MMM')} and ${dayjs(overlap.endDate).format('DD MMM')}`,
      );
    }

    const totalDays = await chargeableDays(body.startDate, body.endDate, body.halfDay);
    if (totalDays <= 0) {
      throw badRequest('That range contains no working days');
    }

    // Quota of 0 means the type is unaccrued (loss of pay), so skip the check.
    if (Number(leaveType.annualQuota) > 0) {
      const balance = await prisma.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId,
            leaveTypeId: leaveType.id,
            year: dayjs(body.startDate).year(),
          },
        },
      });
      const available = balance
        ? Number(balance.entitled) + Number(balance.carriedOver) - Number(balance.used)
        : 0;
      if (totalDays > available) {
        throw badRequest(
          `You have ${available} day(s) of ${leaveType.name} left but requested ${totalDays}`,
        );
      }
    }

    const employee = await prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { reportingToId: true, user: { select: { name: true } } },
    });

    const request = await prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: leaveType.id,
        startDate: startOfDay(body.startDate),
        endDate: startOfDay(body.endDate),
        totalDays,
        reason: body.reason ?? null,
        proofFileId: body.proofFileId ?? null,
        approverId: employee.reportingToId,
      },
    });

    if (employee.reportingToId) {
      const manager = await prisma.employee.findUnique({
        where: { id: employee.reportingToId },
        select: { userId: true },
      });
      if (manager) {
        await notify({
          userIds: [manager.userId],
          type: 'LEAVE_REQUESTED',
          title: `${employee.user.name} requested ${totalDays} day(s) of ${leaveType.name}`,
          body: `${dayjs(body.startDate).format('DD MMM')} to ${dayjs(body.endDate).format('DD MMM YYYY')}`,
          link: `/leave/requests/${request.id}`,
          entityType: 'LeaveRequest',
          entityId: request.id,
          email: true,
        });
      }
    }

    return created(res, request);
  }),
);

leaveRouter.post(
  '/requests/:id/decision',
  requirePermission('leave.approve'),
  validateBody(
    z.object({
      decision: z.enum(['APPROVED', 'REJECTED']),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const request = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: {
        leaveType: true,
        employee: {
          select: { id: true, userId: true, reportingToId: true, user: { select: { name: true } } },
        },
      },
    });
    if (!request) throw notFound('Leave request');
    if (request.status !== 'PENDING') throw badRequest('That request has already been decided');
    if (request.employee.id === req.ctx.employeeId) {
      throw forbidden('You cannot decide your own leave');
    }
    if (
      !req.ctx.has('leave.view.all') &&
      request.employee.reportingToId !== req.ctx.employeeId
    ) {
      throw forbidden('You can only decide leave for your own team');
    }

    const approved = req.body.decision === 'APPROVED';

    await prisma.$transaction(async (tx) => {
      await tx.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: req.body.decision,
          approverId: req.ctx.employeeId,
          decidedAt: new Date(),
          decisionNote: req.body.note ?? null,
        },
      });

      if (approved) {
        // Consume the balance and pre-fill attendance for the covered days.
        if (Number(request.leaveType.annualQuota) > 0) {
          await tx.leaveBalance.updateMany({
            where: {
              employeeId: request.employeeId,
              leaveTypeId: request.leaveTypeId,
              year: dayjs(request.startDate).year(),
            },
            data: { used: { increment: request.totalDays } },
          });
        }

        let cursor = dayjs(request.startDate);
        const last = dayjs(request.endDate);
        while (cursor.isBefore(last) || cursor.isSame(last, 'day')) {
          await tx.attendanceRecord.upsert({
            where: {
              employeeId_workDate: {
                employeeId: request.employeeId,
                workDate: cursor.startOf('day').toDate(),
              },
            },
            create: {
              employeeId: request.employeeId,
              workDate: cursor.startOf('day').toDate(),
              status: Number(request.totalDays) === 0.5 ? 'HALF_DAY' : 'ON_LEAVE',
              note: `${request.leaveType.name}`,
            },
            update: {
              status: Number(request.totalDays) === 0.5 ? 'HALF_DAY' : 'ON_LEAVE',
            },
          });
          cursor = cursor.add(1, 'day');
        }
      }
    });

    await auditFromRequest(req, {
      action: approved ? 'APPROVE' : 'REJECT',
      entityType: 'LeaveRequest',
      entityId: request.id,
      entityLabel: `${request.employee.user.name} - ${request.leaveType.name}`,
      summary: `${approved ? 'Approved' : 'Rejected'} ${request.totalDays} day(s) of ${request.leaveType.name} for ${request.employee.user.name}`,
    });

    await notify({
      userIds: [request.employee.userId],
      type: 'LEAVE_DECIDED',
      title: `Your leave request was ${req.body.decision.toLowerCase()}`,
      body: req.body.note,
      link: '/leave/my',
      email: true,
    });

    return ok(res, { decision: req.body.decision });
  }),
);

/** An employee may withdraw their own request while it is still pending. */
leaveRouter.post(
  '/requests/:id/cancel',
  requirePermission('leave.request.own'),
  asyncHandler(async (req, res) => {
    const request = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      include: { leaveType: { select: { name: true, annualQuota: true } } },
    });
    if (!request) throw notFound('Leave request');
    if (request.employeeId !== req.ctx.employeeId && !req.ctx.has('leave.approve')) {
      throw forbidden('You can only cancel your own leave');
    }
    if (request.status === 'CANCELLED') return ok(res, { alreadyCancelled: true });
    if (request.status === 'REJECTED') throw badRequest('A rejected request cannot be cancelled');
    if (
      request.status === 'APPROVED' &&
      dayjs(request.startDate).isBefore(dayjs(), 'day') &&
      !req.ctx.has('leave.approve')
    ) {
      throw badRequest('Leave that has already started cannot be cancelled');
    }

    await prisma.$transaction(async (tx) => {
      await tx.leaveRequest.update({
        where: { id: request.id },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });

      if (request.status === 'APPROVED') {
        if (Number(request.leaveType.annualQuota) > 0) {
          await tx.leaveBalance.updateMany({
            where: {
              employeeId: request.employeeId,
              leaveTypeId: request.leaveTypeId,
              year: dayjs(request.startDate).year(),
            },
            data: { used: { decrement: request.totalDays } },
          });
        }
        // Clear the attendance rows this leave created.
        await tx.attendanceRecord.deleteMany({
          where: {
            employeeId: request.employeeId,
            workDate: { gte: request.startDate, lte: request.endDate },
            status: { in: ['ON_LEAVE', 'HALF_DAY'] },
          },
        });
      }
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'LeaveRequest',
      entityId: request.id,
      summary: `Cancelled a ${request.leaveType.name} request`,
    });

    return ok(res, { cancelled: true });
  }),
);

/** Who is off right now - used by the calendar and the dashboard. */
leaveRouter.get(
  '/on-leave',
  requirePermission('leave.view.all', 'leave.view.team', 'calendar.view.all'),
  validate({
    query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { from?: Date; to?: Date };
    const from = startOfDay(q.from ?? new Date());
    const to = startOfDay(q.to ?? dayjs().add(14, 'day').toDate());

    const leaves = await prisma.leaveRequest.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        totalDays: true,
        leaveType: { select: { name: true, code: true } },
        employee: {
          select: {
            id: true,
            user: { select: { name: true, avatar: { select: { url: true } } } },
            department: { select: { name: true } },
          },
        },
      },
      orderBy: { startDate: 'asc' },
    });

    return ok(res, leaves);
  }),
);
