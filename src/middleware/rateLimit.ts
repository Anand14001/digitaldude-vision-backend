import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const message = {
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
};

/** Broad protection for the whole API. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.isProd ? 300 : 2000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});

/** Tight limit on credential endpoints to blunt password guessing. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.isProd ? 10 : 100,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Try again in a few minutes.',
    },
  },
});

/** Uploads are expensive; cap them per minute. */
export const uploadLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.isProd ? 30 : 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});
