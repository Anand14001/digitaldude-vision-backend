/**
 * What a staff member without delivery rights may actually do.
 *
 * Every staff account gets a baseline so the app is usable on day one, and that
 * baseline once included `tasks.update.assigned` - full edit rights over your
 * own tasks. So an HR account, with no task permission on its role at all, got
 * an Edit button on a task someone had assigned to it. The baseline now grants
 * `tasks.status.assigned` instead: move your own work along, edit nothing.
 *
 * These checks run as Meena (HR & Accounts), the narrowest realistic case.
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

const admin = await req('POST', '/auth/login', {
  body: {
    email: process.env.SEED_ADMIN_EMAIL ?? 'admin@digital-dude.com',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
  },
});
expect('admin signs in', admin.status, 200);
const A = { token: admin.data.accessToken };

const staff = await req('POST', '/auth/login', {
  body: {
    email: process.env.TEST_STAFF_EMAIL ?? 'meena@digital-dude.com',
    password: process.env.TEST_STAFF_PASSWORD ?? 'meena@dd123',
  },
});
expect('HR account signs in', staff.status, 200);
const M = { token: staff.data.accessToken };

const me = await req('GET', '/auth/me', M);
const myEmployeeId = me.data?.user?.employee?.id;
expect('it is a staff account with an employee record', Boolean(myEmployeeId), true);
expect('its role grants no task editing', me.data?.permissions?.includes('tasks.update'), false);
expect('nor editing its own tasks', me.data?.permissions?.includes('tasks.update.assigned'), false);
expect(
  'but it may move its own work along',
  me.data?.permissions?.includes('tasks.status.assigned'),
  true,
);

// ---- the activity log is the administrator's ----
expect('the activity log is refused', (await req('GET', '/logs', M)).status, 403);
expect('its filters are refused', (await req('GET', '/logs/entity-types', M)).status, 403);
expect(
  'and the CSV export is not a side door',
  (await req('GET', '/logs/export', M)).status,
  403,
);
const dash = await req('GET', '/dashboard', M);
expect('the dashboard loads', dash.status, 200);
expect('without a recent-activity feed', dash.data?.recentActivity, undefined);
expect('the administrator still sees the log', (await req('GET', '/logs', A)).status, 200);

// ---- a task of their own, set up by the admin ----
const project = (await req('GET', '/projects?pageSize=1', A)).data?.[0];
expect('a project to work in', Boolean(project), true);

const board = await req('GET', `/tasks/board?projectId=${project.id}`, A);
const columns = board.data?.columns ?? [];
expect('the project has a workflow', columns.length > 0, true);
const firstStatus = columns[0]?.status?.id;
const otherStatus = columns[1]?.status?.id ?? firstStatus;

const mine = await req('POST', '/tasks', {
  ...A,
  body: {
    title: `SMOKE Access Own ${stamp}`,
    projectId: project.id,
    statusId: firstStatus,
    assigneeId: myEmployeeId,
    priority: 'MEDIUM',
  },
});
expect('admin assigns them a task', mine.status, 201);

const theirs = await req('POST', '/tasks', {
  ...A,
  body: {
    title: `SMOKE Access Other ${stamp}`,
    projectId: project.id,
    statusId: firstStatus,
    priority: 'MEDIUM',
  },
});
expect('and leaves another unassigned', theirs.status, 201);

// ---- the status dropdown needs the statuses, and they come with the task ----
const detail = await req('GET', `/tasks/${mine.data.id}`, M);
expect('they can open their own task', detail.status, 200);
expect(
  'the task carries the statuses it may take',
  (detail.data?.statusOptions ?? []).length > 0,
  true,
);
expect(
  'every option is named for the dropdown',
  (detail.data?.statusOptions ?? []).every((s) => s.id && s.name),
  true,
);
// The reason the options travel with the task: the project behind it is not
// theirs to read, and the dropdown used to be populated from there.
expect(
  'while the project behind it stays out of reach',
  (await req('GET', `/projects/${project.id}`, M)).status,
  404,
);

// ---- status: yes. editing: no. ----
const setStatus = await req('PATCH', `/tasks/${mine.data.id}`, {
  ...M,
  body: { statusId: otherStatus },
});
expect('they can set the status of their own task', setStatus.status, 200);
expect('and it took effect', setStatus.data?.statusId, otherStatus);

const drag = await req('POST', `/tasks/${mine.data.id}/move`, {
  ...M,
  body: { statusId: firstStatus, sortOrder: 0 },
});
expect('they can drag their own card on the board', drag.status, 200);

const rename = await req('PATCH', `/tasks/${mine.data.id}`, {
  ...M,
  body: { title: `SMOKE Renamed ${stamp}` },
});
expect('they cannot rename their own task', rename.status, 403);

const reschedule = await req('PATCH', `/tasks/${mine.data.id}`, {
  ...M,
  body: { dueDate: new Date(Date.now() + 86_400_000).toISOString() },
});
expect('nor change its due date', reschedule.status, 403);

const reassign = await req('PATCH', `/tasks/${mine.data.id}`, {
  ...M,
  body: { assigneeId: null },
});
expect('nor hand it to someone else', reassign.status, 403);

// A status change smuggled in alongside an edit is still an edit.
const smuggled = await req('PATCH', `/tasks/${mine.data.id}`, {
  ...M,
  body: { statusId: otherStatus, title: `SMOKE Smuggled ${stamp}` },
});
expect('a status change does not carry an edit with it', smuggled.status, 403);

// ---- someone else's task is not theirs to touch ----
const othersStatus = await req('PATCH', `/tasks/${theirs.data.id}`, {
  ...M,
  body: { statusId: otherStatus },
});
expect("they cannot move a colleague's task", othersStatus.status, [403, 404]);
expect(
  "nor drag it",
  (await req('POST', `/tasks/${theirs.data.id}/move`, { ...M, body: { statusId: otherStatus } }))
    .status,
  [403, 404],
);
expect(
  'nor delete anything',
  (await req('DELETE', `/tasks/${mine.data.id}`, M)).status,
  403,
);

// ---- their own checklist: tick yes, rewrite no ----
const step = await req('POST', `/tasks/${mine.data.id}/checklist`, {
  ...A,
  body: { label: 'Collect the signed copy' },
});
expect('admin adds a checklist step', step.status, 201);
expect(
  'they can tick their own step off',
  (await req('PATCH', `/tasks/checklist/${step.data.id}`, { ...M, body: { completed: true } }))
    .status,
  200,
);
expect(
  'but not rewrite it',
  (await req('PATCH', `/tasks/checklist/${step.data.id}`, { ...M, body: { label: 'Something else' } }))
    .status,
  403,
);
expect(
  'nor add a step of their own',
  (await req('POST', `/tasks/${mine.data.id}/checklist`, { ...M, body: { label: 'Mine' } })).status,
  403,
);

// ---- projects are not theirs to edit either ----
expect(
  'they cannot edit a project',
  (await req('PATCH', `/projects/${project.id}`, { ...M, body: { name: `SMOKE Hijack ${stamp}` } }))
    .status,
  403,
);
expect(
  'nor create one',
  (await req('POST', '/projects', { ...M, body: { name: `SMOKE New ${stamp}`, kind: 'INTERNAL' } }))
    .status,
  403,
);
expect(
  'nor change its members',
  (
    await req('PUT', `/projects/${project.id}/members`, {
      ...M,
      body: { members: [{ employeeId: myEmployeeId, isLead: true, roleIds: [] }] },
    })
  ).status,
  403,
);

// ---- the project is unchanged by all of that ----
const after = await req('GET', `/projects/${project.id}`, A);
expect('the project kept its name', after.data?.name, project.name);

// ---- tidy up ----
await req('DELETE', `/tasks/${mine.data.id}`, A);
await req('DELETE', `/tasks/${theirs.data.id}`, A);

let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} task access checks passed`);
if (failed) process.exit(1);
