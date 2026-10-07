import type { AuditAction, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from './prisma';
import { logger } from './logger';

export interface AuditActor {
  id?: string | null;
  label: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AuditInput {
  actor: AuditActor;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  summary: string;
  /** JSON-safe field map; written through Prisma's JSON column. */
  diff?: Record<string, unknown> | null;
}

/** Fields that must never be written into the audit diff. */
const SENSITIVE = new Set([
  'passwordHash',
  'password',
  'inviteToken',
  'resetToken',
  'tokenHash',
]);

/** Fields that change on every write and would otherwise bloat every diff. */
const NOISE = new Set(['updatedAt', 'createdAt']);

type Diff = Record<string, { from: unknown; to: unknown }>;

const normalise = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  // Prisma Decimal and similar wrappers serialise usefully via toString.
  if (value && typeof value === 'object' && 'toFixed' in (value as object)) {
    return String(value);
  }
  return value ?? null;
};

/**
 * Field-level diff of two records. Only keys present in `after` are compared,
 * so passing a partial update payload produces a diff of just what changed.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown>,
): Diff | null {
  const diff: Diff = {};
  for (const [key, rawTo] of Object.entries(after)) {
    if (SENSITIVE.has(key) || NOISE.has(key)) continue;
    const to = normalise(rawTo);
    const from = normalise(before?.[key]);
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to };
  }
  return Object.keys(diff).length ? diff : null;
}

/** Pulls actor identity off the request; falls back to a system actor. */
export function actorFrom(req: Request): AuditActor {
  const user = req.auth?.user;
  return {
    id: user?.id ?? null,
    label: user ? `${user.name} <${user.email}>` : 'system',
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
  };
}

/**
 * Writes an audit row. Deliberately never throws: losing an audit line must not
 * fail the user's request, but it must be visible in the logs.
 */
export async function recordAudit(
  input: AuditInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  try {
    await tx.activityLog.create({
      data: {
        actorId: input.actor.id ?? null,
        actorLabel: input.actor.label,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityLabel: input.entityLabel ?? null,
        summary: input.summary,
        diff: (input.diff ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: input.actor.ip ?? null,
        userAgent: input.actor.userAgent?.slice(0, 255) ?? null,
      },
    });
  } catch (error) {
    logger.error({ error, audit: input.summary }, 'failed to write audit log');
  }
}

/** Convenience wrapper for the common "actor did X to entity" case. */
export async function auditFromRequest(
  req: Request,
  input: Omit<AuditInput, 'actor'>,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  await recordAudit({ ...input, actor: actorFrom(req) }, tx);
}
