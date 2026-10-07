import { Router, type RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { asyncHandler, created, noContent, ok, paged } from './http';
import { pageMeta, paginationSchema, skipTake } from './pagination';
import { validate } from '../middleware/validate';
import { requirePermission } from '../middleware/requirePermission';
import { auditFromRequest } from './audit';
import { diffRecords } from './audit';
import { notFound } from './errors';
import { prisma } from './prisma';

/**
 * Master-data entities (departments, skills, leave types, holidays and friends)
 * are all the same CRUD shape. Factoring them out keeps ~400 lines of identical
 * handlers from being written nine times - and means audit logging and
 * permission checks cannot be forgotten on one of them.
 *
 * Anything with real behaviour (projects, tasks, leave approval) is written by
 * hand instead; this is only for flat reference tables.
 */

type Delegate = {
  findMany: (args: unknown) => Promise<unknown[]>;
  findUnique: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<number>;
  create: (args: unknown) => Promise<{ id: string } & Record<string, unknown>>;
  update: (args: unknown) => Promise<{ id: string } & Record<string, unknown>>;
  delete: (args: unknown) => Promise<unknown>;
};

export interface CrudOptions {
  /** Prisma model key, e.g. 'department'. */
  model: keyof typeof prisma;
  /** Human label used in audit lines and error messages. */
  label: string;
  /** Field used as the entity label in the audit trail. */
  labelField?: string;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  /** Permission needed to read; defaults to the write permission. */
  readPermission?: string | string[];
  writePermission: string;
  /** Columns that free-text search looks at. */
  searchFields?: string[];
  /** Columns a client may sort by. */
  sortFields?: readonly string[];
  defaultSort?: string;
  defaultOrder?: 'asc' | 'desc';
  /** Relations to include on list and read. */
  include?: Record<string, unknown>;
  /** Extra guards to run before every route in this router. */
  middleware?: RequestHandler[];
  /** Optional hook to reject a delete, e.g. when the row is still referenced. */
  beforeDelete?: (id: string) => Promise<void>;
}

export function crudRouter(options: CrudOptions): Router {
  const router = Router();
  const delegate = prisma[options.model] as unknown as Delegate;
  const labelField = options.labelField ?? 'name';
  const readPerms = ([] as string[]).concat(
    options.readPermission ?? options.writePermission,
  );
  const sortFields = options.sortFields ?? ([labelField, 'createdAt'] as const);

  if (options.middleware?.length) router.use(...options.middleware);

  router.get(
    '/',
    requirePermission(...readPerms),
    validate({ query: paginationSchema }),
    asyncHandler(async (req, res) => {
      const query = req.query as unknown as {
        page: number;
        pageSize: number;
        sort?: string;
        order: 'asc' | 'desc';
        q?: string;
      };

      const where =
        query.q && options.searchFields?.length
          ? {
              OR: options.searchFields.map((field) => ({
                [field]: { contains: query.q, mode: 'insensitive' },
              })),
            }
          : {};

      const sort =
        query.sort && (sortFields as readonly string[]).includes(query.sort)
          ? query.sort
          : (options.defaultSort ?? labelField);

      const [items, total] = await Promise.all([
        delegate.findMany({
          where,
          include: options.include,
          orderBy: { [sort]: query.sort ? query.order : (options.defaultOrder ?? 'asc') },
          ...skipTake(query),
        }),
        delegate.count({ where }),
      ]);

      return paged(res, items, pageMeta(query, total));
    }),
  );

  router.get(
    '/:id',
    requirePermission(...readPerms),
    asyncHandler(async (req, res) => {
      const item = await delegate.findUnique({
        where: { id: req.params.id },
        include: options.include,
      });
      if (!item) throw notFound(options.label);
      return ok(res, item);
    }),
  );

  router.post(
    '/',
    requirePermission(options.writePermission),
    validate({ body: options.createSchema }),
    asyncHandler(async (req, res) => {
      const item = await delegate.create({ data: req.body });
      await auditFromRequest(req, {
        action: 'CREATE',
        entityType: options.label,
        entityId: item.id,
        entityLabel: String(item[labelField] ?? ''),
        summary: `Created ${options.label.toLowerCase()} "${String(item[labelField] ?? item.id)}"`,
        diff: diffRecords(null, req.body as Record<string, unknown>) ?? undefined,
      });
      return created(res, item);
    }),
  );

  router.patch(
    '/:id',
    requirePermission(options.writePermission),
    validate({ body: options.updateSchema }),
    asyncHandler(async (req, res) => {
      const before = (await delegate.findUnique({ where: { id: req.params.id } })) as
        | Record<string, unknown>
        | null;
      if (!before) throw notFound(options.label);

      const item = await delegate.update({ where: { id: req.params.id }, data: req.body });
      await auditFromRequest(req, {
        action: 'UPDATE',
        entityType: options.label,
        entityId: item.id,
        entityLabel: String(item[labelField] ?? ''),
        summary: `Updated ${options.label.toLowerCase()} "${String(item[labelField] ?? item.id)}"`,
        diff: diffRecords(before, req.body as Record<string, unknown>) ?? undefined,
      });
      return ok(res, item);
    }),
  );

  router.delete(
    '/:id',
    requirePermission(options.writePermission),
    asyncHandler(async (req, res) => {
      const before = (await delegate.findUnique({ where: { id: req.params.id } })) as
        | Record<string, unknown>
        | null;
      if (!before) throw notFound(options.label);
      if (options.beforeDelete) await options.beforeDelete(req.params.id as string);

      await delegate.delete({ where: { id: req.params.id } });
      await auditFromRequest(req, {
        action: 'DELETE',
        entityType: options.label,
        entityId: req.params.id,
        entityLabel: String(before[labelField] ?? ''),
        summary: `Deleted ${options.label.toLowerCase()} "${String(before[labelField] ?? req.params.id)}"`,
      });
      return noContent(res);
    }),
  );

  return router;
}
