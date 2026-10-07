import 'dotenv/config';
import { z } from 'zod';

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_URL: z.string().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().optional(),

  WEB_ORIGINS: z.string().default('http://localhost:5173'),

  STORAGE_PROVIDER: z.enum(['local', 'cloudinary', 's3']).default('local'),
  LOCAL_UPLOAD_DIR: z.string().default('./uploads'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Vision <no-reply@digital-dude.com>'),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@digital-dude.com'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe!2026'),
  SEED_DEMO_DATA: bool(true),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // Fail fast and loudly: a half-configured API is worse than one that refuses to boot.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isDev: raw.NODE_ENV === 'development',
  webOrigins: raw.WEB_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

if (env.isProd) {
  const weak = ['replace_me_access', 'replace_me_refresh'];
  if (weak.includes(env.JWT_ACCESS_SECRET) || weak.includes(env.JWT_REFRESH_SECRET)) {
    console.error('Refusing to start in production with placeholder JWT secrets.');
    process.exit(1);
  }
}
