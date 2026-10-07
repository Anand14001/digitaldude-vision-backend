import type { RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { badRequest } from '../lib/errors';

const format = (error: ZodError) =>
  error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));

/**
 * Validates and REPLACES the request part with the parsed result, so handlers
 * always work with coerced, trimmed, known-shape data.
 */
export const validate = <B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny>(
  schemas: { body?: B; query?: Q; params?: P },
): RequestHandler => {
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body) as z.infer<B>;
      if (schemas.query) {
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query) as z.infer<Q>,
          writable: true,
          configurable: true,
        });
      }
      if (schemas.params) req.params = schemas.params.parse(req.params) as never;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(badRequest('Validation failed', format(error)));
      }
      next(error);
    }
  };
};

export const validateBody = <T extends ZodTypeAny>(schema: T) => validate({ body: schema });
export const validateQuery = <T extends ZodTypeAny>(schema: T) => validate({ query: schema });
