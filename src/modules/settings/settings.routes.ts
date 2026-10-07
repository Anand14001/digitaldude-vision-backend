import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { validateBody } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/requirePermission';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

export const settingsRouter = Router();

// Settings are read by any signed-in user and written only with the matching
// permission, so authentication is applied once for the whole router.
settingsRouter.use(requireAuth);

const ORG_KEY = 'org.profile';
const FEATURES_KEY = 'org.features';

const orgProfile = z.object({
  name: z.string().trim().min(2).max(160).default('Digital Dude'),
  legalName: z.string().trim().max(200).optional(),
  tagline: z.string().trim().max(200).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().max(40).optional(),
  website: z.string().trim().max(200).optional(),
  gstin: z.string().trim().max(20).optional(),
  addressLine: z.string().trim().max(250).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(12).optional(),
  country: z.string().trim().max(80).default('India'),
  logoFileId: z.string().cuid().nullish(),
  /** Default currency for budgets and retainers. */
  currency: z.string().trim().length(3).default('INR'),
  /** IANA zone used for due-date and attendance maths. */
  timezone: z.string().trim().max(60).default('Asia/Kolkata'),
  financialYearStartMonth: z.coerce.number().int().min(1).max(12).default(4),
});

const features = z.object({
  clientPortal: z.boolean().default(true),
  timesheets: z.boolean().default(true),
  attendance: z.boolean().default(true),
  leave: z.boolean().default(true),
  performance: z.boolean().default(true),
  assets: z.boolean().default(true),
  retainers: z.boolean().default(true),
  emailNotifications: z.boolean().default(true),
});

const defaults = {
  [ORG_KEY]: orgProfile.parse({}),
  [FEATURES_KEY]: features.parse({}),
} as Record<string, unknown>;

async function readSetting<T>(key: string): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  // Missing rows fall back to defaults so a fresh install is never broken.
  return (row?.value as T) ?? (defaults[key] as T);
}

/** Org profile and feature flags are readable by any signed-in staff member. */
settingsRouter.get(
  '/org',
  asyncHandler(async (_req, res) => {
    const [profile, flags] = await Promise.all([
      readSetting<Record<string, unknown>>(ORG_KEY),
      readSetting<Record<string, unknown>>(FEATURES_KEY),
    ]);

    let logoUrl: string | null = null;
    if (profile.logoFileId) {
      const file = await prisma.fileObject.findUnique({
        where: { id: profile.logoFileId as string },
        select: { url: true },
      });
      logoUrl = file?.url ?? null;
    }

    return ok(res, { profile: { ...profile, logoUrl }, features: flags });
  }),
);

settingsRouter.put(
  '/org',
  requirePermission('settings.org.manage'),
  validateBody(orgProfile.partial()),
  asyncHandler(async (req, res) => {
    const current = await readSetting<Record<string, unknown>>(ORG_KEY);
    const next = { ...current, ...(req.body as Record<string, unknown>) };

    await prisma.setting.upsert({
      where: { key: ORG_KEY },
      create: { key: ORG_KEY, value: next as Prisma.InputJsonObject },
      update: { value: next as Prisma.InputJsonObject },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Setting',
      entityId: ORG_KEY,
      summary: 'Updated the organisation profile',
      diff: diffRecords(current, req.body as Record<string, unknown>) ?? undefined,
    });

    return ok(res, next);
  }),
);

settingsRouter.put(
  '/features',
  requirePermission('settings.org.manage'),
  validateBody(features.partial()),
  asyncHandler(async (req, res) => {
    const current = await readSetting<Record<string, unknown>>(FEATURES_KEY);
    const next = { ...current, ...(req.body as Record<string, unknown>) };

    await prisma.setting.upsert({
      where: { key: FEATURES_KEY },
      create: { key: FEATURES_KEY, value: next as Prisma.InputJsonObject },
      update: { value: next as Prisma.InputJsonObject },
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Setting',
      entityId: FEATURES_KEY,
      summary: 'Changed which modules are enabled',
      diff: diffRecords(current, req.body as Record<string, unknown>) ?? undefined,
    });

    return ok(res, next);
  }),
);

// -------------------------------------------------------- checklist templates
const checklistBody = z.object({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['ONBOARDING', 'OFFBOARDING']),
  isDefault: z.boolean().default(false),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(200),
        description: z.string().trim().max(500).optional(),
        ownerRoleHint: z.string().trim().max(60).optional(),
        dueOffsetDays: z.coerce.number().int().min(0).max(365).default(0),
      }),
    )
    .max(60),
});

settingsRouter.get(
  '/checklist-templates',
  requirePermission('settings.masters.manage', 'employees.checklist.manage'),
  asyncHandler(async (_req, res) => {
    const templates = await prisma.checklistTemplate.findMany({
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return ok(res, templates);
  }),
);

settingsRouter.post(
  '/checklist-templates',
  requirePermission('settings.masters.manage'),
  validateBody(checklistBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof checklistBody>;

    const template = await prisma.$transaction(async (tx) => {
      // Only one default per kind, or onboarding would seed twice.
      if (body.isDefault) {
        await tx.checklistTemplate.updateMany({
          where: { kind: body.kind },
          data: { isDefault: false },
        });
      }
      return tx.checklistTemplate.create({
        data: {
          name: body.name,
          kind: body.kind,
          isDefault: body.isDefault,
          items: {
            create: body.items.map((item, index) => ({ ...item, sortOrder: index })),
          },
        },
        include: { items: true },
      });
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'ChecklistTemplate',
      entityId: template.id,
      entityLabel: template.name,
      summary: `Created ${body.kind.toLowerCase()} checklist "${template.name}"`,
    });

    return created(res, template);
  }),
);

settingsRouter.put(
  '/checklist-templates/:id',
  requirePermission('settings.masters.manage'),
  validateBody(checklistBody),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof checklistBody>;
    const existing = await prisma.checklistTemplate.findUnique({ where: { id: req.params.id } });
    if (!existing) throw notFound('Checklist template');

    const template = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.checklistTemplate.updateMany({
          where: { kind: body.kind, id: { not: existing.id } },
          data: { isDefault: false },
        });
      }
      // Items are rewritten wholesale; already-seeded employee items keep their
      // own copies, so nothing in flight is disturbed.
      await tx.checklistTemplateItem.deleteMany({ where: { templateId: existing.id } });
      return tx.checklistTemplate.update({
        where: { id: existing.id },
        data: {
          name: body.name,
          kind: body.kind,
          isDefault: body.isDefault,
          items: {
            create: body.items.map((item, index) => ({ ...item, sortOrder: index })),
          },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'ChecklistTemplate',
      entityId: template.id,
      entityLabel: template.name,
      summary: `Updated checklist "${template.name}"`,
    });

    return ok(res, template);
  }),
);

settingsRouter.delete(
  '/checklist-templates/:id',
  requirePermission('settings.masters.manage'),
  asyncHandler(async (req, res) => {
    const template = await prisma.checklistTemplate.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!template) throw notFound('Checklist template');

    await prisma.checklistTemplate.delete({ where: { id: template.id } });
    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'ChecklistTemplate',
      entityId: template.id,
      entityLabel: template.name,
      summary: `Deleted checklist "${template.name}"`,
    });
    return noContent(res);
  }),
);

/** Sequence counters, so an admin can see and align the numbering. */
settingsRouter.get(
  '/sequences',
  requirePermission('settings.org.manage'),
  asyncHandler(async (_req, res) => {
    const sequences = await prisma.sequence.findMany({ orderBy: { key: 'asc' } });
    return ok(res, sequences);
  }),
);
