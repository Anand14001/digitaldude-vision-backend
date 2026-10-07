import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.isProd ? 'info' : 'debug',
  // Pretty output locally; structured JSON in production for log aggregators.
  transport: env.isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      '*.password',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
});
