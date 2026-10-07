import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { orderByFrom, pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { canActOnEmployee, employeeWhere, redactEmployee } from '../../lib/scope';
import { randomToken } from '../../lib/password';
import { layout, sendMail } from '../../lib/mailer';
import { env } from '../../config/env';
import { nextSequence } from '../../lib/sequence';
import { dayjs } from '../../lib/dates';

export const employeesRouter = Router();

const SORTABLE = ['employeeCode', 'dateOfJoining', 'status', 'createdAt'] as const;

const profileBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(30).optional(),
  roleId: z.string().cuid().nullish(),
  departmentId: z.string().cuid().nullish(),
  designationId: z.string().cuid().nullish(),
  reportingToId: z.string().cuid().nullish(),
  employmentType: z
    .enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'FREELANCE'])
    .default('FULL_TIME'),
  status: z.enum(['ONBOARDING', 'ACTIVE', 'ON_NOTICE', 'EXITED']).default('ONBOARDING'),
  weeklyCapacityHours: z.coerce.number().min(0).max(80).default(40),
  dateOfJoining: z.coerce.date(),
  probationEnd: z.coerce.date().nullish(),
  notes: z.string().trim().max(4000).optional(),
  /** Email an invite so they can set their own password. */
  sendInvite: z.boolean().default(true),
  /** Seed the default onboarding checklist. */
  applyOnboardingChecklist: z.boolean().default(true),
});

const piiBody = z.object({
  dateOfBirth: z.coerce.date().nullish(),
  personalEmail: z.string().trim().toLowerCase().email().nullish(),
  personalPhone: z.string().trim().max(30).nullish(),
  emergencyContact: z.string().trim().max(120).nullish(),
  emergencyPhone: z.string().trim().max(30).nullish(),
  bloodGroup: z.string().trim().max(8).nullish(),
  addressLine: z.string().trim().max(250).nullish(),
  city: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(80).nullish(),
  pincode: z.string().trim().max(12).nullish(),
});

const listQuery = paginationSchema.extend({
  status: z.enum(['ONBOARDING', 'ACTIVE', 'ON_NOTICE', 'EXITED']).optional(),
  departmentId: z.string().cuid().optional(),
  designationId: z.string().cuid().optional(),
  reportingToId: z.string().cuid().optional(),
  skillId: z.string().cuid().optional(),
  employmentType: z
    .enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'FREELANCE'])
    .optional(),
});

const listSelect = {
  id: true,
  employeeCode: true,
  status: true,
  employmentType: true,
  dateOfJoining: true,
  weeklyCapacityHours: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      status: true,
      avatar: { select: { url: true } },
      role: { select: { id: true, name: true } },
    },
  },
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, title: true } },
  reportingTo: { select: { id: true, user: { select: { name: true } } } },
  skills: { select: { level: true, skill: { select: { id: true, name: true } } } },
  _count: { select: { tasksAssigned: true, projectMemberships: true } },
} as const;

// -------------------------------------------------------------------- listing
employeesRouter.get(
  '/',
  requirePermission('employees.view.all', 'employees.view.team'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...employeeWhere(req.ctx),
      ...(q.status ? { status: q.status } : {}),
      ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      ...(q.designationId ? { designationId: q.designationId } : {}),
      ...(q.reportingToId ? { reportingToId: q.reportingToId } : {}),
      ...(q.employmentType ? { employmentType: q.employmentType } : {}),
      ...(q.skillId ? { skills: { some: { skillId: q.skillId } } } : {}),
      ...(q.q
        ? {
            OR: [
              { employeeCode: { contains: q.q, mode: 'insensitive' as const } },
              { user: { name: { contains: q.q, mode: 'insensitive' as const } } },
              { user: { email: { contains: q.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.employee.findMany({
        where,
        orderBy: orderByFrom(q.sort, q.order, SORTABLE, 'employeeCode'),
        select: listSelect,
        ...skipTake(q),
      }),
      prisma.employee.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/** Picker list for assignment dropdowns. */
employeesRouter.get(
  '/options/all',
  requirePermission(
    'employees.view.all',
    'employees.view.team',
    'tasks.assign',
    'projects.members.manage',
  ),
  asyncHandler(async (_req, res) => {
    const employees = await prisma.employee.findMany({
      where: { status: { in: ['ONBOARDING', 'ACTIVE', 'ON_NOTICE'] } },
      orderBy: { user: { name: 'asc' } },
      select: {
        id: true,
        employeeCode: true,
        user: { select: { name: true, avatar: { select: { url: true } } } },
        designation: { select: { title: true } },
      },
      take: 500,
    });
    return ok(res, employees);
  }),
);

/**
 * Workload view: committed allocation and logged hours against capacity, which
 * is what makes "who is free next week" answerable.
 */
employeesRouter.get(
  '/workload',
  requirePermission('employees.view.all', 'employees.view.team'),
  validate({
    query: z.object({
      weekStart: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const start = dayjs((req.query as { weekStart?: Date }).weekStart ?? new Date())
      .startOf('isoWeek');
    const end = start.endOf('isoWeek');

    const employees = await prisma.employee.findMany({
      where: { ...employeeWhere(req.ctx), status: { in: ['ACTIVE', 'ONBOARDING'] } },
      select: {
        id: true,
        employeeCode: true,
        weeklyCapacityHours: true,
        user: { select: { name: true, avatar: { select: { url: true } } } },
        designation: { select: { title: true } },
        projectMemberships: {
          select: {
            allocationHours: true,
            project: { select: { id: true, name: true, status: true } },
          },
        },
      },
    });

    const [logged, openTasks] = await Promise.all([
      prisma.timeEntry.groupBy({
        by: ['employeeId'],
        where: { workDate: { gte: start.toDate(), lte: end.toDate() } },
        _sum: { hours: true },
      }),
      prisma.task.groupBy({
        by: ['assigneeId'],
        where: {
          deletedAt: null,
          completedAt: null,
          status: { category: { notIn: ['DONE', 'CANCELLED'] } },
        },
        _count: { _all: true },
        _sum: { estimateHours: true },
      }),
    ]);

    const rows = employees.map((employee) => {
      const allocated = employee.projectMemberships
        .filter((m) => m.project.status === 'ACTIVE')
        .reduce((sum, m) => sum + Number(m.allocationHours ?? 0), 0);
      const loggedHours = Number(
        logged.find((l) => l.employeeId === employee.id)?._sum.hours ?? 0,
      );
      const tasks = openTasks.find((t) => t.assigneeId === employee.id);
      const capacity = Number(employee.weeklyCapacityHours);

      return {
        employee: {
          id: employee.id,
          code: employee.employeeCode,
          name: employee.user.name,
          avatarUrl: employee.user.avatar?.url ?? null,
          designation: employee.designation?.title ?? null,
        },
        capacityHours: capacity,
        allocatedHours: allocated,
        loggedHours,
        openTasks: tasks?._count._all ?? 0,
        openEstimateHours: Number(tasks?._sum.estimateHours ?? 0),
        utilizationPercent: capacity ? Math.round((loggedHours / capacity) * 100) : null,
        overAllocated: capacity > 0 && allocated > capacity,
        activeProjects: employee.projectMemberships
          .filter((m) => m.project.status === 'ACTIVE')
          .map((m) => m.project.name),
      };
    });

    return ok(res, {
      weekStart: start.toDate(),
      weekEnd: end.toDate(),
      rows: rows.sort((a, b) => b.allocatedHours - a.allocatedHours),
    });
  }),
);

// ---------------------------------------------------------------- single read
employeesRouter.get(
  '/:id',
  requirePermission('employees.view.all', 'employees.view.team'),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findFirst({
      where: { AND: [employeeWhere(req.ctx), { id: req.params.id }] },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            status: true,
            lastLoginAt: true,
            avatar: { select: { url: true } },
            role: { select: { id: true, name: true, isAdmin: true } },
          },
        },
        department: true,
        designation: true,
        reportingTo: { select: { id: true, user: { select: { name: true } } } },
        reports: {
          select: { id: true, user: { select: { name: true } }, designation: { select: { title: true } } },
        },
        skills: { include: { skill: true } },
        documents: {
          orderBy: { createdAt: 'desc' },
          include: { file: { select: { id: true, url: true, originalName: true, mimeType: true } } },
        },
        compensation: { orderBy: { effectiveFrom: 'desc' } },
        assetAssignments: {
          where: { returnedAt: null },
          include: { asset: { select: { id: true, assetTag: true, name: true, category: true } } },
        },
        checklistItems: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        projectMemberships: {
          include: {
            project: {
              select: { id: true, code: true, name: true, status: true, client: { select: { name: true } } },
            },
          },
        },
        goals: { orderBy: { createdAt: 'desc' }, take: 10 },
        _count: { select: { tasksAssigned: true, leaveRequests: true } },
      },
    });
    if (!employee) throw notFound('Employee');

    // Documents are a separate clearance from the profile itself.
    const payload = redactEmployee(req.ctx, employee as unknown as Record<string, unknown>);
    if (
      !req.ctx.has('employees.documents.manage') &&
      employee.id !== req.ctx.employeeId
    ) {
      delete payload.documents;
    }

    return ok(res, payload);
  }),
);

// --------------------------------------------------------------------- create
/**
 * Creating an employee also creates their staff user account in the same
 * transaction, so there is never an employee without a login or vice versa.
 */
employeesRouter.post(
  '/',
  requirePermission('employees.create'),
  validateBody(profileBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof profileBody>;

    const clash = await prisma.user.findFirst({
      where: { email: body.email, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw conflict('An account with that email already exists');

    const inviteToken = body.sendInvite ? randomToken() : null;

    const employee = await prisma.$transaction(async (tx) => {
      const employeeCode = await nextSequence('employee', 'DD', tx);

      const user = await tx.user.create({
        data: {
          kind: 'STAFF',
          email: body.email,
          name: body.name,
          phone: body.phone ?? null,
          roleId: body.roleId ?? null,
          status: body.sendInvite ? 'INVITED' : 'ACTIVE',
          inviteToken,
          inviteExpiresAt: inviteToken ? new Date(Date.now() + 7 * 86_400_000) : null,
        },
      });

      const createdEmployee = await tx.employee.create({
        data: {
          employeeCode,
          userId: user.id,
          departmentId: body.departmentId ?? null,
          designationId: body.designationId ?? null,
          reportingToId: body.reportingToId ?? null,
          employmentType: body.employmentType,
          status: body.status,
          weeklyCapacityHours: body.weeklyCapacityHours,
          dateOfJoining: body.dateOfJoining,
          probationEnd: body.probationEnd ?? null,
          notes: body.notes ?? null,
        },
      });

      if (body.applyOnboardingChecklist) {
        const template = await tx.checklistTemplate.findFirst({
          where: { kind: 'ONBOARDING', isDefault: true },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });
        if (template?.items.length) {
          await tx.employeeChecklistItem.createMany({
            data: template.items.map((item) => ({
              employeeId: createdEmployee.id,
              templateItemId: item.id,
              kind: 'ONBOARDING' as const,
              label: item.label,
              sortOrder: item.sortOrder,
              dueDate: dayjs(body.dateOfJoining).add(item.dueOffsetDays, 'day').toDate(),
            })),
          });
        }
      }

      // Open this year's leave balances from the configured quotas.
      const leaveTypes = await tx.leaveType.findMany({ where: { active: true } });
      if (leaveTypes.length) {
        const year = new Date().getFullYear();
        await tx.leaveBalance.createMany({
          data: leaveTypes.map((type) => ({
            employeeId: createdEmployee.id,
            leaveTypeId: type.id,
            year,
            entitled: type.annualQuota,
          })),
          skipDuplicates: true,
        });
      }

      return createdEmployee;
    });

    if (inviteToken) {
      await sendMail({
        to: body.email,
        subject: 'Welcome to Digital Dude - set up your Vision account',
        html: layout({
          heading: `Welcome aboard, ${body.name.split(' ')[0] ?? ''}`.trim(),
          body: '<p>Your Vision account is ready. Set a password to sign in and see your projects and tasks.</p>',
          ctaLabel: 'Set your password',
          ctaUrl: `${env.webOrigins[0] ?? ''}/accept-invite?token=${inviteToken}`,
        }),
      });
    }

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Employee',
      entityId: employee.id,
      entityLabel: `${employee.employeeCode} ${body.name}`,
      summary: `Added employee ${body.name} (${employee.employeeCode})`,
    });

    return created(res, employee);
  }),
);

// --------------------------------------------------------------------- update
employeesRouter.patch(
  '/:id',
  requirePermission('employees.update'),
  validateBody(
    profileBody
      .partial()
      .omit({ sendInvite: true, applyOnboardingChecklist: true, email: true })
      .merge(piiBody.partial()),
  ),
  asyncHandler(async (req, res) => {
    const before = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, phone: true, roleId: true } } },
    });
    if (!before) throw notFound('Employee');

    const body = req.body as Record<string, unknown>;
    const { name, phone, roleId, sendInvite, applyOnboardingChecklist, ...employeeData } =
      body as Record<string, never>;

    if (roleId !== undefined && !req.ctx.has('settings.users.manage')) {
      throw forbidden('Changing someone’s role needs user administration rights');
    }
    if (employeeData.reportingToId === before.id) {
      throw badRequest('Someone cannot report to themselves');
    }
    // Walk up the chain so a reporting loop cannot be created.
    if (employeeData.reportingToId) {
      let cursor: string | null = employeeData.reportingToId as unknown as string;
      const seen = new Set<string>([before.id]);
      while (cursor) {
        if (seen.has(cursor)) throw badRequest('That would create a reporting loop');
        seen.add(cursor);
        const next: { reportingToId: string | null } | null = await prisma.employee.findUnique({
          where: { id: cursor },
          select: { reportingToId: true },
        });
        cursor = next?.reportingToId ?? null;
      }
    }

    const employee = await prisma.$transaction(async (tx) => {
      if (name !== undefined || phone !== undefined || roleId !== undefined) {
        await tx.user.update({
          where: { id: before.userId },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(phone !== undefined ? { phone } : {}),
            ...(roleId !== undefined ? { roleId } : {}),
          },
        });
      }
      return tx.employee.update({
        where: { id: before.id },
        data: {
          ...employeeData,
          ...(employeeData.status === 'EXITED' && before.status !== 'EXITED'
            ? { dateOfExit: new Date() }
            : {}),
        },
      });
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Employee',
      entityId: employee.id,
      entityLabel: `${employee.employeeCode} ${before.user.name}`,
      summary: `Updated employee ${before.user.name}`,
      diff: diffRecords({ ...before, ...before.user }, body) ?? undefined,
    });

    return ok(res, employee);
  }),
);

// --------------------------------------------------------------------- skills
employeesRouter.put(
  '/:id/skills',
  requirePermission('employees.update'),
  validateBody(
    z.object({
      skills: z
        .array(
          z.object({
            skillId: z.string().cuid(),
            level: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']),
          }),
        )
        .max(60),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!employee) throw notFound('Employee');

    const skills = req.body.skills as { skillId: string; level: string }[];
    await prisma.$transaction(async (tx) => {
      await tx.employeeSkill.deleteMany({ where: { employeeId: employee.id } });
      if (skills.length) {
        await tx.employeeSkill.createMany({
          data: skills.map((s) => ({
            employeeId: employee.id,
            skillId: s.skillId,
            level: s.level as 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT',
          })),
        });
      }
    });

    const result = await prisma.employeeSkill.findMany({
      where: { employeeId: employee.id },
      include: { skill: true },
    });
    return ok(res, result);
  }),
);

// ------------------------------------------------------------------ documents
employeesRouter.post(
  '/:id/documents',
  requirePermission('employees.documents.manage'),
  validateBody(
    z.object({
      type: z.enum([
        'OFFER_LETTER',
        'CONTRACT',
        'ID_PROOF',
        'ADDRESS_PROOF',
        'EDUCATION',
        'PAYSLIP',
        'NDA',
        'OTHER',
      ]),
      title: z.string().trim().min(2).max(160),
      fileId: z.string().cuid(),
      expiresAt: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!employee) throw notFound('Employee');

    const document = await prisma.employeeDocument.create({
      data: { ...req.body, employeeId: employee.id },
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'EmployeeDocument',
      entityId: document.id,
      entityLabel: document.title,
      summary: `Added document "${document.title}" to ${employee.user.name}`,
    });

    return created(res, document);
  }),
);

employeesRouter.delete(
  '/documents/:documentId',
  requirePermission('employees.documents.manage'),
  asyncHandler(async (req, res) => {
    const document = await prisma.employeeDocument.findUnique({
      where: { id: req.params.documentId },
      select: { id: true, title: true },
    });
    if (!document) throw notFound('Document');
    await prisma.employeeDocument.delete({ where: { id: document.id } });
    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'EmployeeDocument',
      entityId: document.id,
      entityLabel: document.title,
      summary: `Deleted document "${document.title}"`,
    });
    return noContent(res);
  }),
);

// --------------------------------------------------------------- compensation
employeesRouter.post(
  '/:id/compensation',
  requirePermission('employees.compensation.manage'),
  validateBody(
    z.object({
      effectiveFrom: z.coerce.date(),
      ctcAnnual: z.coerce.number().min(0).max(1_000_000_000),
      currency: z.string().trim().length(3).default('INR'),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!employee) throw notFound('Employee');

    const record = await prisma.employeeCompensation.create({
      data: { ...req.body, employeeId: employee.id },
    });

    // Deliberately no amounts in the audit summary - the diff would leak salary
    // to anyone with logs.view but not compensation.view.
    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'EmployeeCompensation',
      entityId: record.id,
      entityLabel: employee.user.name,
      summary: `Recorded a compensation change for ${employee.user.name}`,
    });

    return created(res, record);
  }),
);

// ------------------------------------------------------------------ checklist
employeesRouter.patch(
  '/checklist/:itemId',
  requirePermission('employees.checklist.manage'),
  validateBody(z.object({ completed: z.boolean() })),
  asyncHandler(async (req, res) => {
    const item = await prisma.employeeChecklistItem.findUnique({
      where: { id: req.params.itemId },
    });
    if (!item) throw notFound('Checklist item');

    const updated = await prisma.employeeChecklistItem.update({
      where: { id: item.id },
      data: {
        completedAt: req.body.completed ? new Date() : null,
        completedById: req.body.completed ? req.ctx.user.id : null,
      },
    });
    return ok(res, updated);
  }),
);

employeesRouter.post(
  '/:id/checklist',
  requirePermission('employees.checklist.manage'),
  validateBody(
    z.object({
      kind: z.enum(['ONBOARDING', 'OFFBOARDING']),
      label: z.string().trim().min(2).max(200),
      dueDate: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!employee) throw notFound('Employee');

    const count = await prisma.employeeChecklistItem.count({
      where: { employeeId: employee.id, kind: req.body.kind },
    });

    const item = await prisma.employeeChecklistItem.create({
      data: { ...req.body, employeeId: employee.id, sortOrder: count },
    });
    return created(res, item);
  }),
);

// ------------------------------------------------------------ asset issue/return
employeesRouter.post(
  '/:id/assets',
  requirePermission('assets.assign'),
  validateBody(
    z.object({
      assetId: z.string().cuid(),
      conditionOut: z.string().trim().max(300).optional(),
      note: z.string().trim().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const [employee, asset] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: req.params.id },
        select: { id: true, user: { select: { name: true } } },
      }),
      prisma.asset.findUnique({ where: { id: req.body.assetId } }),
    ]);
    if (!employee) throw notFound('Employee');
    if (!asset) throw notFound('Asset');
    if (asset.status !== 'AVAILABLE') {
      throw conflict(`That asset is currently ${asset.status.toLowerCase().replace('_', ' ')}`);
    }

    const assignment = await prisma.$transaction(async (tx) => {
      const createdAssignment = await tx.assetAssignment.create({
        data: {
          assetId: asset.id,
          employeeId: employee.id,
          conditionOut: req.body.conditionOut ?? null,
          note: req.body.note ?? null,
        },
      });
      await tx.asset.update({ where: { id: asset.id }, data: { status: 'ASSIGNED' } });
      return createdAssignment;
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Asset',
      entityId: asset.id,
      entityLabel: `${asset.assetTag} ${asset.name}`,
      summary: `Issued ${asset.name} (${asset.assetTag}) to ${employee.user.name}`,
    });

    return created(res, assignment);
  }),
);

employeesRouter.post(
  '/assets/:assignmentId/return',
  requirePermission('assets.assign'),
  validateBody(
    z.object({
      conditionIn: z.string().trim().max(300).optional(),
      /** Where the asset goes once returned. */
      assetStatus: z
        .enum(['AVAILABLE', 'IN_REPAIR', 'RETIRED', 'LOST'])
        .default('AVAILABLE'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const assignment = await prisma.assetAssignment.findUnique({
      where: { id: req.params.assignmentId },
      include: {
        asset: { select: { id: true, name: true, assetTag: true } },
        employee: { select: { user: { select: { name: true } } } },
      },
    });
    if (!assignment) throw notFound('Assignment');
    if (assignment.returnedAt) throw badRequest('That asset has already been returned');

    await prisma.$transaction(async (tx) => {
      await tx.assetAssignment.update({
        where: { id: assignment.id },
        data: { returnedAt: new Date(), conditionIn: req.body.conditionIn ?? null },
      });
      await tx.asset.update({
        where: { id: assignment.asset.id },
        data: { status: req.body.assetStatus },
      });
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Asset',
      entityId: assignment.asset.id,
      entityLabel: `${assignment.asset.assetTag} ${assignment.asset.name}`,
      summary: `${assignment.employee.user.name} returned ${assignment.asset.name}`,
    });

    return noContent(res);
  }),
);

// ------------------------------------------------------------- deactivate
employeesRouter.post(
  '/:id/offboard',
  requirePermission('employees.delete'),
  validateBody(
    z.object({
      dateOfExit: z.coerce.date().default(() => new Date()),
      applyOffboardingChecklist: z.boolean().default(true),
      reassignTasksTo: z.string().cuid().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true } } },
    });
    if (!employee) throw notFound('Employee');
    if (employee.id === req.ctx.employeeId) throw badRequest('You cannot offboard yourself');

    const openTasks = await prisma.task.count({
      where: { assigneeId: employee.id, deletedAt: null, completedAt: null },
    });
    if (openTasks && !req.body.reassignTasksTo) {
      throw conflict(
        `${openTasks} open task(s) are assigned to ${employee.user.name} - choose who to reassign them to`,
      );
    }

    await prisma.$transaction(async (tx) => {
      if (req.body.reassignTasksTo) {
        await tx.task.updateMany({
          where: { assigneeId: employee.id, deletedAt: null, completedAt: null },
          data: { assigneeId: req.body.reassignTasksTo },
        });
      }

      await tx.employee.update({
        where: { id: employee.id },
        data: { status: 'EXITED', dateOfExit: req.body.dateOfExit },
      });

      // Access ends with employment.
      await tx.user.update({
        where: { id: employee.userId },
        data: { status: 'SUSPENDED' },
      });
      await tx.refreshToken.updateMany({
        where: { userId: employee.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (req.body.applyOffboardingChecklist) {
        const template = await tx.checklistTemplate.findFirst({
          where: { kind: 'OFFBOARDING', isDefault: true },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });
        if (template?.items.length) {
          await tx.employeeChecklistItem.createMany({
            data: template.items.map((item) => ({
              employeeId: employee.id,
              templateItemId: item.id,
              kind: 'OFFBOARDING' as const,
              label: item.label,
              sortOrder: item.sortOrder,
              dueDate: dayjs(req.body.dateOfExit).add(item.dueOffsetDays, 'day').toDate(),
            })),
          });
        }
      }
    });

    await auditFromRequest(req, {
      action: 'STATUS_CHANGE',
      entityType: 'Employee',
      entityId: employee.id,
      entityLabel: `${employee.employeeCode} ${employee.user.name}`,
      summary: `Offboarded ${employee.user.name}`,
      diff: { status: { from: employee.status, to: 'EXITED' } },
    });

    return ok(res, { offboarded: true, reassignedTasks: openTasks });
  }),
);

/** Lets a manager see their own team's org chart branch. */
employeesRouter.get(
  '/:id/team',
  requirePermission('employees.view.all', 'employees.view.team'),
  asyncHandler(async (req, res) => {
    const target = await prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { id: true, reportingToId: true },
    });
    if (!target) throw notFound('Employee');
    if (
      !canActOnEmployee(req.ctx, target, {
        all: 'employees.view.all',
        team: 'employees.view.team',
      })
    ) {
      throw forbidden();
    }

    const reports = await prisma.employee.findMany({
      where: { reportingToId: target.id },
      select: listSelect,
    });
    return ok(res, reports);
  }),
);
