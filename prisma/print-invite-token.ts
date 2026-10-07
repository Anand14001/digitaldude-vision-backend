/**
 * Prints a pending invite token for an email, so an invite flow can be
 * exercised without reading the mailbox.
 *
 *   npx tsx prisma/print-invite-token.ts someone@example.com
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();
const email = process.argv[2];

async function main() {
  if (!email) {
    console.error('Pass an email address.');
    process.exit(1);
  }
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase() },
    select: { inviteToken: true, inviteExpiresAt: true, status: true },
  });
  if (!user?.inviteToken) {
    console.error('No pending invite for that address.');
    process.exit(1);
  }
  console.log(user.inviteToken);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
