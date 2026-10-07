/**
 * Internal vs client projects.
 *
 * A project is either delivered for a client or is the agency's own work. The
 * two must stay coherent: client work names a client, internal work never does,
 * and internal work must be invisible to every client portal.
 */
import { execSync } from 'node:child_process';

const BASE = process.env.API_URL ?? 'http://localhost:4001';
const checks = [];

function expect(name, actual, wanted) {
  const ok = Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted;
  checks.push({ name, ok, detail: `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}` });
}

async function req(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, data: parsed?.data ?? null, error: parsed?.error ?? null };
}

const stamp = Date.now().toString().slice(-6);
const contactEmail = `kind${stamp}@example.invalid`;

const login = await req('POST', '/auth/login', {
  body: {
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@digital-dude.com',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
  },
});
expect('admin signs in', login.status, 200);
const A = { token: login.data.accessToken };

const workflows = await req('GET', '/workflows', A);
const workflowId = workflows.data[0].id;

// ---- a client is needed for client work ----
const client = await req('POST', '/clients', {
  ...A,
  body: { name: `KIND Client ${stamp}`, status: 'ACTIVE', serviceLineIds: [] },
});
const clientId = client.data.id;

// ---- the pairing is enforced in both directions ----
const missingClient = await req('POST', '/projects', {
  ...A,
  body: { name: `KIND bad ${stamp}`, kind: 'CLIENT', workflowId, memberIds: [] },
});
expect('client project without a client is refused', missingClient.status, 400);

const internalWithClient = await req('POST', '/projects', {
  ...A,
  body: {
    name: `KIND bad2 ${stamp}`,
    kind: 'INTERNAL',
    clientId,
    workflowId,
    memberIds: [],
  },
});
expect('internal project with a client is refused', internalWithClient.status, 400);

// ---- both kinds create cleanly ----
const clientProject = await req('POST', '/projects', {
  ...A,
  body: {
    name: `KIND Client Project ${stamp}`,
    kind: 'CLIENT',
    clientId,
    workflowId,
    visibleToClient: true,
    memberIds: [],
    seedDefaultTasks: false,
  },
});
expect('create client project', clientProject.status, 201);
expect('client project keeps its client', clientProject.data?.clientId, clientId);

const internalProject = await req('POST', '/projects', {
  ...A,
  body: {
    name: `KIND Internal Project ${stamp}`,
    kind: 'INTERNAL',
    workflowId,
    // Deliberately ticked: internal work must override it.
    visibleToClient: true,
    memberIds: [],
    seedDefaultTasks: false,
  },
});
expect('create internal project', internalProject.status, 201);
expect('internal project has no client', internalProject.data?.clientId, null);
expect(
  'internal project is forced out of the portal',
  internalProject.data?.visibleToClient,
  false,
);

// ---- it behaves like a project in every other respect ----
const detail = await req('GET', `/projects/${internalProject.data.id}`, A);
expect('internal project detail loads', detail.status, 200);
expect('internal project has its workflow stages', detail.data?.workflow?.stages?.length > 0, true);

const stage = detail.data.workflow.stages[1] ?? detail.data.workflow.stages[0];
expect(
  'internal project moves stage',
  (await req('POST', `/projects/${internalProject.data.id}/stage`, {
    ...A,
    body: { stageId: stage.id, seedDefaultTasks: true },
  })).status,
  200,
);

// ---- filtering by kind ----
const internalOnly = await req('GET', '/projects?kind=INTERNAL&pageSize=50', A);
expect('filter returns internal projects', internalOnly.status, 200);
expect(
  'internal filter excludes client work',
  internalOnly.data?.every((entry) => entry.kind === 'INTERNAL'),
  true,
);
const clientOnly = await req('GET', '/projects?kind=CLIENT&pageSize=50', A);
expect(
  'client filter excludes internal work',
  clientOnly.data?.every((entry) => entry.kind === 'CLIENT' && entry.client),
  true,
);

// ---- reclassification stays coherent ----
expect(
  'cannot strip the client without going internal',
  (await req('PATCH', `/projects/${clientProject.data.id}`, { ...A, body: { clientId: null } })).status,
  400,
);
expect(
  'converting to internal clears the client',
  (await req('PATCH', `/projects/${clientProject.data.id}`, {
    ...A,
    body: { kind: 'INTERNAL', clientId: null },
  })).status,
  200,
);
const converted = await req('GET', `/projects/${clientProject.data.id}`, A);
expect('converted project has no client', converted.data?.clientId, null);
expect('converted project left the portal', converted.data?.visibleToClient, false);

// ---- the portal must never see internal work ----
const contact = await req('POST', `/clients/${clientId}/contacts`, {
  ...A,
  body: { name: 'Kind Contact', email: contactEmail, isPrimary: true },
});
await req('POST', `/clients/contacts/${contact.data.id}/portal-access`, {
  ...A,
  body: { canApprove: false },
});

const inviteToken = execSync(`npx tsx prisma/print-invite-token.ts ${contactEmail}`, {
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/)
  .pop();

const accepted = await req('POST', '/auth/accept-invite', {
  body: { token: inviteToken, password: 'PortalKind@2026' },
});
expect('portal contact accepts the invite', accepted.status, 200);
const P = { token: accepted.data.accessToken };

const overview = await req('GET', '/portal/overview', P);
expect('portal overview loads', overview.status, 200);
expect(
  'portal lists no internal projects',
  overview.data?.projects?.every((entry) => entry.id !== internalProject.data.id),
  true,
);
expect(
  'portal cannot open an internal project by id',
  (await req('GET', `/portal/projects/${internalProject.data.id}`, P)).status,
  404,
);

// ---- report ----
let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} project-kind checks passed`);
console.log(
  `(left behind: client ${clientId}, projects ${clientProject.data?.id}, ${internalProject.data?.id})`,
);
if (failed) process.exit(1);
