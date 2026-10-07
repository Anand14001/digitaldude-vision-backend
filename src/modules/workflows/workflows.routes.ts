import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

export const workflowsRouter = Router();

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #4f46e5');

const stageInput = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2).max(60),
  color: hex.default('#6366f1'),
  isTerminal: z.boolean().default(false),
  isClientFacing: z.boolean().default(false),
  description: z.string().trim().max(400).optional(),
  defaultTasks: z
    .array(
      z.object({
        id: z.string().cuid().optional(),
        title: z.string().trim().min(2).max(160),
        description: z.string().trim().max(1000).optional(),
        estimateHours: z.coerce.number().min(0).max(999).optional(),
        dueOffsetDays: z.coerce.number().int().min(0).max(365).default(0),
      }),
    )
    .max(50)
    .default([]),
});

const statusInput = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(2).max(40),
  category: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED']),
  color: hex.default('#64748b'),
  isDefault: z.boolean().default(false),
});

const workflowBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  projectTypeId: z.string().cuid().nullish(),
  stages: z.array(stageInput).min(1, 'A workflow needs at least one stage').max(30),
  taskStatuses: z
    .array(statusInput)
    .min(1, 'A workflow needs at least one task status')
    .max(20),
});

const includeFull = {
  projectType: { select: { id: true, name: true } },
  stages: {
    orderBy: { sortOrder: 'asc' as const },
    include: { defaultTasks: { orderBy: { sortOrder: 'asc' as const } } },
  },
  taskStatuses: { orderBy: { sortOrder: 'asc' as const } },
  _count: { select: { projects: true, retainers: true } },
};

/** Exactly one task status must be the default a new task lands on. */
function assertOneDefaultStatus(statuses: z.infer<typeof statusInput>[]) {
  const defaults = statuses.filter((s) => s.isDefault);
  if (defaults.length !== 1) {
    throw badRequest('Mark exactly one task status as the default for new tasks');
  }
  if (!statuses.some((s) => s.category === 'DONE')) {
    throw badRequest('A workflow needs at least one status in the Done category');
  }
}

workflowsRouter.get(
  '/',
  requirePermission(
    'settings.workflows.manage',
    'projects.view.all',
    'projects.view.assigned',
  ),
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    const workflows = await prisma.workflowTemplate.findMany({
      where: includeArchived ? {} : { isArchived: false },
      orderBy: { name: 'asc' },
      include: includeFull,
    });
    return ok(res, workflows);
  }),
);

workflowsRouter.get(
  '/:id',
  requirePermission(
    'settings.workflows.manage',
    'projects.view.all',
    'projects.view.assigned',
  ),
  asyncHandler(async (req, res) => {
    const workflow = await prisma.workflowTemplate.findUnique({
      where: { id: req.params.id },
      include: includeFull,
    });
    if (!workflow) throw notFound('Workflow');
    return ok(res, workflow);
  }),
);

workflowsRouter.post(
  '/',
  requirePermission('settings.workflows.manage'),
  validateBody(workflowBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof workflowBody>;
    assertOneDefaultStatus(body.taskStatuses);

    const workflow = await prisma.workflowTemplate.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        projectTypeId: body.projectTypeId ?? null,
        stages: {
          create: body.stages.map((stage, index) => ({
            name: stage.name,
            color: stage.color,
            isTerminal: stage.isTerminal,
            isClientFacing: stage.isClientFacing,
            description: stage.description ?? null,
            sortOrder: index,
            defaultTasks: {
              create: stage.defaultTasks.map((task, taskIndex) => ({
                title: task.title,
                description: task.description ?? null,
                estimateHours: task.estimateHours ?? null,
                dueOffsetDays: task.dueOffsetDays,
                sortOrder: taskIndex,
              })),
            },
          })),
        },
        taskStatuses: {
          create: body.taskStatuses.map((status, index) => ({
            name: status.name,
            category: status.category,
            color: status.color,
            isDefault: status.isDefault,
            sortOrder: index,
          })),
        },
      },
      include: includeFull,
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Workflow',
      entityId: workflow.id,
      entityLabel: workflow.name,
      summary: `Created workflow "${workflow.name}" with ${body.stages.length} stage(s)`,
    });

    return created(res, workflow);
  }),
);

/**
 * Full replace of the builder payload. Stages and statuses carried over by id
 * are updated in place; omitted ones are deleted, but only when nothing points
 * at them - otherwise the request is refused rather than orphaning live work.
 */
workflowsRouter.put(
  '/:id',
  requirePermission('settings.workflows.manage'),
  validateBody(workflowBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof workflowBody>;
    assertOneDefaultStatus(body.taskStatuses);

    const existing = await prisma.workflowTemplate.findUnique({
      where: { id: req.params.id },
      include: { stages: true, taskStatuses: true },
    });
    if (!existing) throw notFound('Workflow');

    const keptStageIds = body.stages.map((s) => s.id).filter(Boolean) as string[];
    const keptStatusIds = body.taskStatuses.map((s) => s.id).filter(Boolean) as string[];
    const removedStageIds = existing.stages
      .filter((s) => !keptStageIds.includes(s.id))
      .map((s) => s.id);
    const removedStatusIds = existing.taskStatuses
      .filter((s) => !keptStatusIds.includes(s.id))
      .map((s) => s.id);

    if (removedStageIds.length) {
      const inUse = await prisma.project.count({
        where: { currentStageId: { in: removedStageIds }, deletedAt: null },
      });
      if (inUse) {
        throw conflict(
          `${inUse} project(s) are currently sitting in a stage you are removing - move them first`,
        );
      }
    }

    if (removedStatusIds.length) {
      const inUse = await prisma.task.count({
        where: { statusId: { in: removedStatusIds }, deletedAt: null },
      });
      if (inUse) {
        throw conflict(
          `${inUse} task(s) still use a status you are removing - change them first`,
        );
      }
    }

    const workflow = await prisma.$transaction(async (tx) => {
      await tx.workflowTemplate.update({
        where: { id: existing.id },
        data: {
          name: body.name,
          description: body.description ?? null,
          projectTypeId: body.projectTypeId ?? null,
        },
      });

      if (removedStageIds.length) {
        await tx.workflowStage.deleteMany({ where: { id: { in: removedStageIds } } });
      }
      if (removedStatusIds.length) {
        await tx.taskStatus.deleteMany({ where: { id: { in: removedStatusIds } } });
      }

      for (const [index, stage] of body.stages.entries()) {
        const stageData = {
          name: stage.name,
          color: stage.color,
          isTerminal: stage.isTerminal,
          isClientFacing: stage.isClientFacing,
          description: stage.description ?? null,
          sortOrder: index,
        };
        const saved = stage.id
          ? await tx.workflowStage.update({ where: { id: stage.id }, data: stageData })
          : await tx.workflowStage.create({
              data: { ...stageData, workflowId: existing.id },
            });

        // Default-task lists are small and rewritten wholesale; nothing
        // references them once a project's tasks have been seeded.
        await tx.workflowDefaultTask.deleteMany({ where: { stageId: saved.id } });
        if (stage.defaultTasks.length) {
          await tx.workflowDefaultTask.createMany({
            data: stage.defaultTasks.map((task, taskIndex) => ({
              stageId: saved.id,
              title: task.title,
              description: task.description ?? null,
              estimateHours: task.estimateHours ?? null,
              dueOffsetDays: task.dueOffsetDays,
              sortOrder: taskIndex,
            })),
          });
        }
      }

      for (const [index, status] of body.taskStatuses.entries()) {
        const statusData = {
          name: status.name,
          category: status.category,
          color: status.color,
          isDefault: status.isDefault,
          sortOrder: index,
        };
        if (status.id) {
          await tx.taskStatus.update({ where: { id: status.id }, data: statusData });
        } else {
          await tx.taskStatus.create({ data: { ...statusData, workflowId: existing.id } });
        }
      }

      return tx.workflowTemplate.findUniqueOrThrow({
        where: { id: existing.id },
        include: includeFull,
      });
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Workflow',
      entityId: workflow.id,
      entityLabel: workflow.name,
      summary: `Updated workflow "${workflow.name}"`,
      diff:
        diffRecords(
          { name: existing.name, stageCount: existing.stages.length },
          { name: body.name, stageCount: body.stages.length },
        ) ?? undefined,
    });

    return ok(res, workflow);
  }),
);

/** Copying a workflow is the usual way a new service line gets its pipeline. */
workflowsRouter.post(
  '/:id/duplicate',
  requirePermission('settings.workflows.manage'),
  validateBody(z.object({ name: z.string().trim().min(2).max(100) })),
  asyncHandler(async (req, res) => {
    const source = await prisma.workflowTemplate.findUnique({
      where: { id: req.params.id },
      include: {
        stages: { orderBy: { sortOrder: 'asc' }, include: { defaultTasks: true } },
        taskStatuses: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!source) throw notFound('Workflow');

    const copy = await prisma.workflowTemplate.create({
      data: {
        name: req.body.name,
        description: source.description,
        projectTypeId: source.projectTypeId,
        stages: {
          create: source.stages.map((stage) => ({
            name: stage.name,
            color: stage.color,
            isTerminal: stage.isTerminal,
            isClientFacing: stage.isClientFacing,
            description: stage.description,
            sortOrder: stage.sortOrder,
            defaultTasks: {
              create: stage.defaultTasks.map((task) => ({
                title: task.title,
                description: task.description,
                estimateHours: task.estimateHours,
                dueOffsetDays: task.dueOffsetDays,
                sortOrder: task.sortOrder,
              })),
            },
          })),
        },
        taskStatuses: {
          create: source.taskStatuses.map((status) => ({
            name: status.name,
            category: status.category,
            color: status.color,
            isDefault: status.isDefault,
            sortOrder: status.sortOrder,
          })),
        },
      },
      include: includeFull,
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Workflow',
      entityId: copy.id,
      entityLabel: copy.name,
      summary: `Duplicated workflow "${source.name}" as "${copy.name}"`,
    });

    return created(res, copy);
  }),
);

/** Archive rather than delete once a workflow has carried real projects. */
workflowsRouter.patch(
  '/:id/archive',
  requirePermission('settings.workflows.manage'),
  validateBody(z.object({ isArchived: z.boolean() })),
  asyncHandler(async (req, res) => {
    const workflow = await prisma.workflowTemplate.update({
      where: { id: req.params.id },
      data: { isArchived: req.body.isArchived },
    });
    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Workflow',
      entityId: workflow.id,
      entityLabel: workflow.name,
      summary: `${req.body.isArchived ? 'Archived' : 'Restored'} workflow "${workflow.name}"`,
    });
    return ok(res, workflow);
  }),
);

workflowsRouter.delete(
  '/:id',
  requirePermission('settings.workflows.manage'),
  asyncHandler(async (req, res) => {
    const workflow = await prisma.workflowTemplate.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { projects: true, retainers: true } } },
    });
    if (!workflow) throw notFound('Workflow');
    if (workflow._count.projects || workflow._count.retainers) {
      throw conflict('This workflow is in use - archive it instead of deleting');
    }

    await prisma.workflowTemplate.delete({ where: { id: workflow.id } });
    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Workflow',
      entityId: workflow.id,
      entityLabel: workflow.name,
      summary: `Deleted workflow "${workflow.name}"`,
    });
    return noContent(res);
  }),
);
