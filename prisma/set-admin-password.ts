/**
 * Sets the administrator's password from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
 *
 *   npm run admin:password
 *
 * Useful for first setup and for recovering access without touching the
 * database by hand. Existing sessions for that account are revoked, since they
 * were issued against the old credential.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { validatePasswordStrength } from '../src/lib/password';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@digital-dude.com').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!password) {
    console.error('SEED_ADMIN_PASSWORD is not set in .env');
    process.exit(1);
  }

  // The in-app change-password endpoint enforces this policy, so warn when the
  // chosen password could not be set from inside the product.
  const problems = validatePasswordStrength(password);
  if (problems.length) {
    console.warn(
      `\nNote: this password ${problems.join(', ')}, so the in-app password form would reject it.\n` +
        'It still works for signing in; relax the policy in src/lib/password.ts if you want them to agree.\n',
    );
  }

  const user = await prisma.user.update({
    where: { email },
    data: {
      passwordHash: await bcrypt.hash(password, 12),
      // Cleared so the chosen password works immediately instead of bouncing
      // to the forced-change screen.
      mustChangePassword: false,
      status: 'ACTIVE',
    },
    select: { email: true, status: true, mustChangePassword: true },
  });

  await prisma.refreshToken.updateMany({
    where: { user: { email }, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  console.log(`\nPassword set for ${user.email}`);
  console.log(`  status: ${user.status}, must change on sign-in: ${user.mustChangePassword}\n`);
}

main()
  .catch((error) => {
    console.error('\nFailed:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
