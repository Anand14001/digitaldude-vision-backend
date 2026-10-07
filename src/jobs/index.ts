import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { notify } from '../lib/notify';
import { dayjs, startOfDay } from '../lib/dates';
import { deriveHealth } from '../lib/workflowRuntime';
import { openCycle } from '../modules/retainers/retainers.routes';

/**
 * Background work the CRM needs without a separate worker process or a queue:
 * due-date nudges, project health, opening retainer cycles, renewal and
 * document-expiry reminders.
 *
 * The scheduler is a plain hourly tick. Each job records the date it last ran
 * in the Setting table, so a restart in the middle of the day does not re-run
 * yesterday's work and a daily job fires exactly once per day.
 */

const HOUR = 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

const LAST_RUN_KEY = 'jobs.lastRun';

async function lastRunMap(): Promise<Record<string, string>> {
  const row = await prisma.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  return (row?.value as Record<string, string>) ?? {};
}

async function markRun(job: string): Promise<void> {
  const current = await lastRunMap();
  const next = { ...current, [job]: dayjs().format('YYYY-MM-DD') };
  await prisma.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, value: next },
    update: { value: next },
  });
}

/** Runs `fn` at most once per calendar day. */
async function daily(job: string, fn: () => Promise<void>): Promise<void> {
  const runs = await lastRunMap();
  if (runs[job] === dayjs().format('YYYY-MM-DD')) return;
  try {
    await fn();
    await markRun(job);
    logger.info({ job }, 'scheduled job completed');
  } catch (error) {
    // Deliberately not marked as run, so it retries on the next tick.
    logger.error({ error, job }, 'scheduled job failed');
  }
}

// --------------------------------------------------------------------- jobs
/** Nudges assignees about work due tomorrow and work already overdue. */
async function taskDueReminders(): Promise<void> {
  const tomorrowStart = dayjs().add(1, 'day').startOf('day').toDate();
  const tomorrowEnd = dayjs().add(1, 'day').endOf('day').toDate();

  const dueSoon = await prisma.task.findMany({
    where: {
      deletedAt: null,
      completedAt: null,
      dueDate: { gte: tomorrowStart, lte: tomorrowEnd },
      assigneeId: { not: null },
      status: { category: { notIn: ['DONE', 'CANCELLED'] } },
    },
    select: {
      id: true,
      reference: true,
      title: true,
      assignee: { select: { userId: true } },
      project: { select: { name: true } },
    },
  });

  for (const task of dueSoon) {
    if (!task.assignee) continue;
    await notify({
      userIds: [task.assignee.userId],
      type: 'TASK_DUE_SOON',
      title: `Due tomorrow: ${task.title}`,
      body: task.project?.name,
      link: `/tasks/${task.id}`,
      entityType: 'Task',
      entityId: task.id,
    });
  }

  const overdue = await prisma.task.findMany({
    where: {
      deletedAt: null,
      completedAt: null,
      dueDate: { lt: startOfDay(new Date()) },
      assigneeId: { not: null },
      status: { category: { notIn: ['DONE', 'CANCELLED'] } },
    },
    select: {
      id: true,
      title: true,
      dueDate: true,
      assignee: { select: { userId: true } },
    },
    take: 500,
  });

  // One digest per person rather than one notification per overdue task.
  const byUser = new Map<string, number>();
  for (const task of overdue) {
    if (!task.assignee) continue;
    byUser.set(task.assignee.userId, (byUser.get(task.assignee.userId) ?? 0) + 1);
  }
  for (const [userId, count] of byUser) {
    await notify({
      userIds: [userId],
      type: 'TASK_OVERDUE',
      title: `${count} task${count === 1 ? '' : 's'} past their due date`,
      body: 'Open your task list to reschedule or close them.',
      link: '/tasks/my',
    });
  }

  logger.info({ dueSoon: dueSoon.length, overdue: overdue.length }, 'task reminders sent');
}

/** Recomputes project health so the dashboard is honest each morning. */
async function refreshProjectHealth(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { deletedAt: null, status: { in: ['PLANNING', 'ACTIVE', 'ON_HOLD'] } },
    select: { id: true, dueDate: true, health: true },
  });

  for (const project of projects) {
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

    if (health !== project.health) {
      await prisma.project.update({ where: { id: project.id }, data: { health } });
    }
  }

  logger.info({ projects: projects.length }, 'project health refreshed');
}

/** Opens the next cycle for monthly retainers once the previous one has ended. */
async function generateRetainerCycles(): Promise<void> {
  const retainers = await prisma.retainer.findMany({
    where: { status: 'ACTIVE', deletedAt: null, autoGenerateCycles: true },
    select: {
      id: true,
      code: true,
      endDate: true,
      cycles: { orderBy: { periodEnd: 'desc' }, take: 1, select: { periodEnd: true } },
    },
  });

  let opened = 0;
  for (const retainer of retainers) {
    const latestEnd = retainer.cycles[0]?.periodEnd;
    // Open the next cycle only once the current one is actually over.
    if (latestEnd && dayjs(latestEnd).isAfter(dayjs())) continue;
    if (retainer.endDate && dayjs(retainer.endDate).isBefore(dayjs())) continue;

    try {
      const cycle = await openCycle({ retainerId: retainer.id });
      if (cycle) opened += 1;
    } catch (error) {
      logger.error({ error, retainer: retainer.code }, 'failed to open retainer cycle');
    }
  }

  logger.info({ opened, checked: retainers.length }, 'retainer cycles generated');
}

/** Warns the account team about retainers coming up for renewal. */
async function retainerRenewalReminders(): Promise<void> {
  const horizon = dayjs().add(30, 'day').toDate();

  const retainers = await prisma.retainer.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      endDate: { not: null, gte: new Date(), lte: horizon },
    },
    select: {
      id: true,
      code: true,
      name: true,
      endDate: true,
      managerId: true,
      client: { select: { name: true, accountManagerId: true } },
    },
  });

  for (const retainer of retainers) {
    const employeeIds = [retainer.managerId, retainer.client.accountManagerId].filter(
      Boolean,
    ) as string[];
    if (!employeeIds.length) continue;

    const owners = await prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { userId: true },
    });

    await notify({
      userIds: owners.map((o) => o.userId),
      type: 'RETAINER_RENEWAL_DUE',
      title: `${retainer.client.name} retainer ends ${dayjs(retainer.endDate).format('DD MMM')}`,
      body: `${retainer.code} - ${retainer.name}. Start the renewal conversation.`,
      link: `/retainers/${retainer.id}`,
      entityType: 'Retainer',
      entityId: retainer.id,
      email: true,
    });
  }

  logger.info({ retainers: retainers.length }, 'renewal reminders sent');
}

/** Flags employee documents (contracts, IDs) that are about to expire. */
async function documentExpiryReminders(): Promise<void> {
  const horizon = dayjs().add(30, 'day').toDate();

  const documents = await prisma.employeeDocument.findMany({
    where: { expiresAt: { not: null, gte: new Date(), lte: horizon } },
    select: {
      id: true,
      title: true,
      expiresAt: true,
      employee: { select: { id: true, userId: true, user: { select: { name: true } } } },
    },
  });
  if (!documents.length) return;

  // Whoever administers people gets the list; the employee gets their own.
  const admins = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      kind: 'STAFF',
      OR: [
        { role: { isAdmin: true } },
        { role: { permissions: { has: 'employees.documents.manage' } } },
      ],
    },
    select: { id: true },
  });

  for (const document of documents) {
    await notify({
      userIds: [...admins.map((a) => a.id), document.employee.userId],
      type: 'DOCUMENT_EXPIRING',
      title: `${document.title} expires ${dayjs(document.expiresAt).format('DD MMM YYYY')}`,
      body: `${document.employee.user.name} - please arrange a renewal.`,
      link: `/employees/${document.employee.id}`,
      entityType: 'EmployeeDocument',
      entityId: document.id,
    });
  }

  logger.info({ documents: documents.length }, 'document expiry reminders sent');
}

/** Marks working days with no attendance record as absent, one day behind. */
async function backfillAbsences(): Promise<void> {
  const yesterday = dayjs().subtract(1, 'day').startOf('day');
  const schedule = await prisma.workSchedule.findFirst({ where: { isDefault: true } });
  const workingDays = schedule?.workingDays ?? [1, 2, 3, 4, 5, 6];
  if (!workingDays.includes(yesterday.day())) return;

  const holiday = await prisma.holiday.findFirst({ where: { date: yesterday.toDate() } });
  if (holiday) return;

  const employees = await prisma.employee.findMany({
    where: { status: { in: ['ACTIVE', 'ONBOARDING'] } },
    select: { id: true },
  });

  const existing = await prisma.attendanceRecord.findMany({
    where: { workDate: yesterday.toDate() },
    select: { employeeId: true },
  });
  const recorded = new Set(existing.map((r) => r.employeeId));
  const missing = employees.filter((e) => !recorded.has(e.id));
  if (!missing.length) return;

  await prisma.attendanceRecord.createMany({
    data: missing.map((employee) => ({
      employeeId: employee.id,
      workDate: yesterday.toDate(),
      status: 'ABSENT' as const,
      note: 'Auto-marked: no attendance recorded',
    })),
    skipDuplicates: true,
  });

  logger.info({ marked: missing.length }, 'absences backfilled');
}

// ----------------------------------------------------------------- scheduler
async function tick(): Promise<void> {
  await daily('taskDueReminders', taskDueReminders);
  await daily('refreshProjectHealth', refreshProjectHealth);
  await daily('generateRetainerCycles', generateRetainerCycles);
  await daily('retainerRenewalReminders', retainerRenewalReminders);
  await daily('documentExpiryReminders', documentExpiryReminders);
  await daily('backfillAbsences', backfillAbsences);
}

export function startScheduledJobs(): void {
  if (timer) return;
  // First tick a minute after boot so startup is not slowed by background work.
  setTimeout(() => void tick(), 60_000).unref();
  timer = setInterval(() => void tick(), HOUR);
  logger.info('scheduled jobs started (hourly tick, daily guard)');
}

export function stopScheduledJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed so the jobs can be run by hand: `tsx src/jobs/index.ts`. */
if (require.main === module) {
  void tick().then(() => process.exit(0));
}
