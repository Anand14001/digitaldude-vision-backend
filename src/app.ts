import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { apiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimit';
import { prisma } from './lib/prisma';

export function createApp(): Express {
  const app = express();

  // Behind a proxy (Railway, Render, Nginx) so rate limiting and req.ip see the
  // real client address rather than the load balancer's.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and uploaded files, never its own HTML, so the
      // default CSP would only get in the way of the separate SPA origin.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // Same-origin and server-to-server calls arrive without an Origin.
        if (!origin) return callback(null, true);
        if (env.webOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/api/health',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Locally stored uploads are served straight from disk; with Cloudinary or S3
  // this route is simply never hit.
  if (env.STORAGE_PROVIDER === 'local') {
    app.use(
      '/uploads',
      express.static(path.resolve(env.LOCAL_UPLOAD_DIR), {
        // Never let an uploaded file be interpreted as active content.
        setHeaders: (res) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Disposition', 'inline');
        },
        maxAge: '7d',
        index: false,
      }),
    );
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  /** Readiness includes the database, so a deploy fails loudly if it cannot connect. */
  app.get('/health/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready', database: 'up' });
    } catch (error) {
      logger.error({ error }, 'readiness check failed');
      res.status(503).json({ status: 'unavailable', database: 'down' });
    }
  });

  app.use('/api', apiLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
