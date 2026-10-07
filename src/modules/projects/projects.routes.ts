import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { orderByFrom, pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { projectWhere } from '../../lib/scope';
import { nextSequence } from '../../lib/sequence';
import { deriveHealth, firstStageOf, seedStageTasks } from '../../lib/workflowRuntime';
import { notify } from '../../lib/notify';

export const projectsRouter = Router();

const SORTABLE = ['createdAt', 'name', 'dueDate', 'status', 'priority', 'code'] as const;
const STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const KINDS = ['CLIENT', 'INTERNAL'] as const;

const projectBody = z.object({
  name: z.string().trim().min(2).max(160),
  kind: z.enum(KINDS).default('CLIENT'),
  /// Required when kind is CLIENT, rejected when it is INTERNAL.
  clientId: z.string().cuid().nullish(),
  projectTypeId: z.string().cuid().nullish(),
  serviceLineId: z.string().cuid().nullish(),
  workflowId: z.string().cuid(),
  managerId: z.string().cuid().nullish(),
  status: z.enum(STATUSES).default('PLANNING'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  description: z.string().trim().max(4000).optional(),
  startDate: z.coerce.date().nullish(),
  dueDate: z.coerce.date().nullish(),
  budgetAmount: z.coerce.number().min(0).max(1_000_000_000).nullish(),
  estimateHours: z.coerce.number().min(0).max(100_000).nullish(),
  visibleToClient: z.boolean().default(true),
  memberIds: z.array(z.string().cuid()).max(50).default([]),
  /** Create the first stage's checklist tasks straight away. */
  seedDefaultTasks: z.boolean().default(true),
});

/**
 * A client project must name its client; an agency-internal project must not.
 * Checked here rather than in the schema so both create and update share it and
 * the message is the same either way.
 */
function assertKindAndClientAgree(kind: 'CLIENT' | 'INTERNAL', clientId: string | null | undefined) {
  if (kind === 'CLIENT' && !clientId) {
    throw badRequest('Choose the client this project is for, or mark it as internal');
  }
  if (kind === 'INTERNAL' && clientId) {
    throw badRequest('An internal project cannot belong to a client');
  }
}

const listQuery = paginationSchema.extend({
  kind: z.enum(KINDS).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  clientId: z.string().cuid().optional(),
  managerId: z.string().cuid().optional(),
  serviceLineId: z.string().cuid().optional(),
  projectTypeId: z.string().cuid().optional(),
  stageId: z.string().cuid().optional(),
  health: z.enum(['ON_TRACK', 'AT_RISK', 'OFF_TRACK']).optional(),
  /** Projects due on or before this date. */
  dueBefore: z.coerce.date().optional(),
  memberId: z.string().cuid().optional(),
});

const listSelect = {
  id: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  priority: true,
  health: true,
  startDate: true,
  dueDate: true,
  visibleToClient: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
  currentStage: { select: { id: true, name: true, color: true } },
  serviceLine: { select: { id: true, name: true } },
  manager: { select: { id: true, user: { select: { name: true } } } },
  members: {
    select: {
      employee: {
        select: { id: true, user: { select: { name: true, avatar: { select: { url: true } } } } },
      },
    },
  },
  _count: { select: { tasks: true, deliverables: true } },
} as const;

// -------------------------------------------------------------------- listing
projectsRouter.get(
  '/',
  requirePermission('projects.view.all', 'projects.view.assigned'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...projectWhere(req.ctx),
      ...(q.status ? { status: q.status } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.managerId ? { managerId: q.managerId } : {}),
      ...(q.serviceLineId ? { serviceLineId: q.serviceLineId } : {}),
      ...(q.projectTypeId ? { projectTypeId: q.projectTypeId } : {}),
      ...(q.stageId ? { currentStageId: q.stageId } : {}),
      ...(q.health ? { health: q.health } : {}),
      ...(q.dueBefore ? { dueDate: { lte: q.dueBefore } } : {}),
      ...(q.memberId ? { members: { some: { employeeId: q.memberId } } } : {}),
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
      prisma.project.findMany({
        where,
        orderBy: orderByFrom(q.sort, q.order, SORTABLE, 'createdAt'),
        select: listSelect,
        ...skipTake(q),
      }),
      prisma.project.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/** Kanban of projects grouped by their workflow stage. */
projectsRouter.get(
  '/board',
  requirePermission('projects.view.all', 'projects.view.assigned'),
  validate({ query: z.object({ workflowId: z.string().cuid() }) }),
  asyncHandler(async (req, res) => {
    const { workflowId } = req.query as unknown as { workflowId: string };

    const [stages, projects] = await Promise.all([
      prisma.workflowStage.findMany({
        where: { workflowId },
        orderBy: { sortOrder: 'asc' },
      }),
      prisma.project.findMany({
        where: {
          ...projectWhere(req.ctx),
          workflowId,
          status: { notIn: ['CANCELLED'] },
        },
        select: listSelect,
        orderBy: { priority: 'desc' },
        take: 500,
      }),
    ]);

    return ok(res, {
      stages: stages.map((stage) => ({
        ...stage,
        projects: projects.filter((p) => p.currentStage?.id === stage.id),
      })),
      unstaged: projects.filter((p) => !p.currentStage),
    });
  }),
);

// ---------------------------------------------------------------- single read
projectsRouter.get(
  '/:id',
  requirePermission('projects.view.all', 'projects.view.assigned'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { AND: [projectWhere(req.ctx), { id: req.params.id }] },
      include: {
        client: { select: { id: true, name: true, logo: { select: { url: true } } } },
        projectType: { select: { id: true, name: true } },
        serviceLine: { select: { id: true, name: true } },
        currentStage: true,
        manager: {
          select: { id: true, user: { select: { name: true, email: true } } },
        },
        workflow: {
          include: {
            stages: { orderBy: { sortOrder: 'asc' } },
            taskStatuses: { orderBy: { sortOrder: 'asc' } },
          },
        },
        members: {
          orderBy: [{ isLead: 'desc' }, { addedAt: 'asc' }],
          include: {
            roles: {
              orderBy: { role: { sortOrder: 'asc' } },
              include: { role: { select: { id: true, name: true, color: true } } },
            },
            employee: {
              select: {
                id: true,
                employeeCode: true,
                designation: { select: { title: true } },
                user: { select: { name: true, email: true, avatar: { select: { url: true } } } },
              },
            },
          },
        },
        milestones: { orderBy: { dueDate: 'asc' } },
        stageHistory: {
          orderBy: { enteredAt: 'desc' },
          take: 30,
          include: { stage: { select: { name: true, color: true } } },
        },
        _count: { select: { tasks: true, deliverables: true, files: true } },
      },
    });
    if (!project) throw notFound('Project');

    const [statusBreakdown, loggedHours] = await Promise.all([
      prisma.task.groupBy({
        by: ['statusId'],
        where: { projectId: project.id, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.timeEntry.aggregate({
        where: { projectId: project.id },
        _sum: { hours: true },
      }),
    ]);

    const payload: Record<string, unknown> = {
      ...project,
      taskBreakdown: statusBreakdown,
      loggedHours: loggedHours._sum.hours ?? 0,
    };

    // Budget is a separate clearance from seeing the project itself.
    if (!req.ctx.has('projects.budget.view') && !req.ctx.has('reports.financial.view')) {
      delete payload.budgetAmount;
    }

    return ok(res, payload);
  }),
);

// --------------------------------------------------------------------- create
projectsRouter.post(
  '/',
  requirePermission('projects.create'),
  validateBody(projectBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof projectBody>;
    assertKindAndClientAgree(body.kind, body.clientId);

    const [client, workflow] = await Promise.all([
      body.clientId
        ? prisma.client.findFirst({
            where: { id: body.clientId, deletedAt: null },
            select: { id: true, name: true },
          })
        : null,
      prisma.workflowTemplate.findUnique({
        where: { id: body.workflowId },
        select: { id: true, isArchived: true },
      }),
    ]);
    if (body.clientId && !client) throw badRequest('That client does not exist');
    if (!workflow) throw badRequest('That workflow does not exist');
    if (workflow.isArchived) throw badRequest('That workflow has been archived');

    const project = await prisma.$transaction(async (tx) => {
      const code = await nextSequence('project', 'PRJ', tx);
      const stage = await firstStageOf(body.workflowId, tx);

      const createdProject = await tx.project.create({
        data: {
          code,
          name: body.name,
          kind: body.kind,
          clientId: body.kind === 'INTERNAL' ? null : (body.clientId ?? null),
          projectTypeId: body.projectTypeId ?? null,
          serviceLineId: body.serviceLineId ?? null,
          workflowId: body.workflowId,
          currentStageId: stage?.id ?? null,
          managerId: body.managerId ?? null,
          status: body.status,
          priority: body.priority,
          description: body.description ?? null,
          startDate: body.startDate ?? null,
          dueDate: body.dueDate ?? null,
          budgetAmount: body.budgetAmount ?? null,
          estimateHours: body.estimateHours ?? null,
          // Internal work is never shown in a portal, whatever was ticked.
          visibleToClient: body.kind === 'INTERNAL' ? false : body.visibleToClient,
          members: {
            create: [...new Set(body.memberIds)].map((employeeId) => ({
              employeeId,
              isLead: employeeId === body.managerId,
            })),
          },
        },
      });

      if (stage) {
        await tx.projectStageHistory.create({
          data: {
            projectId: createdProject.id,
            stageId: stage.id,
            movedById: req.ctx.user.id,
            note: 'Project created',
          },
        });

        if (body.seedDefaultTasks) {
          await seedStageTasks({
            tx,
            stageId: stage.id,
            workflowId: body.workflowId,
            projectId: createdProject.id,
            anchorDate: body.startDate ?? new Date(),
            createdById: req.ctx.user.id,
          });
        }
      }

      return createdProject;
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: `${project.code} ${project.name}`,
      summary: client
        ? `Created project ${project.code} "${project.name}" for ${client.name}`
        : `Created internal project ${project.code} "${project.name}"`,
    });

    // Tell the team they are on it.
    if (body.memberIds.length || body.managerId) {
      const employeeIds = [...new Set([...body.memberIds, body.managerId].filter(Boolean))] as string[];
      const users = await prisma.employee.findMany({
        where: { id: { in: employeeIds } },
        select: { userId: true },
      });
      await notify({
        userIds: users.map((u) => u.userId).filter((id) => id !== req.ctx.user.id),
        type: 'SYSTEM',
        title: `You were added to ${project.name}`,
        body: client ? `${client.name} - ${project.code}` : `Internal - ${project.code}`,
        link: `/projects/${project.id}`,
        entityType: 'Project',
        entityId: project.id,
      });
    }

    return created(res, project);
  }),
);

// --------------------------------------------------------------------- update
projectsRouter.patch(
  '/:id',
  requirePermission('projects.update'),
  validateBody(projectBody.partial().omit({ memberIds: true, seedDefaultTasks: true })),
  asyncHandler(async (req, res) => {
    const before = await prisma.project.findFirst({
      where: { AND: [projectWhere(req.ctx), { id: req.params.id }] },
    });
    if (!before) throw notFound('Project');

    const data = req.body as Partial<z.infer<typeof projectBody>>;

    // A project can be reclassified, but the result must still be coherent.
    const nextKind = data.kind ?? before.kind;
    const nextClientId =
      data.clientId !== undefined ? data.clientId : before.clientId;
    assertKindAndClientAgree(nextKind, nextClientId);

    if (data.workflowId && data.workflowId !== before.workflowId) {
      throw badRequest(
        'A project cannot be moved to a different workflow once it has started',
      );
    }
    if (data.budgetAmount !== undefined && !req.ctx.has('projects.budget.view')) {
      throw forbidden('You cannot change the budget');
    }

    const project = await prisma.project.update({
      where: { id: before.id },
      data: {
        ...data,
        workflowId: undefined,
        kind: nextKind,
        clientId: nextKind === 'INTERNAL' ? null : nextClientId,
        // Internal work never surfaces in a portal.
        ...(nextKind === 'INTERNAL' ? { visibleToClient: false } : {}),
        ...(data.status === 'COMPLETED' && before.status !== 'COMPLETED'
          ? { completedAt: new Date() }
          : {}),
        ...(data.status && data.status !== 'COMPLETED' ? { completedAt: null } : {}),
      },
    });

    await auditFromRequest(req, {
      action: data.status && data.status !== before.status ? 'STATUS_CHANGE' : 'UPDATE',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: `${project.code} ${project.name}`,
      summary: `Updated project ${project.code}`,
      diff: diffRecords(before, data as Record<string, unknown>) ?? undefined,
    });

    return ok(res, project);
  }),
);

// ----------------------------------------------------------------- stage move
/**
 * Free movement between stages by design - the workflow defines the stages, not
 * a transition rule set. Entering a stage seeds its default tasks and closes off
 * the previous stage's history row so cycle-time reporting works.
 */
projectsRouter.post(
  '/:id/stage',
  requirePermission('projects.stage.move'),
  validateBody(
    z.object({
      stageId: z.string().cuid(),
      note: z.string().trim().max(500).optional(),
      seedDefaultTasks: z.boolean().default(true),
    }),
  ),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { AND: [projectWhere(req.ctx), { id: req.params.id }] },
      include: { currentStage: { select: { id: true, name: true } } },
    });
    if (!project) throw notFound('Project');

    const stage = await prisma.workflowStage.findFirst({
      where: { id: req.body.stageId, workflowId: project.workflowId },
    });
    if (!stage) throw badRequest('That stage does not belong to this project’s workflow');
    if (stage.id === project.currentStageId) {
      return ok(res, { unchanged: true, stage });
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.projectStageHistory.updateMany({
        where: { projectId: project.id, stageId: project.currentStageId ?? undefined, exitedAt: null },
        data: { exitedAt: now },
      });
      await tx.projectStageHistory.create({
        data: {
          projectId: project.id,
          stageId: stage.id,
          enteredAt: now,
          movedById: req.ctx.user.id,
          note: req.body.note ?? null,
        },
      });

      if (req.body.seedDefaultTasks) {
        await seedStageTasks({
          tx,
          stageId: stage.id,
          workflowId: project.workflowId,
          projectId: project.id,
          anchorDate: now,
          createdById: req.ctx.user.id,
        });
      }

      return tx.project.update({
        where: { id: project.id },
        data: {
          currentStageId: stage.id,
          // Reaching a terminal stage completes the project.
          ...(stage.isTerminal
            ? { status: 'COMPLETED', completedAt: now }
            : project.status === 'PLANNING'
              ? { status: 'ACTIVE' }
              : {}),
        },
        include: { currentStage: true },
      });
    });

    await auditFromRequest(req, {
      action: 'STAGE_CHANGE',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: `${project.code} ${project.name}`,
      summary: `Moved ${project.code} from ${project.currentStage?.name ?? 'no stage'} to ${stage.name}`,
      diff: { stage: { from: project.currentStage?.name ?? null, to: stage.name } },
    });

    const members = await prisma.projectMember.findMany({
      where: { projectId: project.id },
      select: { employee: { select: { userId: true } } },
    });
    await notify({
      userIds: members
        .map((m) => m.employee.userId)
        .filter((id) => id !== req.ctx.user.id),
      type: 'PROJECT_STAGE_CHANGED',
      title: `${project.name} moved to ${stage.name}`,
      body: req.body.note,
      link: `/projects/${project.id}`,
      entityType: 'Project',
      entityId: project.id,
    });

    return ok(res, updated);
  }),
);

// -------------------------------------------------------------------- members
projectsRouter.put(
  '/:id/members',
  requirePermission('projects.members.manage'),
  validateBody(
    z.object({
      members: z
        .array(
          z.object({
            employeeId: z.string().cuid(),
            /// At most one member may be the lead.
            isLead: z.boolean().default(false),
            /// Any number of admin-defined labels: Video Editor, QA, Copywriter.
            roleIds: z.array(z.string().cuid()).max(10).default([]),
            allocationHours: z.coerce.number().min(0).max(80).nullish(),
          }),
        )
        .max(50),
    }),
  ),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { AND: [projectWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, code: true, name: true },
    });
    if (!project) throw notFound('Project');

    const members = req.body.members as {
      employeeId: string;
      isLead: boolean;
      roleIds: string[];
      allocationHours?: number | null;
    }[];

    const leads = members.filter((member) => member.isLead);
    if (leads.length > 1) {
      throw badRequest('A project can have only one lead');
    }

    // Reject unknown or retired roles rather than silently dropping them.
    const requestedRoleIds = [...new Set(members.flatMap((member) => member.roleIds))];
    if (requestedRoleIds.length) {
      const known = await prisma.projectRole.count({
        where: { id: { in: requestedRoleIds }, active: true },
      });
      if (known !== requestedRoleIds.length) {
        throw badRequest('One or more project roles do not exist or are no longer active');
      }
    }

    const existing = await prisma.projectMember.findMany({
      where: { projectId: project.id },
      select: { employeeId: true },
    });
    const existingIds = new Set(existing.map((m) => m.employeeId));
    const nextIds = new Set(members.map((m) => m.employeeId));
    const removed = [...existingIds].filter((id) => !nextIds.has(id));

    if (removed.length) {
      // Someone still holding open tasks should not silently lose access.
      const openTasks = await prisma.task.count({
        where: {
          projectId: project.id,
          assigneeId: { in: removed },
          deletedAt: null,
          completedAt: null,
        },
      });
      if (openTasks) {
        throw conflict(
          `${openTasks} open task(s) are still assigned to someone you are removing - reassign them first`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.projectMember.deleteMany({
        where: { projectId: project.id, employeeId: { in: removed } },
      });
      for (const member of members) {
        const saved = await tx.projectMember.upsert({
          where: {
            projectId_employeeId: { projectId: project.id, employeeId: member.employeeId },
          },
          create: {
            projectId: project.id,
            employeeId: member.employeeId,
            isLead: member.isLead,
            allocationHours: member.allocationHours ?? null,
          },
          update: {
            isLead: member.isLead,
            allocationHours: member.allocationHours ?? null,
          },
        });

        // Roles are a small set, rewritten wholesale so removals take effect.
        await tx.projectMemberRole.deleteMany({ where: { projectMemberId: saved.id } });
        if (member.roleIds.length) {
          await tx.projectMemberRole.createMany({
            data: [...new Set(member.roleIds)].map((projectRoleId) => ({
              projectMemberId: saved.id,
              projectRoleId,
            })),
          });
        }
      }
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: `${project.code} ${project.name}`,
      summary: `Updated the team on ${project.code} (${members.length} member(s))`,
    });

    const added = members.filter((m) => !existingIds.has(m.employeeId));
    if (added.length) {
      const users = await prisma.employee.findMany({
        where: { id: { in: added.map((m) => m.employeeId) } },
        select: { userId: true },
      });
      await notify({
        userIds: users.map((u) => u.userId).filter((id) => id !== req.ctx.user.id),
        type: 'SYSTEM',
        title: `You were added to ${project.name}`,
        link: `/projects/${project.id}`,
      });
    }

    const result = await prisma.projectMember.findMany({
      where: { projectId: project.id },
      include: {
        employee: { select: { id: true, user: { select: { name: true } } } },
        roles: { include: { role: true } },
      },
    });
    return ok(res, result);
  }),
);

// ----------------------------------------------------------------- milestones
projectsRouter.post(
  '/:id/milestones',
  requirePermission('projects.update'),
  validateBody(
    z.object({
      title: z.string().trim().min(2).max(160),
      dueDate: z.coerce.date(),
      description: z.string().trim().max(1000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { AND: [projectWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, code: true },
    });
    if (!project) throw notFound('Project');

    const milestone = await prisma.milestone.create({
      data: { ...req.body, projectId: project.id },
    });
    return created(res, milestone);
  }),
);

projectsRouter.patch(
  '/milestones/:milestoneId',
  requirePermission('projects.update'),
  validateBody(
    z.object({
      title: z.string().trim().min(2).max(160).optional(),
      dueDate: z.coerce.date().optional(),
      description: z.string().trim().max(1000).nullish(),
      completed: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { completed, ...rest } = req.body as {
      completed?: boolean;
      title?: string;
      dueDate?: Date;
      description?: string | null;
    };
    const milestone = await prisma.milestone.update({
      where: { id: req.params.milestoneId },
      data: {
        ...rest,
        ...(completed === undefined ? {} : { completedAt: completed ? new Date() : null }),
      },
    });
    return ok(res, milestone);
  }),
);

projectsRouter.delete(
  '/milestones/:milestoneId',
  requirePermission('projects.update'),
  asyncHandler(async (req, res) => {
    await prisma.milestone.delete({ where: { id: req.params.milestoneId } });
    return noContent(res);
  }),
);

/** Recomputes health from live task data; called by the nightly job and on demand. */
projectsRouter.post(
  '/:id/recalculate-health',
  requirePermission('projects.update'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { AND: [projectWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, dueDate: true },
    });
    if (!project) throw notFound('Project');

    const [total, done, overdue] = await Promise.all([
      prisma.task.count({ where: { projectId: project.id, deletedAt: null } }),
      prisma.task.count({
        where: { projectId: project.id, deletedAt: null, completedAt: { not: null } },
      }),
      prisma.task.count({
        where: {
          projectId: project.id,
          deletedAt: null,
          completedAt: null,
          dueDate: { lt: new Date() },
        },
      }),
    ]);

    const health = deriveHealth({
      dueDate: project.dueDate,
      openOverdueTasks: overdue,
      totalTasks: total,
      doneTasks: done,
    });

    await prisma.project.update({ where: { id: project.id }, data: { health } });
    return ok(res, { health, totalTasks: total, doneTasks: done, overdueTasks: overdue });
  }),
);

projectsRouter.delete(
  '/:id',
  requirePermission('projects.delete'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, code: true, name: true },
    });
    if (!project) throw notFound('Project');

    // Soft delete so time entries and the audit trail keep their references.
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.project.update({ where: { id: project.id }, data: { deletedAt: now } });
      await tx.task.updateMany({
        where: { projectId: project.id, deletedAt: null },
        data: { deletedAt: now },
      });
    });

    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Project',
      entityId: project.id,
      entityLabel: `${project.code} ${project.name}`,
      summary: `Archived project ${project.code} "${project.name}"`,
    });

    return noContent(res);
  }),
);
