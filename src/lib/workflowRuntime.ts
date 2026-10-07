import type { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { badRequest } from './errors';
import { nextSequence } from './sequence';

/**
 * Shared workflow behaviour used by both projects and retainer cycles, so the
 * two never drift apart: finding a workflow's first stage, resolving the status
 * new tasks start in, and seeding a stage's checklist of default tasks.
 */

export async function firstStageOf(
  workflowId: string,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; name: string } | null> {
  return tx.workflowStage.findFirst({
    where: { workflowId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true },
  });
}

/** The status a newly created task lands in for a given workflow. */
export async function defaultStatusId(
  workflowId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const status =
    (await tx.taskStatus.findFirst({
      where: { workflowId, isDefault: true },
      select: { id: true },
    })) ??
    (await tx.taskStatus.findFirst({
      where: { workflowId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    }));

  if (!status) {
    throw badRequest('This workflow has no task statuses configured');
  }
  return status.id;
}

/**
 * Creates the stage's default tasks for a project or retainer cycle. Idempotent
 * per stage: tasks already seeded from the same titles are skipped, so moving a
 * project back and forth does not duplicate its checklist.
 */
export async function seedStageTasks(opts: {
  tx: Prisma.TransactionClient;
  stageId: string;
  workflowId: string;
  projectId?: string;
  retainerCycleId?: string;
  /** Due dates are offset from this date, usually the stage entry date. */
  anchorDate?: Date;
  createdById?: string | null;
  defaultAssigneeId?: string | null;
}): Promise<number> {
  const { tx, stageId, workflowId } = opts;

  const templates = await tx.workflowDefaultTask.findMany({
    where: { stageId },
    orderBy: { sortOrder: 'asc' },
  });
  if (!templates.length) return 0;

  const existing = await tx.task.findMany({
    where: {
      stageId,
      deletedAt: null,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.retainerCycleId ? { retainerCycleId: opts.retainerCycleId } : {}),
    },
    select: { title: true },
  });
  const alreadyThere = new Set(existing.map((t) => t.title));

  const statusId = await defaultStatusId(workflowId, tx);
  const anchor = dayjs(opts.anchorDate ?? new Date());
  let createdCount = 0;

  for (const [index, template] of templates.entries()) {
    if (alreadyThere.has(template.title)) continue;
    const reference = await nextSequence('task', 'TSK', tx);
    await tx.task.create({
      data: {
        reference,
        title: template.title,
        description: template.description,
        estimateHours: template.estimateHours,
        dueDate: template.dueOffsetDays
          ? anchor.add(template.dueOffsetDays, 'day').endOf('day').toDate()
          : null,
        sortOrder: index,
        statusId,
        stageId,
        projectId: opts.projectId ?? null,
        retainerCycleId: opts.retainerCycleId ?? null,
        assigneeId: opts.defaultAssigneeId ?? null,
        createdById: opts.createdById ?? null,
      },
    });
    createdCount += 1;
  }

  return createdCount;
}

/**
 * Derives project health from its own dates and task state rather than asking
 * someone to keep a dropdown up to date.
 */
export function deriveHealth(input: {
  dueDate: Date | null;
  openOverdueTasks: number;
  totalTasks: number;
  doneTasks: number;
}): 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' {
  const now = new Date();
  const pastDue = input.dueDate ? input.dueDate < now : false;
  const incomplete = input.totalTasks > input.doneTasks;

  if (pastDue && incomplete) return 'OFF_TRACK';
  if (input.openOverdueTasks >= 3) return 'OFF_TRACK';
  if (input.openOverdueTasks > 0) return 'AT_RISK';
  if (
    input.dueDate &&
    incomplete &&
    dayjs(input.dueDate).diff(now, 'day') <= 3 &&
    input.totalTasks > 0 &&
    input.doneTasks / input.totalTasks < 0.75
  ) {
    return 'AT_RISK';
  }
  return 'ON_TRACK';
}
