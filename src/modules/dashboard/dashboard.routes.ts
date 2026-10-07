import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { asyncHandler, ok } from '../../lib/http';
import { requireAuth, requireStaff } from '../../middleware/auth';
import { prisma } from '../../lib/prisma';
import { projectWhere, taskWhere } from '../../lib/scope';
import { dayjs, startOfDay } from '../../lib/dates';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth, requireStaff);

/**
 * One endpoint, shaped by what the caller is allowed to see. Rather than three
 * separate dashboards that drift apart, each block is included only when the
 * permission behind it is held - so an admin sees org-wide figures, a manager
 * sees their team, and an individual sees their own work.
 */
dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const employeeId = ctx.employeeId;
    const now = new Date();
    const today = startOfDay(now);
    const weekAhead = dayjs().add(7, 'day').endOf('day').toDate();

    // ---- always present: the caller's own work ----
    const myTaskWhere: Prisma.TaskWhereInput = {
      assigneeId: employeeId ?? '__none__',
      deletedAt: null,
      completedAt: null,
      status: { category: { notIn: ['DONE', 'CANCELLED'] } },
    };

    const [myOpen, myOverdue, myDueToday, myDueThisWeek, attendanceToday, unread] =
      await Promise.all([
        prisma.task.count({ where: myTaskWhere }),
        prisma.task.count({ where: { ...myTaskWhere, dueDate: { lt: today } } }),
        prisma.task.count({
          where: { ...myTaskWhere, dueDate: { gte: today, lt: dayjs(today).add(1, 'day').toDate() } },
        }),
        prisma.task.count({ where: { ...myTaskWhere, dueDate: { gte: today, lte: weekAhead } } }),
        employeeId
          ? prisma.attendanceRecord.findUnique({
              where: { employeeId_workDate: { employeeId, workDate: today } },
              select: { status: true, checkInAt: true, checkOutAt: true },
            })
          : null,
        prisma.notification.count({ where: { userId: ctx.user.id, readAt: null } }),
      ]);

    const payload: Record<string, unknown> = {
      role: ctx.user.roleName,
      isAdmin: ctx.user.isAdmin,
      me: {
        openTasks: myOpen,
        overdueTasks: myOverdue,
        dueToday: myDueToday,
        dueThisWeek: myDueThisWeek,
        attendance: attendanceToday,
        unreadNotifications: unread,
      },
      upcomingTasks: await prisma.task.findMany({
        where: { ...myTaskWhere, dueDate: { not: null } },
        orderBy: { dueDate: 'asc' },
        take: 8,
        select: {
          id: true,
          reference: true,
          title: true,
          dueDate: true,
          priority: true,
          status: { select: { name: true, color: true } },
          project: { select: { id: true, code: true, name: true } },
        },
      }),
    };

    // ---- projects block: scoped to what they can see ----
    if (ctx.hasAny('projects.view.all', 'projects.view.assigned')) {
      const scope = projectWhere(ctx);
      const [byStatus, byHealth, dueSoon, recent] = await Promise.all([
        prisma.project.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
        prisma.project.groupBy({
          by: ['health'],
          where: { ...scope, status: { in: ['PLANNING', 'ACTIVE', 'ON_HOLD'] } },
          _count: { _all: true },
        }),
        prisma.project.findMany({
          where: {
            ...scope,
            status: { in: ['PLANNING', 'ACTIVE'] },
            dueDate: { not: null, lte: dayjs().add(14, 'day').toDate() },
          },
          orderBy: { dueDate: 'asc' },
          take: 8,
          select: {
            id: true,
            code: true,
            name: true,
            dueDate: true,
            health: true,
            client: { select: { name: true } },
            currentStage: { select: { name: true, color: true } },
          },
        }),
        prisma.project.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            createdAt: true,
            client: { select: { name: true } },
          },
        }),
      ]);

      payload.projects = {
        byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
        byHealth: byHealth.map((r) => ({ health: r.health, count: r._count._all })),
        dueSoon,
        recent,
      };
    }

    // ---- team block: managers and admins ----
    if (ctx.hasAny('employees.view.all', 'employees.view.team')) {
      const teamFilter: Prisma.EmployeeWhereInput = ctx.has('employees.view.all')
        ? { status: { in: ['ACTIVE', 'ONBOARDING'] } }
        : { reportingToId: employeeId ?? '__none__' };

      const team = await prisma.employee.findMany({
        where: teamFilter,
        select: {
          id: true,
          user: { select: { name: true, avatar: { select: { url: true } } } },
          designation: { select: { title: true } },
        },
        take: 100,
      });
      const teamIds = team.map((t) => t.id);

      const [openByAssignee, overdueByAssignee, presentToday, pendingLeave, pendingTimesheets] =
        await Promise.all([
          prisma.task.groupBy({
            by: ['assigneeId'],
            where: {
              assigneeId: { in: teamIds },
              deletedAt: null,
              completedAt: null,
              status: { category: { notIn: ['DONE', 'CANCELLED'] } },
            },
            _count: { _all: true },
          }),
          prisma.task.groupBy({
            by: ['assigneeId'],
            where: {
              assigneeId: { in: teamIds },
              deletedAt: null,
              completedAt: null,
              dueDate: { lt: today },
            },
            _count: { _all: true },
          }),
          prisma.attendanceRecord.count({
            where: {
              employeeId: { in: teamIds },
              workDate: today,
              status: { in: ['PRESENT', 'WORK_FROM_HOME'] },
            },
          }),
          ctx.has('leave.approve')
            ? prisma.leaveRequest.count({
                where: { status: 'PENDING', employeeId: { in: teamIds } },
              })
            : 0,
          ctx.has('timesheets.approve')
            ? prisma.timesheet.count({
                where: { status: 'SUBMITTED', employeeId: { in: teamIds } },
              })
            : 0,
        ]);

      payload.team = {
        headcount: team.length,
        presentToday,
        pendingLeaveApprovals: pendingLeave,
        pendingTimesheetApprovals: pendingTimesheets,
        members: team.map((member) => ({
          id: member.id,
          name: member.user.name,
          avatarUrl: member.user.avatar?.url ?? null,
          designation: member.designation?.title ?? null,
          openTasks: openByAssignee.find((t) => t.assigneeId === member.id)?._count._all ?? 0,
          overdueTasks: overdueByAssignee.find((t) => t.assigneeId === member.id)?._count._all ?? 0,
        })),
      };
    }

    // ---- commercial block: admins and anyone with financial sight ----
    if (ctx.has('reports.financial.view')) {
      const [activeClients, activeRetainers, retainerValue, renewalsDue, openPipeline] =
        await Promise.all([
          prisma.client.count({ where: { status: 'ACTIVE', deletedAt: null } }),
          prisma.retainer.count({ where: { status: 'ACTIVE', deletedAt: null } }),
          prisma.retainer.aggregate({
            where: { status: 'ACTIVE', deletedAt: null, billingCycle: 'MONTHLY' },
            _sum: { amountPerCycle: true },
          }),
          prisma.retainer.count({
            where: {
              status: 'ACTIVE',
              deletedAt: null,
              endDate: { not: null, gte: now, lte: dayjs().add(30, 'day').toDate() },
            },
          }),
          prisma.lead.aggregate({
            where: { deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
            _sum: { estimatedValue: true },
            _count: { _all: true },
          }),
        ]);

      payload.commercial = {
        activeClients,
        activeRetainers,
        monthlyRecurringValue: retainerValue._sum.amountPerCycle ?? 0,
        renewalsDueIn30Days: renewalsDue,
        openPipelineValue: openPipeline._sum.estimatedValue ?? 0,
        openLeads: openPipeline._count._all,
      };
    }

    // ---- approvals waiting on the caller ----
    const approvals: Record<string, number> = {};
    if (ctx.has('deliverables.approve.internal')) {
      approvals.deliverablesInternal = await prisma.deliverable.count({
        where: { status: 'INTERNAL_REVIEW' },
      });
    }
    if (ctx.has('deliverables.view')) {
      approvals.awaitingClient = await prisma.deliverable.count({
        where: { status: 'CLIENT_REVIEW' },
      });
    }
    if (Object.keys(approvals).length) payload.approvals = approvals;

    // ---- shared context everyone gets ----
    const [holidays, onLeave] = await Promise.all([
      prisma.holiday.findMany({
        where: { date: { gte: today, lte: dayjs().add(30, 'day').toDate() } },
        orderBy: { date: 'asc' },
        take: 5,
      }),
      prisma.leaveRequest.findMany({
        where: { status: 'APPROVED', startDate: { lte: weekAhead }, endDate: { gte: today } },
        select: {
          id: true,
          startDate: true,
          endDate: true,
          leaveType: { select: { code: true } },
          employee: { select: { user: { select: { name: true } } } },
        },
        take: 15,
      }),
    ]);

    payload.upcomingHolidays = holidays;
    payload.whoIsOff = onLeave.map((l) => ({
      id: l.id,
      name: l.employee.user.name,
      from: l.startDate,
      to: l.endDate,
      type: l.leaveType.code,
    }));

    // ---- recent activity, only with log access ----
    if (ctx.has('logs.view')) {
      payload.recentActivity = await prisma.activityLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          action: true,
          summary: true,
          entityType: true,
          entityId: true,
          actorLabel: true,
          createdAt: true,
        },
      });
    }

    return ok(res, payload);
  }),
);

/** Lightweight counts for the sidebar badges. */
dashboardRouter.get(
  '/badges',
  asyncHandler(async (req, res) => {
    const ctx = req.ctx;
    const employeeId = ctx.employeeId ?? '__none__';
    const today = startOfDay(new Date());

    const [myOverdue, unread, pendingLeave, pendingTimesheets, clientReview] = await Promise.all([
      prisma.task.count({
        where: { assigneeId: employeeId, deletedAt: null, completedAt: null, dueDate: { lt: today } },
      }),
      prisma.notification.count({ where: { userId: ctx.user.id, readAt: null } }),
      ctx.has('leave.approve')
        ? prisma.leaveRequest.count({
            where: {
              status: 'PENDING',
              ...(ctx.has('leave.view.all') ? {} : { employee: { reportingToId: employeeId } }),
            },
          })
        : 0,
      ctx.has('timesheets.approve')
        ? prisma.timesheet.count({
            where: {
              status: 'SUBMITTED',
              ...(ctx.has('timesheets.view.all')
                ? {}
                : { employee: { reportingToId: employeeId } }),
            },
          })
        : 0,
      ctx.has('deliverables.view')
        ? prisma.deliverable.count({ where: { status: 'INTERNAL_REVIEW' } })
        : 0,
    ]);

    return ok(res, {
      overdueTasks: myOverdue,
      notifications: unread,
      leaveApprovals: pendingLeave,
      timesheetApprovals: pendingTimesheets,
      deliverableReviews: clientReview,
    });
  }),
);
