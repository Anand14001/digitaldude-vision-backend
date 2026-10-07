import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from '../../lib/http';
import { validate, validateBody } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { orderByFrom, pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { auditFromRequest, diffRecords } from '../../lib/audit';
import { badRequest, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { leadWhere } from '../../lib/scope';
import { notify } from '../../lib/notify';

export const leadsRouter = Router();

const SORTABLE = ['createdAt', 'nextFollowUpAt', 'estimatedValue', 'status', 'title'] as const;

const SOURCES = [
  'REFERRAL',
  'INSTAGRAM',
  'FACEBOOK',
  'GOOGLE',
  'LINKEDIN',
  'WALK_IN',
  'COLD_OUTREACH',
  'WEBSITE',
  'EXISTING_CLIENT',
  'OTHER',
] as const;

const STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;

const leadBody = z.object({
  title: z.string().trim().min(2).max(160),
  companyName: z.string().trim().max(160).optional(),
  contactName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional(),
  source: z.enum(SOURCES).default('OTHER'),
  status: z.enum(STATUSES).default('NEW'),
  estimatedValue: z.coerce.number().min(0).max(1_000_000_000).optional(),
  ownerId: z.string().cuid().nullish(),
  requirement: z.string().trim().max(4000).optional(),
  nextFollowUpAt: z.coerce.date().nullish(),
  lostReason: z.string().trim().max(500).optional(),
});

const listQuery = paginationSchema.extend({
  status: z.enum(STATUSES).optional(),
  source: z.enum(SOURCES).optional(),
  ownerId: z.string().cuid().optional(),
  /** Only leads whose follow-up is today or earlier. */
  overdueFollowUp: z.coerce.boolean().optional(),
});

leadsRouter.get(
  '/',
  requirePermission('leads.view.all', 'leads.view.own'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...leadWhere(req.ctx),
      ...(q.status ? { status: q.status } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId } : {}),
      ...(q.overdueFollowUp ? { nextFollowUpAt: { lte: new Date() } } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' as const } },
              { companyName: { contains: q.q, mode: 'insensitive' as const } },
              { contactName: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
              { phone: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: orderByFrom(q.sort, q.order, SORTABLE, 'createdAt'),
        include: {
          owner: { select: { id: true, user: { select: { name: true } } } },
          client: { select: { id: true, name: true } },
          _count: { select: { activities: true } },
        },
        ...skipTake(q),
      }),
      prisma.lead.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/** Board view: leads grouped by stage, for the pipeline screen. */
leadsRouter.get(
  '/pipeline',
  requirePermission('leads.view.all', 'leads.view.own'),
  asyncHandler(async (req, res) => {
    const where = leadWhere(req.ctx);
    const [leads, totals] = await Promise.all([
      prisma.lead.findMany({
        where: { ...where, status: { notIn: ['WON', 'LOST'] } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          companyName: true,
          contactName: true,
          status: true,
          source: true,
          estimatedValue: true,
          nextFollowUpAt: true,
          owner: { select: { id: true, user: { select: { name: true } } } },
        },
        take: 500,
      }),
      prisma.lead.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { estimatedValue: true },
      }),
    ]);

    const columns = STATUSES.filter((s) => s !== 'WON' && s !== 'LOST').map((status) => ({
      status,
      leads: leads.filter((l) => l.status === status),
      count: totals.find((t) => t.status === status)?._count._all ?? 0,
      value: totals.find((t) => t.status === status)?._sum.estimatedValue ?? null,
    }));

    return ok(res, { columns, totals });
  }),
);

leadsRouter.get(
  '/:id',
  requirePermission('leads.view.all', 'leads.view.own'),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { AND: [leadWhere(req.ctx), { id: req.params.id }] },
      include: {
        owner: { select: { id: true, user: { select: { name: true, email: true } } } },
        client: { select: { id: true, name: true } },
        activities: { orderBy: { occurredAt: 'desc' } },
      },
    });
    if (!lead) throw notFound('Lead');
    return ok(res, lead);
  }),
);

leadsRouter.post(
  '/',
  requirePermission('leads.create'),
  validateBody(leadBody),
  asyncHandler(async (req, res) => {
    const data = req.body as z.infer<typeof leadBody>;
    const lead = await prisma.lead.create({
      data: {
        ...data,
        email: data.email || null,
        // Default ownership to the creator, which is almost always right.
        ownerId: data.ownerId ?? req.ctx.employeeId,
      },
    });

    await auditFromRequest(req, {
      action: 'CREATE',
      entityType: 'Lead',
      entityId: lead.id,
      entityLabel: lead.title,
      summary: `Created lead "${lead.title}"`,
      diff: diffRecords(null, data as Record<string, unknown>) ?? undefined,
    });

    return created(res, lead);
  }),
);

leadsRouter.patch(
  '/:id',
  requirePermission('leads.update'),
  validateBody(leadBody.partial()),
  asyncHandler(async (req, res) => {
    const before = await prisma.lead.findFirst({
      where: { AND: [leadWhere(req.ctx), { id: req.params.id }] },
    });
    if (!before) throw notFound('Lead');

    const data = req.body as Partial<z.infer<typeof leadBody>>;
    const statusChanged = data.status && data.status !== before.status;

    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id: before.id },
        data: {
          ...data,
          ...(data.status === 'WON' && before.status !== 'WON' ? { wonAt: new Date() } : {}),
          ...(data.status === 'LOST' && before.status !== 'LOST' ? { lostAt: new Date() } : {}),
        },
      });
      if (statusChanged) {
        // Status moves are part of the lead's story, so they land in its timeline
        // as well as the global audit log.
        await tx.leadActivity.create({
          data: {
            leadId: before.id,
            type: 'STATUS_CHANGE',
            summary: `Status moved from ${before.status} to ${data.status}`,
            createdById: req.ctx.user.id,
          },
        });
      }
      return updated;
    });

    await auditFromRequest(req, {
      action: statusChanged ? 'STATUS_CHANGE' : 'UPDATE',
      entityType: 'Lead',
      entityId: lead.id,
      entityLabel: lead.title,
      summary: statusChanged
        ? `Moved lead "${lead.title}" to ${lead.status}`
        : `Updated lead "${lead.title}"`,
      diff: diffRecords(before, data as Record<string, unknown>) ?? undefined,
    });

    return ok(res, lead);
  }),
);

leadsRouter.post(
  '/:id/activities',
  requirePermission('leads.update'),
  validateBody(
    z.object({
      type: z.enum(['CALL', 'EMAIL', 'MEETING', 'WHATSAPP', 'NOTE']),
      summary: z.string().trim().min(2).max(1000),
      occurredAt: z.coerce.date().default(() => new Date()),
      nextFollowUpAt: z.coerce.date().nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { AND: [leadWhere(req.ctx), { id: req.params.id }] },
      select: { id: true, title: true },
    });
    if (!lead) throw notFound('Lead');

    const { nextFollowUpAt, ...activity } = req.body as {
      type: 'CALL' | 'EMAIL' | 'MEETING' | 'WHATSAPP' | 'NOTE';
      summary: string;
      occurredAt: Date;
      nextFollowUpAt?: Date | null;
    };

    const record = await prisma.$transaction(async (tx) => {
      const createdActivity = await tx.leadActivity.create({
        data: { ...activity, leadId: lead.id, createdById: req.ctx.user.id },
      });
      if (nextFollowUpAt !== undefined) {
        await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUpAt } });
      }
      return createdActivity;
    });

    return created(res, record);
  }),
);

/**
 * Converts a won lead into a client account, carrying the contact across. The
 * lead row is kept and linked so the pipeline history stays intact.
 */
leadsRouter.post(
  '/:id/convert',
  requirePermission('leads.convert'),
  validateBody(
    z.object({
      clientName: z.string().trim().min(2).max(160).optional(),
      accountManagerId: z.string().cuid().nullish(),
      serviceLineIds: z.array(z.string().cuid()).max(20).default([]),
    }),
  ),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { AND: [leadWhere(req.ctx), { id: req.params.id }] },
    });
    if (!lead) throw notFound('Lead');
    if (lead.clientId) throw badRequest('This lead has already been converted');

    const name = req.body.clientName ?? lead.companyName ?? lead.contactName;

    const client = await prisma.$transaction(async (tx) => {
      const createdClient = await tx.client.create({
        data: {
          name,
          status: 'ACTIVE',
          email: lead.email,
          phone: lead.phone,
          onboardedAt: new Date(),
          accountManagerId: req.body.accountManagerId ?? lead.ownerId,
          notes: lead.requirement,
          serviceLines: {
            create: (req.body.serviceLineIds as string[]).map((serviceLineId) => ({
              serviceLineId,
            })),
          },
          contacts: {
            create: {
              name: lead.contactName,
              email: lead.email ?? `${lead.id}@placeholder.invalid`,
              phone: lead.phone,
              isPrimary: true,
            },
          },
        },
      });

      await tx.lead.update({
        where: { id: lead.id },
        data: {
          clientId: createdClient.id,
          status: 'WON',
          wonAt: lead.wonAt ?? new Date(),
        },
      });

      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          type: 'STATUS_CHANGE',
          summary: `Converted to client "${name}"`,
          createdById: req.ctx.user.id,
        },
      });

      return createdClient;
    });

    await auditFromRequest(req, {
      action: 'UPDATE',
      entityType: 'Lead',
      entityId: lead.id,
      entityLabel: lead.title,
      summary: `Converted lead "${lead.title}" into client "${name}"`,
      diff: { clientId: { from: null, to: client.id } },
    });

    if (lead.ownerId) {
      const owner = await prisma.employee.findUnique({
        where: { id: lead.ownerId },
        select: { userId: true },
      });
      if (owner) {
        await notify({
          userIds: [owner.userId],
          type: 'SYSTEM',
          title: `Lead won: ${lead.title}`,
          body: `The lead has been converted into the client account "${name}".`,
          link: `/clients/${client.id}`,
        });
      }
    }

    return created(res, client);
  }),
);

leadsRouter.delete(
  '/:id',
  requirePermission('leads.delete'),
  asyncHandler(async (req, res) => {
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!lead) throw notFound('Lead');

    await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    await auditFromRequest(req, {
      action: 'DELETE',
      entityType: 'Lead',
      entityId: lead.id,
      entityLabel: lead.title,
      summary: `Deleted lead "${lead.title}"`,
    });
    return noContent(res);
  }),
);
