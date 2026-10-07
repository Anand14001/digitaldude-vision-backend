/**
 * Client-portal scoping, end to end against the local dev API.
 *
 * Creates a throwaway client + project, grants a contact view-only portal
 * access, accepts the invite, then asserts that the portal account:
 *   - cannot reach any staff route
 *   - sees only its own client and project
 *   - cannot approve without the right
 *   - can message its own project team
 */
import { execSync } from 'node:child_process';

const BASE = 'http://localhost:4001/api';
const checks = [];

function expect(name, actual, wanted) {
  const ok = Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted;
  checks.push({ name, ok, detail: `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}` });
}

async function req(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
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
const contactEmail = `portal${stamp}@example.invalid`;

// ---- admin sets the scene ----
const login = await req('POST', '/auth/login', {
  body: { email: 'admin@digital-dude.com', password: 'Admin@123' },
});
expect('admin signs in', login.status, 200);
const A = { token: login.data.accessToken };

const client = await req('POST', '/clients', {
  ...A,
  body: { name: `PORTAL Client ${stamp}`, status: 'ACTIVE', serviceLineIds: [] },
});
expect('create client', client.status, 201);
const clientId = client.data.id;

const contact = await req('POST', `/clients/${clientId}/contacts`, {
  ...A,
  body: { name: 'Portal Contact', email: contactEmail, isPrimary: true },
});
expect('create contact', contact.status, 201);

const workflows = await req('GET', '/workflows', A);
const workflow = workflows.data.find((entry) => entry.stages.length > 1) ?? workflows.data[0];

const project = await req('POST', '/projects', {
  ...A,
  body: {
    name: `PORTAL Project ${stamp}`,
    clientId,
    workflowId: workflow.id,
    visibleToClient: true,
    memberIds: [],
    seedDefaultTasks: true,
  },
});
expect('create project', project.status, 201);
const projectId = project.data.id;

const deliverable = await req('POST', '/deliverables', {
  ...A,
  body: { title: `PORTAL Deliverable ${stamp}`, projectId },
});
expect('create deliverable', deliverable.status, 201);

// View-only portal access: canApprove deliberately false.
const grant = await req('POST', `/clients/contacts/${contact.data.id}/portal-access`, {
  ...A,
  body: { canApprove: false },
});
expect('grant view-only portal access', grant.status, 201);

// ---- accept the invite as the contact would from the email ----
const inviteToken = execSync(`npx tsx prisma/print-invite-token.ts ${contactEmail}`, {
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/)
  .pop();

const accepted = await req('POST', '/auth/accept-invite', {
  body: { token: inviteToken, password: 'PortalSmoke@2026' },
});
expect('contact accepts the invite', accepted.status, 200);
expect('account is a CLIENT kind', accepted.data?.user?.kind, 'CLIENT');
expect('account holds no staff permissions', accepted.data?.permissions?.length, 0);
const P = { token: accepted.data.accessToken };

// ---- staff surfaces must be closed ----
for (const [label, path] of [
  ['dashboard', '/dashboard'],
  ['projects list', '/projects'],
  ['clients', '/clients'],
  ['employees', '/employees'],
  ['tasks', '/tasks'],
  ['reports', '/reports/utilization'],
  ['logs', '/logs'],
  ['roles', '/roles'],
  ['users', '/users'],
  ['leave', '/leave/requests'],
  ['timesheets', '/time/timesheets'],
]) {
  expect(`portal: ${label} denied`, (await req('GET', path, P)).status, 403);
}

// ---- its own surface works, scoped to its own account ----
const overview = await req('GET', '/portal/overview', P);
expect('portal: overview allowed', overview.status, 200);
expect('portal: sees only its own client', overview.data?.client?.id, clientId);
expect(
  'portal: sees its own project',
  overview.data?.projects?.some((entry) => entry.id === projectId),
  true,
);
expect(
  'portal: project count is just its own',
  overview.data?.projects?.length,
  1,
);
expect('portal: approvals allowed', (await req('GET', '/portal/approvals', P)).status, 200);
expect('portal: files allowed', (await req('GET', '/portal/files', P)).status, 200);
expect('portal: contacts allowed', (await req('GET', '/portal/team', P)).status, 200);
expect(
  'portal: own project detail allowed',
  (await req('GET', `/portal/projects/${projectId}`, P)).status,
  200,
);

// ---- another client's project must not be reachable by id ----
const allProjects = await req('GET', '/projects?pageSize=50', A);
const foreign = allProjects.data?.find((entry) => entry.client.id !== clientId);
expect('found another client project to probe', Boolean(foreign), true);
if (foreign) {
  expect(
    "portal: another client's project is not found",
    (await req('GET', `/portal/projects/${foreign.id}`, P)).status,
    404,
  );
}

// ---- approving is a separate right ----
expect(
  'portal: cannot approve without the right',
  (await req('POST', `/portal/approvals/${deliverable.data.id}/decision`, {
    ...P,
    body: { decision: 'APPROVED' },
  })).status,
  403,
);

// ---- but it can talk to its team ----
expect(
  'portal: can message its project team',
  (await req('POST', `/portal/projects/${projectId}/messages`, {
    ...P,
    body: { body: 'Portal smoke test message' },
  })).status,
  201,
);

// ---- revoking access ends the session ----
expect(
  'revoke portal access',
  (await req('DELETE', `/clients/contacts/${contact.data.id}/portal-access`, A)).status,
  204,
);
expect(
  'portal: overview denied after revoke',
  (await req('GET', '/portal/overview', P)).status,
  403,
);

// ---- report ----
let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} portal checks passed`);
console.log(`(left behind for inspection: client ${clientId}, project ${projectId})`);
if (failed) process.exit(1);
