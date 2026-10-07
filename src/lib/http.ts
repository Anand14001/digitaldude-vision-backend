import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wraps an async handler so rejected promises reach the error middleware. */
export const asyncHandler =
  <T>(fn: (req: Request, res: Response, next: NextFunction) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res, next).catch(next);
  };

export const ok = <T>(res: Response, data: T) => res.json({ data });

export const created = <T>(res: Response, data: T) => res.status(201).json({ data });

export const noContent = (res: Response) => res.status(204).send();

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const paged = <T>(res: Response, items: T[], meta: PageMeta) =>
  res.json({ data: items, meta });
