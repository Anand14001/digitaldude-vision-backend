import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { orderByFrom, pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { taskWhere } from '../../lib/scope';
import { nextSequence } from '../../lib/sequence';
import { defaultStatusId } from '../../lib/workflowRuntime';
import { notify } from '../../lib/notify';
import type { AuthContext } from '../../types/express';

export const tasksRouter = Router();

const SORTABLE = ['createdAt', 'dueDate', 'priority', 'title', 'sortOrder'] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const taskBody = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(8000).optional(),
  projectId: z.string().cuid().nullish(),
  retainerCycleId: z.string().cuid().nullish(),
  stageId: z.string().cuid().nullish(),
  statusId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().nullish(),
  parentTaskId: z.string().cuid().nullish(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  startDate: z.coerce.date().nullish(),
  dueDate: z.coerce.date().nullish(),
  estimateHours: z.coerce.number().min(0).max(1000).nullish(),
  visibleToClient: z.boolean().default(false),
  checklist: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
});

const listQuery = paginationSchema.extend({
  projectId: z.string().cuid().optional(),
  retainerCycleId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  statusId: z.string().cuid().optional(),
  stageId: z.string().cuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: z
    .enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED'])
    .optional(),
  /** Open tasks whose due date has passed. */
  overdue: z.coerce.boolean().optional(),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  /** Hide completed tasks. */
  openOnly: z.coerce.boolean().optional(),
  includeSubtasks: z.coerce.boolean().default(true),
});

const taskSelect = {
  id: true,
  reference: true,
  title: true,
  priority: true,
  startDate: true,
  dueDate: true,
  completedAt: true,
  estimateHours: true,
  sortOrder: true,
  visibleToClient: true,
  createdAt: true,
  status: { select: { id: true, name: true, color: true, category: true } },
  stage: { select: { id: true, name: true, color: true } },
  assignee: {
    select: {
      id: true,
      user: { select: { name: true, avatar: { select: { url: true } } } },
    },
  },
  project: { select: { id: true, code: true, name: true, client: { select: { name: true } } } },
  retainerCycle: {
    select: { id: true, label: true, retainer: { select: { name: true, client: { select: { name: true } } } } },
  },
  _count: { select: { subtasks: true, checklist: true, files: true } },
} as const;

/** Resolves the workflow a task hangs off, via its project or retainer cycle. */
async function resolveWorkflowId(input: {
  projectId?: string | null;
  retainerCycleId?: string | null;
  // clientId is null for an internal project, which has no client.
}): Promise<{ workflowId: string; clientId: string | null }> {
  if (input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, deletedAt: null },
      select: { workflowId: true, clientId: true },
    });
    if (!project) throw badRequest('That project does not exist');
    return { workflowId: project.workflowId, clientId: project.clientId };
  }
  if (input.retainerCycleId) {
    const cycle = await prisma.retainerCycle.findUnique({
      where: { id: input.retainerCycleId },
      select: { retainer: { select: { workflowId: true, clientId: true } } },
    });
    if (!cycle) throw badRequest('That retainer cycle does not exist');
    return { workflowId: cycle.retainer.workflowId, clientId: cycle.retainer.clientId };
  }
  throw badRequest('A task must belong to either a project or a retainer cycle');
}

/**
 * Write access to one task. `tasks.update` covers everything; a user with only
 * `tasks.update.assigned` may edit the tasks they are on, which is how
 * individual contributors work their own board.
 */
function assertCanEdit(ctx: AuthContext, task: { assigneeId: string | null }): void {
  if (ctx.has('tasks.update')) return;
  if (ctx.has('tasks.update.assigned') && task.assigneeId === ctx.employeeId) return;
  throw forbidden('You can only edit tasks assigned to you');
}

// -------------------------------------------------------------------- listing
tasksRouter.get(
  '/',
  requirePermission('tasks.view.all', 'tasks.view.assigned'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...taskWhere(req.ctx),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.retainerCycleId ? { retainerCycleId: q.retainerCycleId } : {}),
      ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
      ...(q.statusId ? { statusId: q.statusId } : {}),
      ...(q.stageId ? { stageId: q.stageId } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.category ? { status: { category: q.category } } : {}),
      ...(q.openOnly ? { completedAt: null } : {}),
      ...(q.overdue ? { completedAt: null, dueDate: { lt: new Date() } } : {}),
      ...(q.dueBefore || q.dueAfter
        ? {
            dueDate: {
              ...(q.dueBefore ? { lte: q.dueBefore } : {}),
              ...(q.dueAfter ? { gte: q.dueAfter } : {}),
            },
          }
        : {}),
      ...(q.includeSubtasks ? {} : { parentTaskId: null }),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' as const } },
              { reference: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.task.findMany({
        where,
        orderBy: orderByFrom(q.sort, q.order, SORTABLE, 'dueDate'),
        select: taskSelect,
        ...skipTake(q),
      }),
      prisma.task.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/** The signed-in user's own work queue, grouped for the employee dashboard. */
tasksRouter.get(
  '/my',
  requirePermission('tasks.view.assigned'),
  asyncHandler(async (req, res) => {
    const employeeId = req.ctx.employeeId;
    if (!employeeId) return ok(res, { overdue: [], today: [], upcoming: [], unscheduled: [] });

    const startOfTomorrow = new Date();
    startOfTomorrow.setHours(24, 0, 0, 0);

    const tasks = await prisma.task.findMany({
      where: {
        assigneeId: employeeId,
        deletedAt: null,
        completedAt: null,
        status: { category: { notIn: ['DONE', 'CANCELLED'] } },
      },
      orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }],
      select: taskSelect,
      take: 300,
    });

    const now = new Date();
    return ok(res, {
      overdue: tasks.filter((t) => t.dueDate && t.dueDate < now),
      today: tasks.filter(
        (t) => t.dueDate && t.dueDate >= now && t.dueDate < startOfTomorrow,
      ),
      upcoming: tasks.filter((t) => t.dueDate && t.dueDate >= startOfTomorrow),
      unscheduled: tasks.filter((t) => !t.dueDate),
    });
  }),
);

/** Board grouped by task status, for a project or retainer cycle. */
tasksRouter.get(
  '/board',
  requirePermission('tasks.view.all', 'tasks.view.assigned'),
  validate({
    query: z.object({
      projectId: z.string().cuid().optional(),
      retainerCycleId: z.string().cuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as { projectId?: string; retainerCycleId?: string };
    if (!q.projectId && !q.retainerCycleId) {
      throw badRequest('Provide either projectId or retainerCycleId');
    }

    const { workflowId } = await resolveWorkflowId(q);

    const [statuses, tasks] = await Promise.all([
      prisma.taskStatus.findMany({ where: { workflowId }, orderBy: { sortOrder: 'asc' } }),
      prisma.task.findMany({
        where: {
          ...taskWhere(req.ctx),
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.retainerCycleId ? { retainerCycleId: q.retainerCycleId } : {}),
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: taskSelect,
        take: 1000,
      }),
    ]);

    return ok(res, {
      columns: statuses.map((status) => ({
        status,
        tasks: tasks.filter((t) => t.status.id === status.id),
      })),
    });
  }),
);

// ---------------------------------------------------------------- single read
tasksRouter.get(
  '/:id',
  requirePermission('tasks.view.all', 'tasks.view.assigned'),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findFirst({
      where: { AND: [taskWhere(req.ctx), { id: req.params.id }] },
      include: {
        status: true,
        stage: true,
        assignee: {
          select: { id: true, user: { select: { name: true, email: true, avatar: { select: { url: true } } } } },
        },
        project: {
          select: {
            id: true,
            code: true,
            name: true,
            workflowId: true,
            client: { select: { id: true, name: true } },
          },
        },
        retainerCycle: {
          select: {
            id: true,
            label: true,
            retainer: { select: { id: true, name: true, workflowId: true } },
          },
        },
        parentTask: { select: { id: true, reference: true, title: true } },
        subtasks: { where: { deletedAt: null }, select: taskSelect },
        checklist: { orderBy: { sortOrder: 'asc' } },
        dependsOn: {
          include: {
            blockingTask: {
              select: { id: true, reference: true, title: true, completedAt: true },
            },
          },
        },
        blocking: {
          include: {
            task: { select: { id: true, reference: true, title: true, completedAt: true } },
          },
        },
        watchers: { include: { user: { select: { id: true, name: true } } } },
        files: {
          where: { deletedAt: null },
          select: { id: true, originalName: true, url: true, mimeType: true, sizeBytes: true, createdAt: true },
        },
        timeEntries: {
          orderBy: { workDate: 'desc' },
          take: 50,
          include: {
            employee: { select: { id: true, user: { select: { name: true } } } },
          },
        },
      },
    });
    if (!task) throw notFound('Task');

    const logged = await prisma.timeEntry.aggregate({
      where: { taskId: task.id },
      _sum: { hours: true },
    });

    return ok(res, { ...task, loggedHours: logged._sum.hours ?? 0 });
  }),
);

// --------------------------------------------------------------------- create
tasksRouter.post(
  '/',
  requirePermission('tasks.create'),
  validateBody(taskBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof taskBody>;
    if (!!body.projectId === !!body.retainerCycleId) {
      throw badRequest('A task must belong to exactly one of a project or a retainer cycle');
    }
    if (body.assigneeId && !req.ctx.has('tasks.assign') && body.assigneeId !== req.ctx.employeeId) {
      throw forbidden('You cannot assign tasks to other people');
    }

    const { workflowId } = await resolveWorkflowId(body);

    if (body.statusId) {
      const valid = await prisma.taskStatus.count({
        where: { id: body.statusId, workflowId },
      });
      if (!valid) throw badRequest('That status does not belong to this workflow');
    }

    const task = await prisma.$transaction(async (tx) => {
      const reference = await nextSequence('task', 'TSK', tx);
      const statusId = body.statusId ?? (await defaultStatusId(workflowId, tx));

      return tx.task.create({
        data: {
          reference,
          title: body.title,
          description: body.description ?? null,
          projectId: body.projectId ?? null,
          retainerCycleId: body.retainerCycleId ?? null,
          stageId: body.stageId ?? null,
          statusId,
          assigneeId: body.assigneeId ?? null,
          parentTaskId: body.parentTaskId ?? null,
          priority: body.priority,
          startDate: body.startDate ?? null,
          dueDate: body.dueDate ?? null,
          estimateHours: body.estimateHours ?? null,
          visibleToClient: body.visibleToClient,
          createdById: req.ctx.user.id,
          checklist: {
            create: body.checklist.map((label, index) => ({ label, sortOrder: index })),
          },
          watchers: { create: { userId: req.ctx.user.id } },
        },
        include: { status: true },
      });
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Task',
      entityId: task.id,
      entityLabel: `${task.reference} ${task.title}`,
      summary: `Created task ${task.reference} "${task.title}"`,
    });

    if (task.assigneeId) {
      const assignee = await prisma.employee.findUnique({
        where: { id: task.assigneeId },
        select: { userId: true },
      });
      if (assignee && assignee.userId !== req.ctx.user.id) {
        await notify({
          userIds: [assignee.userId],
          type: 'TASK_ASSIGNED',
          title: `New task: ${task.title}`,
          body: task.dueDate ? `Due ${task.dueDate.toDateString()}` : undefined,
          link: `/tasks/${task.id}`,
          entityType: 'Task',
          entityId: task.id,
          email: true,
        });
      }
    }

    return created(res, task);
  }),
);

// --------------------------------------------------------------------- update
tasksRouter.patch(
  '/:id',
  requirePermission('tasks.update', 'tasks.update.assigned'),
  validateBody(
    taskBody.partial().omit({ checklist: true, projectId: true, retainerCycleId: true }),
  ),
  asyncHandler(async (req, res) => {
    const before = await prisma.task.findFirst({
      where: { AND: [taskWhere(req.ctx), { id: req.params.id }] },
      include: { status: true },
    });
    if (!before) throw notFound('Task');
    assertCanEdit(req.ctx, before);

    const data = req.body as Partial<
      Omit<z.infer<typeof taskBody>, 'checklist' | 'projectId' | 'retainerCycleId'>
    >;

    if (
      data.assigneeId !== undefined &&
      data.assigneeId !== before.assigneeId &&
      !req.ctx.has('tasks.assign')
    ) {
      throw forbidden('You cannot reassign tasks');
    }

    const { workflowId } = await resolveWorkflowId({
      projectId: before.projectId,
      retainerCycleId: before.retainerCycleId,
    });

    let completedAt = before.completedAt;
    if (data.statusId && data.statusId !== before.statusId) {
      const status = await prisma.taskStatus.findFirst({
        where: { id: data.statusId, workflowId },
      });
      if (!status) throw badRequest('That status does not belong to this workflow');

      if (status.category === 'DONE' && !before.completedAt) {
        // Nothing may be completed while a blocking task is still open.
        const blockers = await prisma.taskDependency.count({
          where: {
            taskId: before.id,
            blockingTask: { completedAt: null, deletedAt: null },
          },
        });
        if (blockers) {
          throw conflict(`${blockers} blocking task(s) must be completed first`);
        }
        completedAt = new Date();
      } else if (status.category !== 'DONE') {
        completedAt = null;
      }
    }

    const task = await prisma.task.update({
      where: { id: before.id },
      data: { ...data, completedAt },
      include: { status: true },
    });

    await auditFromRequest(req, {
      action: data.statusId && data.statusId !== before.statusId ? 'STATUS_CHANGE' : 'UPDATE',
      entityType: 'Task',
      entityId: task.id,
      entityLabel: `${task.reference} ${task.title}`,
      summary:
        data.statusId && data.statusId !== before.statusId
          ? `Moved ${task.reference} from ${before.status.name} to ${task.status.name}`
          : `Updated task ${task.reference}`,
      diff: diffRecords(before, data as Record<string, unknown>) ?? undefined,
    });

    if (data.assigneeId && data.assigneeId !== before.assigneeId) {
      const assignee = await prisma.employee.findUnique({
        where: { id: data.assigneeId },
        select: { userId: true },
      });
      if (assignee && assignee.userId !== req.ctx.user.id) {
        await notify({
          userIds: [assignee.userId],
          type: 'TASK_ASSIGNED',
          title: `Assigned to you: ${task.title}`,
          link: `/tasks/${task.id}`,
          entityType: 'Task',
          entityId: task.id,
          email: true,
        });
      }
    }

    return ok(res, task);
  }),
);

/** Drag-and-drop on the board: new status plus new position. */
tasksRouter.post(
  '/:id/move',
  requirePermission('tasks.update', 'tasks.update.assigned'),
  validateBody(
    z.object({ statusId: z.string().cuid(), sortOrder: z.coerce.number().int().min(0).default(0) }),
  ),
  asyncHandler(async (req, res) => {
    const before = await prisma.task.findFirst({
      where: { AND: [taskWhere(req.ctx), { id: req.params.id }] },
      include: { status: true },
    });
    if (!before) throw notFound('Task');
    assertCanEdit(req.ctx, before);

    const { workflowId } = await resolveWorkflowId({
      projectId: before.projectId,
      retainerCycleId: before.retainerCycleId,
    });
    const status = await prisma.taskStatus.findFirst({
      where: { id: req.body.statusId, workflowId },
    });
    if (!status) throw badRequest('That status does not belong to this workflow');

    const task = await prisma.task.update({
      where: { id: before.id },
      data: {
        statusId: status.id,
        sortOrder: req.body.sortOrder,
        completedAt:
          status.category === 'DONE' ? (before.completedAt ?? new Date()) : null,
      },
      include: { status: true },
    });

    if (status.id !== before.statusId) {
      await auditFromRequest(req, {
        action: 'STATUS_CHANGE',
        entityType: 'Task',
        entityId: task.id,
        entityLabel: `${task.reference} ${task.title}`,
        summary: `Moved ${task.reference} from ${before.status.name} to ${status.name}`,
      });
    }

    return ok(res, task);
  }),
);

// ------------------------------------------------------------------ checklist
tasksRouter.post(
  '/:id/checklist',
  requirePermission('tasks.update', 'tasks.update.assigned'),
  validateBody(z.object({ label: z.string().trim().min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findFirst({
      where: { AND: [taskWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, assigneeId: true, _count: { select: { checklist: true } } },
    });
    if (!task) throw notFound('Task');
    assertCanEdit(req.ctx, task);

    const item = await prisma.taskChecklistItem.create({
      data: { taskId: task.id, label: req.body.label, sortOrder: task._count.checklist },
    });
    return created(res, item);
  }),
);

tasksRouter.patch(
  '/checklist/:itemId',
  requirePermission('tasks.update', 'tasks.update.assigned'),
  validateBody(
    z.object({
      label: z.string().trim().min(1).max(200).optional(),
      completed: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const item = await prisma.taskChecklistItem.findUnique({
      where: { id: req.params.itemId },
      include: { task: { select: { id: true, assigneeId: true } } },
    });
    if (!item) throw notFound('Checklist item');
    assertCanEdit(req.ctx, item.task);

    const updated = await prisma.taskChecklistItem.update({
      where: { id: item.id },
      data: {
        ...(req.body.label ? { label: req.body.label } : {}),
        ...(req.body.completed === undefined
          ? {}
          : { completedAt: req.body.completed ? new Date() : null }),
      },
    });
    return ok(res, updated);
  }),
);

tasksRouter.delete(
  '/checklist/:itemId',
  requirePermission('tasks.update', 'tasks.update.assigned'),
  asyncHandler(async (req, res) => {
    const item = await prisma.taskChecklistItem.findUnique({
      where: { id: req.params.itemId },
      include: { task: { select: { id: true, assigneeId: true } } },
    });
    if (!item) throw notFound('Checklist item');
    assertCanEdit(req.ctx, item.task);
    await prisma.taskChecklistItem.delete({ where: { id: item.id } });
    return noContent(res);
  }),
);

// --------------------------------------------------------------- dependencies
tasksRouter.post(
  '/:id/dependencies',
  requirePermission('tasks.update'),
  validateBody(
    z.object({
      blockingTaskId: z.string().cuid(),
      type: z
        .enum(['FINISH_TO_START', 'START_TO_START', 'FINISH_TO_FINISH'])
        .default('FINISH_TO_START'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const taskId = req.params.id as string;
    const { blockingTaskId } = req.body as { blockingTaskId: string };
    if (taskId === blockingTaskId) throw badRequest('A task cannot block itself');

    const [task, blocker] = await Promise.all([
      prisma.task.findFirst({
        where: { AND: [taskWhere(req.ctx), { id: taskId }] },
        select: { id: true, reference: true },
      }),
      prisma.task.findFirst({
        where: { AND: [taskWhere(req.ctx), { id: blockingTaskId }] },
        select: { id: true, reference: true },
      }),
    ]);
    if (!task || !blocker) throw notFound('Task');

    // Walk the existing chain so a cycle can never be introduced.
    const visited = new Set<string>([taskId]);
    const queue = [blockingTaskId];
    while (queue.length) {
      const current = queue.shift() as string;
      if (visited.has(current)) throw badRequest('That would create a circular dependency');
      visited.add(current);
      const next = await prisma.taskDependency.findMany({
        where: { taskId: current },
        select: { blockingTaskId: true },
      });
      queue.push(...next.map((d) => d.blockingTaskId));
    }

    const dependency = await prisma.taskDependency.create({
      data: { taskId, blockingTaskId, type: req.body.type },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Task',
      entityId: taskId,
      entityLabel: task.reference,
      summary: `${task.reference} now depends on ${blocker.reference}`,
    });

    return created(res, dependency);
  }),
);

tasksRouter.delete(
  '/dependencies/:dependencyId',
  requirePermission('tasks.update'),
  asyncHandler(async (req, res) => {
    await prisma.taskDependency.delete({ where: { id: req.params.dependencyId } });
    return noContent(res);
  }),
);

// -------------------------------------------------------------------- watchers
tasksRouter.post(
  '/:id/watch',
  requirePermission('tasks.view.all', 'tasks.view.assigned'),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findFirst({
      where: { AND: [taskWhere(req.ctx), { id: req.params.id }] },
      select: { id: true },
    });
    if (!task) throw notFound('Task');
    await prisma.taskWatcher.upsert({
      where: { taskId_userId: { taskId: task.id, userId: req.ctx.user.id } },
      create: { taskId: task.id, userId: req.ctx.user.id },
      update: {},
    });
    return created(res, { watching: true });
  }),
);

tasksRouter.delete(
  '/:id/watch',
  requirePermission('tasks.view.all', 'tasks.view.assigned'),
  asyncHandler(async (req, res) => {
    await prisma.taskWatcher.deleteMany({
      where: { taskId: req.params.id, userId: req.ctx.user.id },
    });
    return noContent(res);
  }),
);

// --------------------------------------------------------------------- delete
tasksRouter.delete(
  '/:id',
  requirePermission('tasks.delete'),
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, reference: true, title: true },
    });
    if (!task) throw notFound('Task');

    await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.task.update({ where: { id: task.id }, data: { deletedAt: now } });
      await tx.task.updateMany({
        where: { parentTaskId: task.id, deletedAt: null },
        data: { deletedAt: now },
      });
    });

    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Task',
      entityId: task.id,
      entityLabel: `${task.reference} ${task.title}`,
      summary: `Deleted task ${task.reference} "${task.title}"`,
    });

    return noContent(res);
  }),
);
