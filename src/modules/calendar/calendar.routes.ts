import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { auditFromRequest } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { projectWhere, taskWhere } from '../../lib/scope';
import { dayjs } from '../../lib/dates';
import { notify } from '../../lib/notify';

export const calendarRouter = Router();

const EVENT_TYPES = ['MEETING', 'SHOOT', 'CLIENT_CALL', 'INTERNAL', 'DEADLINE', 'OTHER'] as const;

const eventBody = z.object({
  title: z.string().trim().min(2).max(200),
  type: z.enum(EVENT_TYPES).default('MEETING'),
  description: z.string().trim().max(2000).optional(),
  location: z.string().trim().max(200).optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  allDay: z.boolean().default(false),
  projectId: z.string().cuid().nullish(),
  clientId: z.string().cuid().nullish(),
  attendeeUserIds: z.array(z.string().cuid()).max(100).default([]),
});

/**
 * One feed for everything with a date on it: events, task deadlines, project
 * milestones, retainer cycle ends, approved leave and holidays. The frontend
 * filters by `source`, so there is a single request per calendar view.
 */
calendarRouter.get(
  '/',
  requirePermission('calendar.view.own', 'calendar.view.all'),
  validate({
    query: z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      /** Restrict to one person; defaults to everything the caller may see. */
      employeeId: z.string().cuid().optional(),
      sources: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      from: Date;
      to: Date;
      employeeId?: string;
      sources?: string;
    };
    if (dayjs(q.to).diff(q.from, 'day') > 400) {
      throw badRequest('Keep the range under about a year');
    }

    const wanted = q.sources
      ? new Set(q.sources.split(',').map((s) => s.trim()))
      : new Set(['events', 'tasks', 'milestones', 'leave', 'holidays', 'cycles']);

    const seesEverything = req.ctx.has('calendar.view.all');
    const employeeId = q.employeeId ?? (seesEverything ? undefined : req.ctx.employeeId);

    const [events, tasks, milestones, leaves, holidays, cycles] = await Promise.all([
      wanted.has('events')
        ? prisma.calendarEvent.findMany({
            where: {
              startAt: { lte: q.to },
              endAt: { gte: q.from },
              ...(seesEverything
                ? {}
                : {
                    OR: [
                      { organizerId: req.ctx.user.id },
                      { attendees: { some: { userId: req.ctx.user.id } } },
                    ],
                  }),
            },
            include: {
              project: { select: { id: true, code: true, name: true } },
              client: { select: { id: true, name: true } },
              attendees: { include: { user: { select: { id: true, name: true } } } },
            },
          })
        : [],
      wanted.has('tasks')
        ? prisma.task.findMany({
            where: {
              ...taskWhere(req.ctx),
              dueDate: { gte: q.from, lte: q.to },
              ...(employeeId ? { assigneeId: employeeId } : {}),
            },
            select: {
              id: true,
              reference: true,
              title: true,
              dueDate: true,
              completedAt: true,
              priority: true,
              status: { select: { name: true, color: true, category: true } },
              project: { select: { id: true, code: true, name: true } },
              assignee: { select: { id: true, user: { select: { name: true } } } },
            },
            take: 1000,
          })
        : [],
      wanted.has('milestones')
        ? prisma.milestone.findMany({
            where: { dueDate: { gte: q.from, lte: q.to }, project: projectWhere(req.ctx) },
            include: { project: { select: { id: true, code: true, name: true } } },
          })
        : [],
      wanted.has('leave')
        ? prisma.leaveRequest.findMany({
            where: {
              status: 'APPROVED',
              startDate: { lte: q.to },
              endDate: { gte: q.from },
              ...(employeeId && !seesEverything ? { employeeId } : {}),
            },
            select: {
              id: true,
              startDate: true,
              endDate: true,
              leaveType: { select: { name: true, code: true } },
              employee: { select: { id: true, user: { select: { name: true } } } },
            },
          })
        : [],
      wanted.has('holidays')
        ? prisma.holiday.findMany({ where: { date: { gte: q.from, lte: q.to } } })
        : [],
      wanted.has('cycles')
        ? prisma.retainerCycle.findMany({
            where: { periodEnd: { gte: q.from, lte: q.to } },
            select: {
              id: true,
              label: true,
              periodEnd: true,
              status: true,
              retainer: { select: { id: true, name: true, client: { select: { name: true } } } },
            },
          })
        : [],
    ]);

    // Normalised shape so the calendar component renders one kind of item.
    const items = [
      ...events.map((e) => ({
        source: 'event' as const,
        id: e.id,
        title: e.title,
        start: e.startAt,
        end: e.endAt,
        allDay: e.allDay,
        color: e.type === 'SHOOT' ? '#f59e0b' : e.type === 'CLIENT_CALL' ? '#06b6d4' : '#6366f1',
        meta: {
          type: e.type,
          location: e.location,
          project: e.project,
          client: e.client,
          attendees: e.attendees.map((a) => a.user.name),
        },
      })),
      ...tasks.map((t) => ({
        source: 'task' as const,
        id: t.id,
        title: `${t.reference} ${t.title}`,
        start: t.dueDate as Date,
        end: t.dueDate as Date,
        allDay: true,
        color: t.completedAt ? '#22c55e' : (t.status.color ?? '#64748b'),
        meta: {
          project: t.project,
          assignee: t.assignee?.user.name ?? null,
          priority: t.priority,
          done: Boolean(t.completedAt),
        },
      })),
      ...milestones.map((m) => ({
        source: 'milestone' as const,
        id: m.id,
        title: m.title,
        start: m.dueDate,
        end: m.dueDate,
        allDay: true,
        color: m.completedAt ? '#22c55e' : '#a855f7',
        meta: { project: m.project, done: Boolean(m.completedAt) },
      })),
      ...leaves.map((l) => ({
        source: 'leave' as const,
        id: l.id,
        title: `${l.employee.user.name} - ${l.leaveType.code}`,
        start: l.startDate,
        end: l.endDate,
        allDay: true,
        color: '#94a3b8',
        meta: { employee: l.employee.user.name, leaveType: l.leaveType.name },
      })),
      ...holidays.map((h) => ({
        source: 'holiday' as const,
        id: h.id,
        title: h.name,
        start: h.date,
        end: h.date,
        allDay: true,
        color: '#f43f5e',
        meta: { optional: h.isOptional },
      })),
      ...cycles.map((c) => ({
        source: 'cycle' as const,
        id: c.id,
        title: `${c.retainer.name} - ${c.label} ends`,
        start: c.periodEnd,
        end: c.periodEnd,
        allDay: true,
        color: '#0ea5e9',
        meta: { client: c.retainer.client.name, status: c.status },
      })),
    ].sort((a, b) => a.start.getTime() - b.start.getTime());

    return ok(res, { from: q.from, to: q.to, items });
  }),
);

calendarRouter.post(
  '/events',
  requirePermission('calendar.manage'),
  validateBody(eventBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof eventBody>;
    if (body.endAt <= body.startAt) throw badRequest('The end time must be after the start');

    const event = await prisma.calendarEvent.create({
      data: {
        title: body.title,
        type: body.type,
        description: body.description ?? null,
        location: body.location ?? null,
        startAt: body.startAt,
        endAt: body.endAt,
        allDay: body.allDay,
        projectId: body.projectId ?? null,
        clientId: body.clientId ?? null,
        organizerId: req.ctx.user.id,
        attendees: {
          create: [...new Set([...body.attendeeUserIds, req.ctx.user.id])].map((userId) => ({
            userId,
            response: userId === req.ctx.user.id ? 'ACCEPTED' : 'INVITED',
          })),
        },
      },
      include: { attendees: { include: { user: { select: { id: true, name: true } } } } },
    });

    await notify({
      userIds: body.attendeeUserIds.filter((id) => id !== req.ctx.user.id),
      type: 'SYSTEM',
      title: `${event.title} - ${dayjs(event.startAt).format('DD MMM, h:mm A')}`,
      body: event.location ? `Location: ${event.location}` : undefined,
      link: '/calendar',
      email: true,
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'CalendarEvent',
      entityId: event.id,
      entityLabel: event.title,
      summary: `Scheduled "${event.title}" on ${dayjs(event.startAt).format('DD MMM YYYY')}`,
    });

    return created(res, event);
  }),
);

calendarRouter.patch(
  '/events/:id',
  requirePermission('calendar.manage'),
  validateBody(eventBody.partial()),
  asyncHandler(async (req, res) => {
    const event = await prisma.calendarEvent.findUnique({ where: { id: req.params.id } });
    if (!event) throw notFound('Event');
    // Only the organiser (or a full-calendar admin) may change an event.
    if (event.organizerId !== req.ctx.user.id && !req.ctx.has('calendar.view.all')) {
      throw forbidden('Only the organiser can change this event');
    }

    const { attendeeUserIds, ...data } = req.body as Partial<z.infer<typeof eventBody>>;

    const updated = await prisma.$transaction(async (tx) => {
      if (attendeeUserIds) {
        await tx.eventAttendee.deleteMany({ where: { eventId: event.id } });
        await tx.eventAttendee.createMany({
          data: [...new Set([...attendeeUserIds, event.organizerId ?? req.ctx.user.id])].map(
            (userId) => ({ eventId: event.id, userId }),
          ),
        });
      }
      return tx.calendarEvent.update({
        where: { id: event.id },
        data: data as Record<string, never>,
        include: { attendees: { include: { user: { select: { id: true, name: true } } } } },
      });
    });

    return ok(res, updated);
  }),
);

calendarRouter.post(
  '/events/:id/respond',
  requirePermission('calendar.view.own'),
  validateBody(z.object({ response: z.enum(['ACCEPTED', 'DECLINED', 'TENTATIVE']) })),
  asyncHandler(async (req, res) => {
    const attendee = await prisma.eventAttendee.findUnique({
      where: { eventId_userId: { eventId: req.params.id as string, userId: req.ctx.user.id } },
    });
    if (!attendee) throw notFound('Invitation');

    const updated = await prisma.eventAttendee.update({
      where: { eventId_userId: { eventId: attendee.eventId, userId: req.ctx.user.id } },
      data: { response: req.body.response },
    });
    return ok(res, updated);
  }),
);

calendarRouter.delete(
  '/events/:id',
  requirePermission('calendar.manage'),
  asyncHandler(async (req, res) => {
    const event = await prisma.calendarEvent.findUnique({
      where: { id: req.params.id },
      include: { attendees: { select: { userId: true } } },
    });
    if (!event) throw notFound('Event');
    if (event.organizerId !== req.ctx.user.id && !req.ctx.has('calendar.view.all')) {
      throw forbidden('Only the organiser can cancel this event');
    }

    await prisma.calendarEvent.delete({ where: { id: event.id } });

    await notify({
      userIds: event.attendees.map((a) => a.userId).filter((id) => id !== req.ctx.user.id),
      type: 'SYSTEM',
      title: `Cancelled: ${event.title}`,
      body: dayjs(event.startAt).format('DD MMM YYYY, h:mm A'),
    });

    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'CalendarEvent',
      entityId: event.id,
      entityLabel: event.title,
      summary: `Cancelled event "${event.title}"`,
    });

    return noContent(res);
  }),
);
