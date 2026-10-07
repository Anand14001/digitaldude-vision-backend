import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
};

/** Maps Prisma's error codes onto honest HTTP statuses. */
function fromPrisma(error: Prisma.PrismaClientKnownRequestError) {
  switch (error.code) {
    case 'P2002': {
      const target = (error.meta?.target as string[] | undefined)?.join(', ');
      return {
        status: 409,
        code: 'DUPLICATE',
        message: target
          ? `A record with that ${target} already exists`
          : 'That record already exists',
      };
    }
    case 'P2003':
      return {
        status: 409,
        code: 'FK_CONSTRAINT',
        message: 'A linked record is missing or still referenced',
      };
    case 'P2025':
      return { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
    case 'P2014':
      return {
        status: 409,
        code: 'IN_USE',
        message: 'This record is still referenced elsewhere and cannot be removed',
      };
    default:
      return null;
  }
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof AppError) {
    if (error.status >= 500) logger.error({ error }, error.message);
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Validation failed',
        details: error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = fromPrisma(error);
    if (mapped) {
      res.status(mapped.status).json({
        error: { code: mapped.code, message: mapped.message },
      });
      return;
    }
  }

  logger.error(
    { err: error, path: req.originalUrl, method: req.method },
    'unhandled error',
  );

  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on our side',
      // Stack traces are development-only; production must not leak internals.
      ...(env.isProd ? {} : { detail: (error as Error)?.message, stack: (error as Error)?.stack }),
    },
  });
};
