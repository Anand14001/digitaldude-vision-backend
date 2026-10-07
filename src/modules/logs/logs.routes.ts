import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ok, paged } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/requirePermission';
import { pageMeta, paginationSchema, skipTake } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import { auditFromRequest } from '../../lib/audit';

export const logsRouter = Router();

const ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'RESTORE',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PERMISSION_CHANGE',
  'STATUS_CHANGE',
  'STAGE_CHANGE',
  'APPROVE',
  'REJECT',
  'EXPORT',
  'FILE_UPLOAD',
  'FILE_DELETE',
] as const;

const listQuery = paginationSchema.extend({
  actorId: z.string().cuid().optional(),
  action: z.enum(ACTIONS).optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * The activity log is read-only by design: there is no endpoint that edits or
 * deletes a row, so the trail cannot be rewritten from inside the product.
 */
logsRouter.get(
  '/',
  requirePermission('logs.view'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const where = {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: q.from } : {}),
              ...(q.to ? { lte: q.to } : {}),
            },
          }
        : {}),
      ...(q.q
        ? {
            OR: [
              { summary: { contains: q.q, mode: 'insensitive' as const } },
              { actorLabel: { contains: q.q, mode: 'insensitive' as const } },
              { entityLabel: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: { select: { id: true, name: true, email: true, kind: true } },
        },
        ...skipTake(q),
      }),
      prisma.activityLog.count({ where }),
    ]);

    return paged(res, items, pageMeta(q, total));
  }),
);

/** Timeline for one record, used by the "History" tab on detail screens. */
logsRouter.get(
  '/entity/:entityType/:entityId',
  requirePermission('logs.view'),
  asyncHandler(async (req, res) => {
    const logs = await prisma.activityLog.findMany({
      where: { entityType: req.params.entityType, entityId: req.params.entityId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { actor: { select: { id: true, name: true } } },
    });
    return ok(res, logs);
  }),
);

/** Distinct entity types present in the log, for the filter dropdown. */
logsRouter.get(
  '/entity-types',
  requirePermission('logs.view'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.activityLog.groupBy({
      by: ['entityType'],
      _count: { _all: true },
      orderBy: { _count: { entityType: 'desc' } },
      take: 50,
    });
    return ok(res, rows.map((r) => ({ entityType: r.entityType, count: r._count._all })));
  }),
);

/**
 * CSV export; exporting is itself an audited action. It needs `logs.view` like
 * every other read here - a general report-export right must not become a side
 * door into the audit trail.
 */
logsRouter.get(
  '/export',
  requirePermission('logs.view'),
  validate({ query: listQuery.omit({ page: true, pageSize: true }) }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as Omit<z.infer<typeof listQuery>, 'page' | 'pageSize'>;
    const logs = await prisma.activityLog.findMany({
      where: {
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.action ? { action: q.action } : {}),
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: q.from } : {}),
                ...(q.to ? { lte: q.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20_000,
    });

    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };

    const csv = [
      ['Timestamp', 'Actor', 'Action', 'Entity type', 'Entity', 'Summary', 'IP'].join(','),
      ...logs.map((log) =>
        [
          log.createdAt.toISOString(),
          log.actorLabel,
          log.action,
          log.entityType,
          log.entityLabel ?? log.entityId ?? '',
          log.summary,
          log.ip ?? '',
        ]
          .map(escape)
          .join(','),
      ),
    ].join('\n');

    await auditFromRequest(req, {
      action: 'EXPORT',
      entityType: 'ActivityLog',
      summary: `Exported ${logs.length} activity log row(s)`,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="activity-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(csv);
  }),
);
