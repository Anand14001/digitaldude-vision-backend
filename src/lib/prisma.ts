import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { logger } from './logger';

export const prisma = new PrismaClient({
  log: env.isDev ? [{ emit: 'event', level: 'query' }, 'warn', 'error'] : ['warn', 'error'],
});

if (env.isDev) {
  // Surfaces slow queries during development without flooding the log.
  (prisma as unknown as { $on: (e: string, cb: (ev: { duration: number; query: string }) => void) => void }).$on(
    'query',
    (ev) => {
      if (ev.duration >= 200) logger.debug({ ms: ev.duration, query: ev.query }, 'slow query');
    },
  );
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
