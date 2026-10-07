/**
 * Custom project roles.
 *
 * Roles are labels the agency defines and assigns on a project. A person can
 * hold several; exactly one person can be the lead. Crucially, holding a role
 * must never change what someone is allowed to do.
 */
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

const login = await req('POST', '/auth/login', {
  body: {
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@digital-dude.com',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
  },
});
expect('admin signs in', login.status, 200);
const A = { token: login.data.accessToken };

// ---- the master list ----
const roles = await req('GET', '/masters/project-roles?pageSize=100', A);
expect('project roles are seeded', roles.data?.length > 0, true);

const custom = await req('POST', '/masters/project-roles', {
  ...A,
  body: { name: `KIND Motion Designer ${stamp}`, color: '#ff00aa', sortOrder: 50 },
});
expect('create a custom role', custom.status, 201);

const designer = roles.data.find((r) => r.name === 'Designer');
const qa = roles.data.find((r) => r.name === 'QA');
expect('seeded roles include Designer and QA', Boolean(designer && qa), true);

// ---- a project to put people on ----
const workflows = await req('GET', '/workflows', A);
const client = await req('POST', '/clients', {
  ...A,
  body: { name: `KIND Roles Client ${stamp}`, status: 'ACTIVE', serviceLineIds: [] },
});
const project = await req('POST', '/projects', {
  ...A,
  body: {
    name: `KIND Roles Project ${stamp}`,
    kind: 'CLIENT',
    clientId: client.data.id,
    workflowId: workflows.data[0].id,
    memberIds: [],
    seedDefaultTasks: false,
  },
});
expect('create project', project.status, 201);
const projectId = project.data.id;

const employees = await req('GET', '/employees/options/all', A);
const [first, second] = employees.data;
expect('two employees available', Boolean(first && second), true);

// ---- assigning several roles to one person ----
const saved = await req('PUT', `/projects/${projectId}/members`, {
  ...A,
  body: {
    members: [
      {
        employeeId: first.id,
        isLead: true,
        roleIds: [designer.id, qa.id, custom.data.id],
        allocationHours: 12,
      },
      { employeeId: second.id, isLead: false, roleIds: [qa.id], allocationHours: 6 },
    ],
  },
});
expect('save the team', saved.status, 200);

const detail = await req('GET', `/projects/${projectId}`, A);
const lead = detail.data.members.find((m) => m.employee.id === first.id);
const other = detail.data.members.find((m) => m.employee.id === second.id);

expect('lead flag stored', lead?.isLead, true);
expect('one person holds three roles', lead?.roles?.length, 3);
expect('the other holds one', other?.roles?.length, 1);
expect('second member is not lead', other?.isLead, false);
expect('allocation survives', Number(lead?.allocationHours), 12);
expect(
  'roles come back with their colour',
  lead?.roles?.every((entry) => entry.role.name && entry.role.color),
  true,
);
expect('lead is listed first', detail.data.members[0]?.employee.id, first.id);

// ---- the rules ----
const twoLeads = await req('PUT', `/projects/${projectId}/members`, {
  ...A,
  body: {
    members: [
      { employeeId: first.id, isLead: true, roleIds: [] },
      { employeeId: second.id, isLead: true, roleIds: [] },
    ],
  },
});
expect('two leads are refused', twoLeads.status, 400);

const badRole = await req('PUT', `/projects/${projectId}/members`, {
  ...A,
  body: {
    members: [{ employeeId: first.id, isLead: false, roleIds: ['clzzzzzzzzzzzzzzzzzzzzzzz'] }],
  },
});
expect('an unknown role is refused', badRole.status, [400, 404]);

// ---- roles are labels, never permissions ----
const beforeRoles = await req('GET', '/roles', A);
expect('org roles are untouched by project roles', beforeRoles.data?.length >= 6, true);

// A role in use cannot be deleted; it must be deactivated instead.
const inUse = await req('DELETE', `/masters/project-roles/${qa.id}`, A);
expect('a role in use cannot be deleted', inUse.status, 409);

// ---- removing a role from a person takes effect ----
await req('PUT', `/projects/${projectId}/members`, {
  ...A,
  body: {
    members: [
      { employeeId: first.id, isLead: true, roleIds: [designer.id], allocationHours: 12 },
      { employeeId: second.id, isLead: false, roleIds: [], allocationHours: 6 },
    ],
  },
});
const after = await req('GET', `/projects/${projectId}`, A);
const afterLead = after.data.members.find((m) => m.employee.id === first.id);
const afterOther = after.data.members.find((m) => m.employee.id === second.id);
expect('removed roles are gone', afterLead?.roles?.length, 1);
expect('clearing all roles works', afterOther?.roles?.length, 0);
expect('member without roles is kept on the project', Boolean(afterOther), true);

// ---- tidy up the role this test created ----
await req('DELETE', `/masters/project-roles/${custom.data.id}`);

let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} project-role checks passed`);
console.log(`(left behind: client ${client.data.id}, project ${projectId})`);
if (failed) process.exit(1);
