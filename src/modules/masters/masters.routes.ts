import { Router } from 'express';
import { z } from 'zod';
import { crudRouter } from '../../lib/crudFactory';
import { conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

/**
 * Flat reference tables behind the Settings screens. Each one is built from the
 * CRUD factory; the only bespoke part is the beforeDelete guard that stops a
 * row being removed while live records still point at it.
 */
export const mastersRouter = Router();

const name = z.string().trim().min(2).max(120);
const code = z.string().trim().min(1).max(30).toUpperCase();
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #4f46e5');

// ---------------------------------------------------------------- departments
mastersRouter.use(
  '/departments',
  crudRouter({
    model: 'department',
    label: 'Department',
    createSchema: z.object({ name, code: code.optional() }),
    updateSchema: z.object({ name: name.optional(), code: code.nullish() }),
    writePermission: 'settings.masters.manage',
    readPermission: ['settings.masters.manage', 'employees.view.all', 'employees.view.team'],
    searchFields: ['name', 'code'],
    include: { _count: { select: { employees: true } } },
    beforeDelete: async (id) => {
      const inUse = await prisma.employee.count({ where: { departmentId: id } });
      if (inUse) throw conflict(`${inUse} employee(s) are still in this department`);
    },
  }),
);

// --------------------------------------------------------------- designations
mastersRouter.use(
  '/designations',
  crudRouter({
    model: 'designation',
    label: 'Designation',
    labelField: 'title',
    createSchema: z.object({ title: name, level: z.coerce.number().int().min(0).max(20).default(0) }),
    updateSchema: z.object({
      title: name.optional(),
      level: z.coerce.number().int().min(0).max(20).optional(),
    }),
    writePermission: 'settings.masters.manage',
    readPermission: ['settings.masters.manage', 'employees.view.all', 'employees.view.team'],
    searchFields: ['title'],
    sortFields: ['title', 'level', 'createdAt'],
    defaultSort: 'level',
    include: { _count: { select: { employees: true } } },
    beforeDelete: async (id) => {
      const inUse = await prisma.employee.count({ where: { designationId: id } });
      if (inUse) throw conflict(`${inUse} employee(s) still hold this designation`);
    },
  }),
);

// --------------------------------------------------------------------- skills
mastersRouter.use(
  '/skills',
  crudRouter({
    model: 'skill',
    label: 'Skill',
    createSchema: z.object({ name, category: z.string().trim().max(60).optional() }),
    updateSchema: z.object({ name: name.optional(), category: z.string().trim().max(60).nullish() }),
    writePermission: 'settings.masters.manage',
    readPermission: ['settings.masters.manage', 'employees.view.all', 'employees.view.team'],
    searchFields: ['name', 'category'],
  }),
);

// -------------------------------------------------------------- service lines
mastersRouter.use(
  '/service-lines',
  crudRouter({
    model: 'serviceLine',
    label: 'Service line',
    createSchema: z.object({ name, code, active: z.boolean().default(true) }),
    updateSchema: z.object({
      name: name.optional(),
      code: code.optional(),
      active: z.boolean().optional(),
    }),
    writePermission: 'settings.masters.manage',
    readPermission: [
      'settings.masters.manage',
      'clients.view.all',
      'clients.view.assigned',
      'projects.view.all',
      'projects.view.assigned',
    ],
    searchFields: ['name', 'code'],
    include: { _count: { select: { projects: true, retainers: true, clients: true } } },
    beforeDelete: async (id) => {
      const [projects, retainers] = await Promise.all([
        prisma.project.count({ where: { serviceLineId: id } }),
        prisma.retainer.count({ where: { serviceLineId: id } }),
      ]);
      if (projects || retainers) {
        throw conflict('This service line is still used by projects or retainers');
      }
    },
  }),
);

// ---------------------------------------------------------------- leave types
mastersRouter.use(
  '/leave-types',
  crudRouter({
    model: 'leaveType',
    label: 'Leave type',
    createSchema: z.object({
      name,
      code,
      annualQuota: z.coerce.number().min(0).max(365).default(0),
      isPaid: z.boolean().default(true),
      carryForward: z.boolean().default(false),
      requiresProof: z.boolean().default(false),
      active: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: name.optional(),
      code: code.optional(),
      annualQuota: z.coerce.number().min(0).max(365).optional(),
      isPaid: z.boolean().optional(),
      carryForward: z.boolean().optional(),
      requiresProof: z.boolean().optional(),
      active: z.boolean().optional(),
    }),
    writePermission: 'settings.masters.manage',
    readPermission: [
      'settings.masters.manage',
      'leave.request.own',
      'leave.view.all',
      'leave.view.team',
    ],
    searchFields: ['name', 'code'],
    beforeDelete: async (id) => {
      const inUse = await prisma.leaveRequest.count({ where: { leaveTypeId: id } });
      if (inUse) throw conflict('Leave has already been taken under this type; deactivate it instead');
    },
  }),
);

// ------------------------------------------------------------------- holidays
mastersRouter.use(
  '/holidays',
  crudRouter({
    model: 'holiday',
    label: 'Holiday',
    createSchema: z.object({
      name,
      date: z.coerce.date(),
      isOptional: z.boolean().default(false),
    }),
    updateSchema: z.object({
      name: name.optional(),
      date: z.coerce.date().optional(),
      isOptional: z.boolean().optional(),
    }),
    writePermission: 'settings.masters.manage',
    readPermission: [
      'settings.masters.manage',
      'calendar.view.own',
      'calendar.view.all',
      'leave.request.own',
    ],
    searchFields: ['name'],
    sortFields: ['date', 'name'],
    defaultSort: 'date',
    defaultOrder: 'asc',
  }),
);

// ------------------------------------------------------------- work schedules
mastersRouter.use(
  '/work-schedules',
  crudRouter({
    model: 'workSchedule',
    label: 'Work schedule',
    createSchema: z.object({
      name,
      workingDays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
      startTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
      endTime: z.string().regex(/^\d{2}:\d{2}$/).default('20:00'),
      isDefault: z.boolean().default(false),
    }),
    updateSchema: z.object({
      name: name.optional(),
      workingDays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7).optional(),
      startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      isDefault: z.boolean().optional(),
    }),
    writePermission: 'settings.masters.manage',
    searchFields: ['name'],
  }),
);

// --------------------------------------------------------------- project types
mastersRouter.use(
  '/project-types',
  crudRouter({
    model: 'projectType',
    label: 'Project type',
    createSchema: z.object({
      name,
      code,
      description: z.string().trim().max(500).optional(),
      defaultWorkflowId: z.string().cuid().optional(),
      active: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: name.optional(),
      code: code.optional(),
      description: z.string().trim().max(500).nullish(),
      defaultWorkflowId: z.string().cuid().nullish(),
      active: z.boolean().optional(),
    }),
    writePermission: 'settings.workflows.manage',
    readPermission: [
      'settings.workflows.manage',
      'projects.view.all',
      'projects.view.assigned',
      'projects.create',
    ],
    searchFields: ['name', 'code'],
    include: {
      defaultWorkflow: { select: { id: true, name: true } },
      _count: { select: { projects: true, retainers: true } },
    },
    beforeDelete: async (id) => {
      const inUse = await prisma.project.count({ where: { projectTypeId: id } });
      if (inUse) throw conflict(`${inUse} project(s) still use this type`);
    },
  }),
);

// -------------------------------------------------------------- project roles
mastersRouter.use(
  '/project-roles',
  crudRouter({
    model: 'projectRole',
    label: 'Project role',
    createSchema: z.object({
      name,
      description: z.string().trim().max(300).optional(),
      color: hex.default('#64748b'),
      sortOrder: z.coerce.number().int().min(0).max(999).default(0),
      active: z.boolean().default(true),
    }),
    updateSchema: z.object({
      name: name.optional(),
      description: z.string().trim().max(300).nullish(),
      color: hex.optional(),
      sortOrder: z.coerce.number().int().min(0).max(999).optional(),
      active: z.boolean().optional(),
    }),
    writePermission: 'settings.masters.manage',
    // Anyone who can see a project needs to read these to understand its team.
    readPermission: [
      'settings.masters.manage',
      'projects.view.all',
      'projects.view.assigned',
      'projects.members.manage',
    ],
    searchFields: ['name', 'description'],
    sortFields: ['name', 'sortOrder', 'createdAt'],
    defaultSort: 'sortOrder',
    defaultOrder: 'asc',
    include: { _count: { select: { members: true } } },
    beforeDelete: async (id) => {
      const inUse = await prisma.projectMemberRole.count({ where: { projectRoleId: id } });
      if (inUse) {
        throw conflict(
          `This role is assigned to ${inUse} project member(s) - deactivate it instead`,
        );
      }
    },
  }),
);

// --------------------------------------------------------------------- assets
mastersRouter.use(
  '/assets',
  crudRouter({
    model: 'asset',
    label: 'Asset',
    createSchema: z.object({
      assetTag: z.string().trim().min(2).max(40),
      name,
      category: z.enum([
        'LAPTOP',
        'DESKTOP',
        'MONITOR',
        'PHONE',
        'CAMERA',
        'LENS',
        'AUDIO',
        'LIGHTING',
        'DRONE',
        'ACCESSORY',
        'SOFTWARE_LICENSE',
        'OTHER',
      ]),
      serialNumber: z.string().trim().max(80).optional(),
      purchaseDate: z.coerce.date().optional(),
      purchaseCost: z.coerce.number().min(0).optional(),
      warrantyEnd: z.coerce.date().optional(),
      status: z
        .enum(['AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'LOST'])
        .default('AVAILABLE'),
      notes: z.string().trim().max(1000).optional(),
    }),
    updateSchema: z.object({
      assetTag: z.string().trim().min(2).max(40).optional(),
      name: name.optional(),
      category: z
        .enum([
          'LAPTOP',
          'DESKTOP',
          'MONITOR',
          'PHONE',
          'CAMERA',
          'LENS',
          'AUDIO',
          'LIGHTING',
          'DRONE',
          'ACCESSORY',
          'SOFTWARE_LICENSE',
          'OTHER',
        ])
        .optional(),
      serialNumber: z.string().trim().max(80).nullish(),
      purchaseDate: z.coerce.date().nullish(),
      purchaseCost: z.coerce.number().min(0).nullish(),
      warrantyEnd: z.coerce.date().nullish(),
      status: z.enum(['AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'LOST']).optional(),
      notes: z.string().trim().max(1000).nullish(),
    }),
    writePermission: 'assets.manage',
    readPermission: ['assets.view', 'assets.manage'],
    searchFields: ['name', 'assetTag', 'serialNumber'],
    sortFields: ['name', 'assetTag', 'category', 'status', 'createdAt'],
    include: {
      assignments: {
        where: { returnedAt: null },
        select: {
          id: true,
          assignedAt: true,
          employee: {
            select: { id: true, employeeCode: true, user: { select: { name: true } } },
          },
        },
      },
    },
    beforeDelete: async (id) => {
      const active = await prisma.assetAssignment.count({
        where: { assetId: id, returnedAt: null },
      });
      if (active) throw conflict('Return this asset before deleting it');
    },
  }),
);

export { hex as hexColour };
