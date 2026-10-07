import { z } from 'zod';
import type { PageMeta } from './http';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(200).optional(),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export const skipTake = (p: { page: number; pageSize: number }) => ({
  skip: (p.page - 1) * p.pageSize,
  take: p.pageSize,
});

export const pageMeta = (
  p: { page: number; pageSize: number },
  total: number,
): PageMeta => ({
  page: p.page,
  pageSize: p.pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
});

/**
 * Builds an orderBy that only ever uses a column we explicitly allow, so a
 * query string can never sort by (or probe) an arbitrary field.
 */
export function orderByFrom<T extends string>(
  sort: string | undefined,
  order: 'asc' | 'desc',
  allowed: readonly T[],
  fallback: T,
): Record<string, 'asc' | 'desc'> {
  const column = sort && (allowed as readonly string[]).includes(sort) ? sort : fallback;
  return { [column]: order };
}
