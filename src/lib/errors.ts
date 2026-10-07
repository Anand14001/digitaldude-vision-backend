/** Errors the API throws deliberately; anything else becomes a 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (what = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const tooMany = (message = 'Too many requests') =>
  new AppError(429, 'RATE_LIMITED', message);
