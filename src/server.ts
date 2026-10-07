import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { disconnectPrisma, prisma } from './lib/prisma';
import { startScheduledJobs, stopScheduledJobs } from './jobs';

async function main(): Promise<void> {
  // Fail fast if the database is unreachable rather than serving 500s.
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info('database connection established');
  } catch (error) {
    logger.fatal({ error }, 'cannot reach the database - check DATABASE_URL');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, origins: env.webOrigins },
      `Digital Dude CRM API listening on http://localhost:${env.PORT}`,
    );
  });

  startScheduledJobs();

  // Drain in-flight requests before exiting so a deploy does not cut people off.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopScheduledJobs();
    server.close(async () => {
      await disconnectPrisma();
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('forcing shutdown after 10s');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'uncaught exception - exiting');
    process.exit(1);
  });
}

void main();
