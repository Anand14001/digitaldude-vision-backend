import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { auditFromRequest } from '../../lib/audit';
import { prisma } from '../../lib/prisma';
import { projectWhere } from '../../lib/scope';
import { dayjs, startOfDay } from '../../lib/dates';

export const reportsRouter = Router();

const range = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Defaults to the current month when no range is given. */
const resolveRange = (q: { from?: Date; to?: Date }) => ({
  from: startOfDay(q.from ?? dayjs().startOf('month').toDate()),
  to: dayjs(q.to ?? new Date()).endOf('day').toDate(),
});

// ------------------------------------------------------------ project delivery
reportsRouter.get(
  '/project-delivery',
  requirePermission('reports.view'),
  validate({ query: range }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query as { from?: Date; to?: Date });
    const scope = projectWhere(req.ctx);

    const [completed, byStatus, byServiceLine, overdueOpen] = await Promise.all([
      prisma.project.findMany({
        where: { ...scope, completedAt: { gte: from, lte: to } },
        select: {
          id: true,
          code: true,
          name: true,
          dueDate: true,
          completedAt: true,
          client: { select: { name: true } },
          serviceLine: { select: { name: true } },
        },
      }),
      prisma.project.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      prisma.project.groupBy({
        by: ['serviceLineId'],
        where: { ...scope, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      prisma.project.count({
        where: {
          ...scope,
          status: { in: ['PLANNING', 'ACTIVE', 'ON_HOLD'] },
          dueDate: { lt: new Date() },
        },
      }),
    ]);

    // On-time means completed on or before the committed due date.
    const withDue = completed.filter((p) => p.dueDate);
    const onTime = withDue.filter(
      (p) => p.completedAt && p.dueDate && p.completedAt <= p.dueDate,
    );

    const serviceLines = await prisma.serviceLine.findMany({
      where: { id: { in: byServiceLine.map((r) => r.serviceLineId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    });

    return ok(res, {
      range: { from, to },
      completedCount: completed.length,
      onTimeCount: onTime.length,
      onTimePercent: withDue.length ? Math.round((onTime.length / withDue.length) * 100) : null,
      overdueOpenCount: overdueOpen,
      averageDaysLate: withDue.length
        ? Math.round(
            withDue.reduce(
              (sum, p) =>
                sum + Math.max(0, dayjs(p.completedAt).diff(dayjs(p.dueDate), 'day')),
              0,
            ) / withDue.length,
          )
        : null,
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byServiceLine: byServiceLine.map((r) => ({
        serviceLine:
          serviceLines.find((s) => s.id === r.serviceLineId)?.name ?? 'Unassigned',
        count: r._count._all,
      })),
      lateProjects: withDue
        .filter((p) => p.completedAt && p.dueDate && p.completedAt > p.dueDate)
        .map((p) => ({
          ...p,
          daysLate: dayjs(p.completedAt).diff(dayjs(p.dueDate), 'day'),
        })),
    });
  }),
);

// ----------------------------------------------------------- stage cycle times
/** How long projects sit in each stage - where the pipeline actually jams. */
reportsRouter.get(
  '/stage-cycle-time',
  requirePermission('reports.view'),
  validate({ query: range.extend({ workflowId: z.string().cuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { from?: Date; to?: Date; workflowId?: string };
    const { from, to } = resolveRange(q);

    const history = await prisma.projectStageHistory.findMany({
      where: {
        enteredAt: { gte: from, lte: to },
        exitedAt: { not: null },
        project: projectWhere(req.ctx),
        ...(q.workflowId ? { stage: { workflowId: q.workflowId } } : {}),
      },
      select: {
        enteredAt: true,
        exitedAt: true,
        stage: { select: { id: true, name: true, color: true, sortOrder: true } },
      },
    });

    const grouped = new Map<
      string,
      { name: string; color: string; sortOrder: number; durations: number[] }
    >();
    for (const row of history) {
      const entry = grouped.get(row.stage.id) ?? {
        name: row.stage.name,
        color: row.stage.color,
        sortOrder: row.stage.sortOrder,
        durations: [],
      };
      entry.durations.push(dayjs(row.exitedAt).diff(row.enteredAt, 'hour') / 24);
      grouped.set(row.stage.id, entry);
    }

    const stages = [...grouped.entries()]
      .map(([id, entry]) => {
        const sorted = [...entry.durations].sort((a, b) => a - b);
        return {
          stageId: id,
          name: entry.name,
          color: entry.color,
          sortOrder: entry.sortOrder,
          samples: sorted.length,
          averageDays: Number(
            (sorted.reduce((s, d) => s + d, 0) / sorted.length).toFixed(1),
          ),
          medianDays: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1)),
          maxDays: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return ok(res, { range: { from, to }, stages });
  }),
);

// ------------------------------------------------------------------ utilization
reportsRouter.get(
  '/utilization',
  requirePermission('reports.view'),
  validate({ query: range }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query as { from?: Date; to?: Date });
    const weeks = Math.max(1, dayjs(to).diff(from, 'week', true));

    const [employees, logged, billable] = await Promise.all([
      prisma.employee.findMany({
        where: { status: { in: ['ACTIVE', 'ONBOARDING'] } },
        select: {
          id: true,
          employeeCode: true,
          weeklyCapacityHours: true,
          user: { select: { name: true } },
          department: { select: { name: true } },
          designation: { select: { title: true } },
        },
      }),
      prisma.timeEntry.groupBy({
        by: ['employeeId'],
        where: { workDate: { gte: from, lte: to } },
        _sum: { hours: true },
      }),
      prisma.timeEntry.groupBy({
        by: ['employeeId'],
        where: { workDate: { gte: from, lte: to }, billable: true },
        _sum: { hours: true },
      }),
    ]);

    const rows = employees
      .map((employee) => {
        const capacity = Number(employee.weeklyCapacityHours) * weeks;
        const total = Number(logged.find((l) => l.employeeId === employee.id)?._sum.hours ?? 0);
        const billed = Number(billable.find((l) => l.employeeId === employee.id)?._sum.hours ?? 0);
        return {
          employee: {
            id: employee.id,
            code: employee.employeeCode,
            name: employee.user.name,
            department: employee.department?.name ?? null,
            designation: employee.designation?.title ?? null,
          },
          capacityHours: Number(capacity.toFixed(1)),
          loggedHours: total,
          billableHours: billed,
          utilizationPercent: capacity ? Math.round((total / capacity) * 100) : null,
          billablePercent: total ? Math.round((billed / total) * 100) : null,
        };
      })
      .sort((a, b) => (b.utilizationPercent ?? 0) - (a.utilizationPercent ?? 0));

    const totalCapacity = rows.reduce((s, r) => s + r.capacityHours, 0);
    const totalLogged = rows.reduce((s, r) => s + r.loggedHours, 0);
    const totalBillable = rows.reduce((s, r) => s + r.billableHours, 0);

    return ok(res, {
      range: { from, to },
      summary: {
        headcount: rows.length,
        totalCapacityHours: Number(totalCapacity.toFixed(1)),
        totalLoggedHours: totalLogged,
        totalBillableHours: totalBillable,
        utilizationPercent: totalCapacity
          ? Math.round((totalLogged / totalCapacity) * 100)
          : null,
        billablePercent: totalLogged ? Math.round((totalBillable / totalLogged) * 100) : null,
      },
      rows,
    });
  }),
);

// ------------------------------------------------------------- time by client
reportsRouter.get(
  '/time-by-client',
  requirePermission('reports.view'),
  validate({ query: range }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query as { from?: Date; to?: Date });

    const entries = await prisma.timeEntry.findMany({
      where: { workDate: { gte: from, lte: to }, projectId: { not: null } },
      select: {
        hours: true,
        billable: true,
        project: {
          select: {
            id: true,
            code: true,
            name: true,
            client: { select: { id: true, name: true } },
            serviceLine: { select: { name: true } },
          },
        },
      },
    });

    const byClient = new Map<
      string,
      { name: string; hours: number; billableHours: number; projects: Map<string, number> }
    >();

    for (const entry of entries) {
      if (!entry.project?.client) continue;
      const key = entry.project.client.id;
      const bucket =
        byClient.get(key) ??
        { name: entry.project.client.name, hours: 0, billableHours: 0, projects: new Map() };
      const hours = Number(entry.hours);
      bucket.hours += hours;
      if (entry.billable) bucket.billableHours += hours;
      bucket.projects.set(
        entry.project.name,
        (bucket.projects.get(entry.project.name) ?? 0) + hours,
      );
      byClient.set(key, bucket);
    }

    const rows = [...byClient.entries()]
      .map(([clientId, bucket]) => ({
        clientId,
        clientName: bucket.name,
        hours: Number(bucket.hours.toFixed(2)),
        billableHours: Number(bucket.billableHours.toFixed(2)),
        projects: [...bucket.projects.entries()].map(([name, hours]) => ({
          name,
          hours: Number(hours.toFixed(2)),
        })),
      }))
      .sort((a, b) => b.hours - a.hours);

    return ok(res, { range: { from, to }, rows });
  }),
);

// ------------------------------------------------------------ lead conversion
reportsRouter.get(
  '/lead-conversion',
  requirePermission('reports.view'),
  validate({ query: range }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query as { from?: Date; to?: Date });
    const where = { deletedAt: null, createdAt: { gte: from, lte: to } };

    const [byStatus, bySource, won, lost] = await Promise.all([
      prisma.lead.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
      prisma.lead.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
      prisma.lead.findMany({
        where: { ...where, status: 'WON' },
        select: { createdAt: true, wonAt: true, estimatedValue: true },
      }),
      prisma.lead.count({ where: { ...where, status: 'LOST' } }),
    ]);

    const decided = won.length + lost;

    return ok(res, {
      range: { from, to },
      summary: {
        total: byStatus.reduce((s, r) => s + r._count._all, 0),
        won: won.length,
        lost,
        conversionPercent: decided ? Math.round((won.length / decided) * 100) : null,
        wonValue: won.reduce((s, l) => s + Number(l.estimatedValue ?? 0), 0),
        averageDaysToWin: won.length
          ? Math.round(
              won.reduce((s, l) => s + dayjs(l.wonAt ?? l.createdAt).diff(l.createdAt, 'day'), 0) /
                won.length,
            )
          : null,
      },
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: r._count._all,
        value: r._sum.estimatedValue ?? 0,
      })),
      bySource: bySource.map((r) => ({
        source: r.source,
        count: r._count._all,
        value: r._sum.estimatedValue ?? 0,
      })),
    });
  }),
);

// ----------------------------------------------------------- retainer health
reportsRouter.get(
  '/retainer-health',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const now = new Date();
    const [active, renewals, cyclesByStatus, revenue] = await Promise.all([
      prisma.retainer.count({ where: { status: 'ACTIVE', deletedAt: null } }),
      prisma.retainer.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          endDate: { not: null, gte: now, lte: dayjs().add(60, 'day').toDate() },
        },
        orderBy: { endDate: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          endDate: true,
          billingCycle: true,
          ...(req.ctx.has('reports.financial.view') ? { amountPerCycle: true } : {}),
          client: { select: { id: true, name: true } },
        },
      }),
      prisma.retainerCycle.groupBy({ by: ['status'], _count: { _all: true } }),
      req.ctx.has('reports.financial.view')
        ? prisma.retainer.groupBy({
            by: ['billingCycle'],
            where: { status: 'ACTIVE', deletedAt: null },
            _sum: { amountPerCycle: true },
            _count: { _all: true },
          })
        : [],
    ]);

    return ok(res, {
      activeRetainers: active,
      renewalsDue: renewals,
      cyclesByStatus: cyclesByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      ...(req.ctx.has('reports.financial.view')
        ? {
            revenueByCycle: revenue.map((r) => ({
              billingCycle: r.billingCycle,
              count: r._count._all,
              totalPerCycle: r._sum.amountPerCycle ?? 0,
            })),
          }
        : {}),
    });
  }),
);

// ------------------------------------------------------------- attendance view
reportsRouter.get(
  '/attendance-summary',
  requirePermission('reports.view', 'attendance.view.all'),
  validate({ query: range }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query as { from?: Date; to?: Date });

    const [byStatus, lateCount, employees] = await Promise.all([
      prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { workDate: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      prisma.attendanceRecord.count({
        where: { workDate: { gte: from, lte: to }, lateMinutes: { gt: 0 } },
      }),
      prisma.attendanceRecord.groupBy({
        by: ['employeeId'],
        where: { workDate: { gte: from, lte: to } },
        _count: { _all: true },
        _sum: { workedMinutes: true, lateMinutes: true },
      }),
    ]);

    const people = await prisma.employee.findMany({
      where: { id: { in: employees.map((e) => e.employeeId) } },
      select: { id: true, employeeCode: true, user: { select: { name: true } } },
    });

    return ok(res, {
      range: { from, to },
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      lateInstances: lateCount,
      rows: employees
        .map((row) => ({
          employee: people.find((p) => p.id === row.employeeId)?.user.name ?? 'Unknown',
          code: people.find((p) => p.id === row.employeeId)?.employeeCode ?? '',
          daysRecorded: row._count._all,
          hoursWorked: Math.round((row._sum.workedMinutes ?? 0) / 60),
          lateMinutes: row._sum.lateMinutes ?? 0,
        }))
        .sort((a, b) => b.hoursWorked - a.hoursWorked),
    });
  }),
);

// -------------------------------------------------------------------- exports
/** Generic CSV export of any report above, so the front end has one download path. */
reportsRouter.get(
  '/export/:report',
  requirePermission('reports.export'),
  validate({ query: range }),
  asyncHandler(async (req, res) => {
    const { from, to } = resolveRange(req.query as { from?: Date; to?: Date });
    const report = req.params.report as string;

    let header: string[] = [];
    let rows: (string | number | null)[][] = [];

    if (report === 'utilization') {
      const employees = await prisma.employee.findMany({
        where: { status: { in: ['ACTIVE', 'ONBOARDING'] } },
        select: {
          id: true,
          employeeCode: true,
          weeklyCapacityHours: true,
          user: { select: { name: true } },
        },
      });
      const logged = await prisma.timeEntry.groupBy({
        by: ['employeeId'],
        where: { workDate: { gte: from, lte: to } },
        _sum: { hours: true },
      });
      const weeks = Math.max(1, dayjs(to).diff(from, 'week', true));

      header = ['Code', 'Employee', 'Capacity hours', 'Logged hours', 'Utilization %'];
      rows = employees.map((e) => {
        const capacity = Number(e.weeklyCapacityHours) * weeks;
        const hours = Number(logged.find((l) => l.employeeId === e.id)?._sum.hours ?? 0);
        return [
          e.employeeCode,
          e.user.name,
          capacity.toFixed(1),
          hours,
          capacity ? Math.round((hours / capacity) * 100) : '',
        ];
      });
    } else if (report === 'time-entries') {
      const entries = await prisma.timeEntry.findMany({
        where: { workDate: { gte: from, lte: to } },
        orderBy: { workDate: 'asc' },
        include: {
          employee: { select: { employeeCode: true, user: { select: { name: true } } } },
          project: { select: { code: true, name: true, client: { select: { name: true } } } },
          task: { select: { reference: true, title: true } },
        },
        take: 20_000,
      });

      header = ['Date', 'Code', 'Employee', 'Client', 'Project', 'Task', 'Hours', 'Billable', 'Note'];
      rows = entries.map((e) => [
        dayjs(e.workDate).format('YYYY-MM-DD'),
        e.employee.employeeCode,
        e.employee.user.name,
        e.project?.client.name ?? '',
        e.project ? `${e.project.code} ${e.project.name}` : '',
        e.task ? `${e.task.reference} ${e.task.title}` : '',
        Number(e.hours),
        e.billable ? 'Yes' : 'No',
        e.note ?? '',
      ]);
    } else if (report === 'projects') {
      const projects = await prisma.project.findMany({
        where: projectWhere(req.ctx),
        include: {
          client: { select: { name: true } },
          currentStage: { select: { name: true } },
          manager: { select: { user: { select: { name: true } } } },
        },
        take: 20_000,
      });

      header = [
        'Code',
        'Project',
        'Client',
        'Status',
        'Stage',
        'Health',
        'Manager',
        'Start',
        'Due',
        'Completed',
      ];
      rows = projects.map((p) => [
        p.code,
        p.name,
        p.client.name,
        p.status,
        p.currentStage?.name ?? '',
        p.health,
        p.manager?.user.name ?? '',
        p.startDate ? dayjs(p.startDate).format('YYYY-MM-DD') : '',
        p.dueDate ? dayjs(p.dueDate).format('YYYY-MM-DD') : '',
        p.completedAt ? dayjs(p.completedAt).format('YYYY-MM-DD') : '',
      ]);
    } else {
      header = ['Error'];
      rows = [[`Unknown report "${report}"`]];
    }

    const escape = (value: unknown) =>
      `"${(value === null || value === undefined ? '' : String(value)).replace(/"/g, '""')}"`;
    const csv = [header.join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');

    await auditFromRequest(req, {
      action: 'EXPORT',
      entityType: 'Report',
      entityLabel: report,
      summary: `Exported the ${report} report (${rows.length} row(s))`,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${report}-${dayjs(from).format('YYYYMMDD')}-${dayjs(to).format('YYYYMMDD')}.csv"`,
    );
    return res.send(csv);
  }),
);
