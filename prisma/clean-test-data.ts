/**
 * Removes anything the live test suites created.
 *
 *   npm run db:clean-tests
 *
 * The suites name everything with a known prefix, so this deletes exactly those
 * records and nothing else. Run it after pointing the tests at a database you
 * care about.
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

/** Prefixes used by tests/smoke.mjs, tests/portal-scoping.mjs and tests/project-kind.mjs. */
const PREFIXES = ['SMOKE ', 'PORTAL ', 'KIND '];
const CONTACT_DOMAIN = '@example.invalid';

async function main() {
  const nameFilter = { OR: PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })) };

  const projects = await prisma.project.findMany({
    where: nameFilter,
    select: { id: true, code: true, name: true },
  });
  const clients = await prisma.client.findMany({
    where: nameFilter,
    select: { id: true, name: true },
  });
  const deliverables = await prisma.deliverable.findMany({
    where: { OR: PREFIXES.map((prefix) => ({ title: { startsWith: prefix } })) },
    select: { id: true },
  });
  const tasks = await prisma.task.findMany({
    where: { OR: PREFIXES.map((prefix) => ({ title: { startsWith: prefix } })) },
    select: { id: true },
  });
  const portalUsers = await prisma.user.findMany({
    where: { kind: 'CLIENT', email: { endsWith: CONTACT_DOMAIN } },
    select: { id: true, email: true },
  });

  if (
    !projects.length &&
    !clients.length &&
    !deliverables.length &&
    !tasks.length &&
    !portalUsers.length
  ) {
    console.log('\nNothing to clean.\n');
    return;
  }

  console.log('\nRemoving:');
  console.log(`  ${clients.length} client(s), ${projects.length} project(s)`);
  console.log(`  ${tasks.length} task(s), ${deliverables.length} deliverable(s)`);
  console.log(`  ${portalUsers.length} portal account(s)\n`);

  const projectIds = projects.map((entry) => entry.id);
  const clientIds = clients.map((entry) => entry.id);

  // Ordered so nothing is left pointing at a deleted parent. Most children
  // cascade, but time entries and the audit trail are deliberately not cascaded.
  await prisma.timeEntry.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.deliverable.deleteMany({ where: { id: { in: deliverables.map((d) => d.id) } } });
  await prisma.task.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
  await prisma.task.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.projectStageHistory.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.milestone.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.calendarEvent.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.fileObject.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });

  await prisma.clientContact.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: portalUsers.map((u) => u.id) } } });

  // Comments are keyed by entity id rather than a foreign key, so clear them too.
  await prisma.comment.deleteMany({
    where: { entityId: { in: [...projectIds, ...clientIds, ...deliverables.map((d) => d.id)] } },
  });

  console.log('Done. Audit log entries are kept on purpose — the trail is append-only.\n');
}

main()
  .catch((error) => {
    console.error('\nFailed:', error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
