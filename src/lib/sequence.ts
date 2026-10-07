import { prisma } from './prisma';
import type { Prisma } from '@prisma/client';

/**
 * Atomically increments a named counter and formats it, e.g. PRJ-0042.
 * Runs inside the caller's transaction when one is supplied so a failed create
 * does not burn a number.
 */
export async function nextSequence(
  key: string,
  prefix: string,
  tx: Prisma.TransactionClient = prisma,
  pad = 4,
): Promise<string> {
  const row = await tx.sequence.upsert({
    where: { key },
    create: { key, current: 1 },
    update: { current: { increment: 1 } },
  });
  return `${prefix}-${String(row.current).padStart(pad, '0')}`;
}
