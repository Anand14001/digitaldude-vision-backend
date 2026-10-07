import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hrSubjectWhere } from '../../lib/scope';
import { dayjs, startOfDay } from '../../lib/dates';

export const attendanceRouter = Router();

const STATUSES = [
  'PRESENT',
  'WORK_FROM_HOME',
  'HALF_DAY',
  'ON_LEAVE',
  'HOLIDAY',
  'WEEKLY_OFF',
  'ABSENT',
] as const;

/** Grace period before a check-in counts as late. */
const LATE_GRACE_MINUTES = 15;

const listQuery = paginationSchema.extend({
  employeeId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(STATUSES).optional(),
});

async function defaultSchedule() {
  return (
    (await prisma.workSchedule.findFirst({ where: { isDefault: true } })) ?? {
      workingDays: [1, 2, 3, 4, 5, 6],
      startTime: '09:00',
      endTime: '20:00',
    }
  );
}

// ------------------------------------------------------------------- check in
attendanceRouter.post(
  '/check-in',
  requirePermission('attendance.mark.own'),
  validateBody(
    z.object({
      status: z.enum(['PRESENT', 'WORK_FROM_HOME']).default('PRESENT'),
      note: z.string().trim().max(300).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw badRequest('Only employees can mark attendance');

    const today = startOfDay(new Date());
    const existing = await prisma.attendanceRecord.findUnique({
      where: { employeeId_workDate: { employeeId, workDate: today } },
    });
    if (existing?.checkInAt) {
      return ok(res, { alreadyCheckedIn: true, record: existing });
    }

    const schedule = await defaultSchedule();
    const now = new Date();
    const [hour, minute] = schedule.startTime.split(':').map(Number);
    const expectedStart = dayjs(today)
      .hour(hour ?? 9)
      .minute(minute ?? 0);
    const lateMinutes = Math.max(0, dayjs(now).diff(expectedStart, 'minute') - LATE_GRACE_MINUTES);

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_workDate: { employeeId, workDate: today } },
      create: {
        employeeId,
        workDate: today,
        status: req.body.status,
        checkInAt: now,
        lateMinutes: lateMinutes || null,
        note: req.body.note ?? null,
      },
      update: {
        status: req.body.status,
        checkInAt: now,
        lateMinutes: lateMinutes || null,
        note: req.body.note ?? null,
      },
    });

    return created(res, record);
  }),
);

attendanceRouter.post(
  '/check-out',
  requirePermission('attendance.mark.own'),
  validateBody(z.object({ note: z.string().trim().max(300).optional() })),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw badRequest('Only employees can mark attendance');

    const today = startOfDay(new Date());
    const record = await prisma.attendanceRecord.findUnique({
      where: { employeeId_workDate: { employeeId, workDate: today } },
    });
    if (!record?.checkInAt) throw badRequest('You have not checked in today');
    if (record.checkOutAt) return ok(res, { alreadyCheckedOut: true, record });

    const now = new Date();
    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        checkOutAt: now,
        workedMinutes: dayjs(now).diff(record.checkInAt, 'minute'),
        note: req.body.note ?? record.note,
      },
    });

    return ok(res, updated);
  }),
);

/** Today's own state, for the dashboard widget. */
attendanceRouter.get(
  '/today',
  requirePermission('attendance.mark.own'),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) return ok(res, { record: null });

    const today = startOfDay(new Date());
    const [record, holiday] = await Promise.all([
      prisma.attendanceRecord.findUnique({
        where: { employeeId_workDate: { employeeId, workDate: today } },
      }),
      prisma.holiday.findFirst({ where: { date: today } }),
    ]);

    const schedule = await defaultSchedule();
    return ok(res, {
      record,
      holiday,
      isWorkingDay: schedule.workingDays.includes(dayjs(today).day()),
      schedule: { startTime: schedule.startTime, endTime: schedule.endTime },
    });
  }),
);

// -------------------------------------------------------------------- listing
attendanceRouter.get(
  '/',
  requirePermission('attendance.view.all', 'attendance.view.team', 'attendance.mark.own'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const scope = hrSubjectWhere(req.ctx, {
      all: 'attendance.view.all',
      team: 'attendance.view.team',
    });

    const where = {
      ...scope,
      ...(q.employeeId ? { AND: [{ employeeId: q.employeeId }, scope] } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to
        ? {
            workDate: {
              ...(q.from ? { gte: startOfDay(q.from) } : {}),
              ...(q.to ? { lte: startOfDay(q.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        orderBy: [{ workDate: 'desc' }],
        include: {
          employee: {
            select: { id: true, employeeCode: true, user: { select: { name: true } } },
          },
        },
        ...skipTake(q),
      }),
      prisma.attendanceRecord.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/**
 * Month grid for the whole visible team: one row per employee, one cell per
 * day, with holidays and approved leave already folded in.
 */
attendanceRouter.get(
  '/monthly',
  requirePermission('attendance.view.all', 'attendance.view.team'),
  validate({
    query: z.object({
      month: z.coerce.number().int().min(1).max(12).optional(),
      year: z.coerce.number().int().min(2020).max(2100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { month?: number; year?: number };
    const anchor = dayjs()
      .year(q.year ?? dayjs().year())
      .month((q.month ?? dayjs().month() + 1) - 1);
    const from = anchor.startOf('month').toDate();
    const to = anchor.endOf('month').startOf('day').toDate();

    const scope = hrSubjectWhere(req.ctx, {
      all: 'attendance.view.all',
      team: 'attendance.view.team',
    });

    const employeeFilter =
      'employeeId' in scope && scope.employeeId
        ? { id: scope.employeeId }
        : 'employee' in scope && scope.employee
          ? scope.employee
          : {};

    const [employees, records, holidays, leaves, schedule] = await Promise.all([
      prisma.employee.findMany({
        where: { ...employeeFilter, status: { not: 'EXITED' } },
        orderBy: { employeeCode: 'asc' },
        select: {
          id: true,
          employeeCode: true,
          user: { select: { name: true } },
          department: { select: { name: true } },
        },
      }),
      prisma.attendanceRecord.findMany({
        where: { ...scope, workDate: { gte: from, lte: to } },
      }),
      prisma.holiday.findMany({ where: { date: { gte: from, lte: to } } }),
      prisma.leaveRequest.findMany({
        where: {
          ...scope,
          status: 'APPROVED',
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: { employeeId: true, startDate: true, endDate: true, leaveType: { select: { code: true } } },
      }),
      defaultSchedule(),
    ]);

    const days = Array.from({ length: anchor.daysInMonth() }, (_, i) =>
      anchor.date(i + 1).format('YYYY-MM-DD'),
    );
    const holidayDates = new Set(holidays.map((h) => dayjs(h.date).format('YYYY-MM-DD')));

    const rows = employees.map((employee) => ({
      employee: {
        id: employee.id,
        code: employee.employeeCode,
        name: employee.user.name,
        department: employee.department?.name ?? null,
      },
      days: days.map((day) => {
        const record = records.find(
          (r) => r.employeeId === employee.id && dayjs(r.workDate).format('YYYY-MM-DD') === day,
        );
        if (record) return { date: day, status: record.status, lateMinutes: record.lateMinutes };

        const onLeave = leaves.find(
          (l) =>
            l.employeeId === employee.id &&
            !dayjs(day).isBefore(dayjs(l.startDate), 'day') &&
            !dayjs(day).isAfter(dayjs(l.endDate), 'day'),
        );
        if (onLeave) return { date: day, status: 'ON_LEAVE' as const, leaveCode: onLeave.leaveType.code };
        if (holidayDates.has(day)) return { date: day, status: 'HOLIDAY' as const };
        if (!schedule.workingDays.includes(dayjs(day).day())) {
          return { date: day, status: 'WEEKLY_OFF' as const };
        }
        // Past working days with nothing recorded read as absent; future ones are blank.
        return {
          date: day,
          status: dayjs(day).isBefore(dayjs(), 'day') ? ('ABSENT' as const) : null,
        };
      }),
    }));

    return ok(res, { month: anchor.month() + 1, year: anchor.year(), days, rows });
  }),
);

/** Manual correction - always audited, since it overrides a recorded fact. */
attendanceRouter.put(
  '/:employeeId/:date',
  requirePermission('attendance.manage'),
  validateBody(
    z.object({
      status: z.enum(STATUSES),
      checkInAt: z.coerce.date().nullish(),
      checkOutAt: z.coerce.date().nullish(),
      note: z.string().trim().max(300).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.employeeId },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!employee) throw notFound('Employee');

    const workDate = startOfDay(req.params.date as string);
    if (Number.isNaN(workDate.getTime())) throw badRequest('Invalid date');
    if (dayjs(workDate).isAfter(dayjs(), 'day')) {
      throw badRequest('Attendance cannot be recorded for a future date');
    }

    const before = await prisma.attendanceRecord.findUnique({
      where: { employeeId_workDate: { employeeId: employee.id, workDate } },
    });

    const body = req.body as {
      status: (typeof STATUSES)[number];
      checkInAt?: Date | null;
      checkOutAt?: Date | null;
      note?: string;
    };

    const workedMinutes =
      body.checkInAt && body.checkOutAt
        ? dayjs(body.checkOutAt).diff(body.checkInAt, 'minute')
        : null;

    const record = await prisma.attendanceRecord.upsert({
      where: { employeeId_workDate: { employeeId: employee.id, workDate } },
      create: { ...body, employeeId: employee.id, workDate, workedMinutes },
      update: { ...body, workedMinutes },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Attendance',
      entityId: record.id,
      entityLabel: `${employee.user.name} ${dayjs(workDate).format('DD MMM YYYY')}`,
      summary: `Corrected attendance for ${employee.user.name} on ${dayjs(workDate).format('DD MMM YYYY')}`,
      diff: diffRecords(before, body as Record<string, unknown>) ?? undefined,
    });

    return ok(res, record);
  }),
);

/** Own history, available to every employee without a view permission. */
attendanceRouter.get(
  '/my',
  requirePermission('attendance.mark.own'),
  validate({
    query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) throw forbidden('Only employees have attendance');
    const q = req.query as unknown as { from?: Date; to?: Date };

    const records = await prisma.attendanceRecord.findMany({
      where: {
        employeeId,
        workDate: {
          gte: startOfDay(q.from ?? dayjs().startOf('month').toDate()),
          lte: startOfDay(q.to ?? new Date()),
        },
      },
      orderBy: { workDate: 'desc' },
    });

    return ok(res, {
      records,
      summary: {
        present: records.filter((r) => r.status === 'PRESENT' || r.status === 'WORK_FROM_HOME').length,
        onLeave: records.filter((r) => r.status === 'ON_LEAVE').length,
        absent: records.filter((r) => r.status === 'ABSENT').length,
        lateDays: records.filter((r) => (r.lateMinutes ?? 0) > 0).length,
        totalHours: Math.round(
          records.reduce((sum, r) => sum + (r.workedMinutes ?? 0), 0) / 60,
        ),
      },
    });
  }),
);
