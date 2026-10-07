/**
 * Exercises every endpoint the web client calls, as the admin would.
 * Reports status per route so a broken screen is visible without a browser.
 */
const BASE = 'http://localhost:4001/api';
const EMAIL = 'admin@digital-dude.com';
const PASSWORD = 'Admin@123';

let token = '';
const results = [];

async function call(method, path, body, label) {
  const name = label ?? `${method} ${path}`;
  try {
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
    const ok = response.status < 400;
    results.push({
      name,
      status: response.status,
      ok,
      note: ok ? summarise(parsed) : (parsed?.error?.message ?? text.slice(0, 120)),
    });
    return parsed?.data ?? parsed;
  } catch (error) {
    results.push({ name, status: 0, ok: false, note: String(error) });
    return null;
  }
}

function summarise(parsed) {
  const data = parsed?.data ?? parsed;
  if (Array.isArray(data)) return `${data.length} rows`;
  if (parsed?.meta?.total !== undefined) return `${parsed.meta.total} total`;
  if (data && typeof data === 'object') return `${Object.keys(data).length} fields`;
  return '';
}

const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

// ---- sign in ----
const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
token = login?.accessToken ?? '';
if (!token) {
  console.error('Could not sign in; aborting.');
  process.exit(1);
}

await call('GET', '/auth/me');

// ---- dashboard ----
await call('GET', '/dashboard');
await call('GET', '/dashboard/badges');

// ---- clients ----
const clients = await call('GET', '/clients?pageSize=5');
const clientId = clients?.[0]?.id ?? (clients?.data?.[0]?.id ?? null);
await call('GET', '/clients/options/all');
if (clientId) await call('GET', `/clients/${clientId}`);

// ---- leads ----
await call('GET', '/leads?pageSize=5');
await call('GET', '/leads/pipeline');

// ---- projects ----
const projects = await call('GET', '/projects?pageSize=5');
const project = projects?.[0] ?? null;
if (project) {
  await call('GET', `/projects/${project.id}`);
  await call('GET', `/tasks/board?projectId=${project.id}`);
  await call('POST', `/projects/${project.id}/recalculate-health`);
}

// ---- workflows ----
const workflows = await call('GET', '/workflows');
if (workflows?.[0]) {
  await call('GET', `/workflows/${workflows[0].id}`);
  await call('GET', `/projects/board?workflowId=${workflows[0].id}`);
}

// ---- retainers ----
const retainers = await call('GET', '/retainers?pageSize=5');
const retainer = retainers?.[0] ?? null;
if (retainer) {
  const full = await call('GET', `/retainers/${retainer.id}`);
  const cycleId = full?.cycles?.[0]?.id;
  if (cycleId) {
    await call('GET', `/retainers/cycles/${cycleId}`);
    await call('GET', `/tasks/board?retainerCycleId=${cycleId}`);
  }
}

// ---- tasks ----
const tasks = await call('GET', '/tasks?pageSize=5');
await call('GET', '/tasks/my');
if (tasks?.[0]) await call('GET', `/tasks/${tasks[0].id}`);

// ---- deliverables ----
const deliverables = await call('GET', '/deliverables?pageSize=5');
if (deliverables?.[0]) await call('GET', `/deliverables/${deliverables[0].id}`);

// ---- employees ----
const employees = await call('GET', '/employees?pageSize=5');
await call('GET', '/employees/options/all');
await call('GET', '/employees/workload');
if (employees?.[0]) {
  await call('GET', `/employees/${employees[0].id}`);
  await call('GET', `/employees/${employees[0].id}/team`);
}

// ---- time ----
await call('GET', '/time/entries?pageSize=5');
await call('GET', '/time/timesheets/my');
await call('GET', '/time/timesheets?pageSize=5');

// ---- attendance ----
await call('GET', '/attendance/today');
await call('GET', '/attendance/my');
await call('GET', '/attendance?pageSize=5');
await call('GET', '/attendance/monthly');

// ---- leave ----
await call('GET', '/leave/balances/my');
await call('GET', '/leave/balances');
await call('GET', '/leave/requests?pageSize=5');
await call('GET', '/leave/on-leave');

// ---- performance ----
await call('GET', '/performance/cycles');
await call('GET', '/performance/reviews?pageSize=5');
await call('GET', '/performance/reviews/my');
await call('GET', '/performance/goals?pageSize=5');

// ---- calendar ----
await call(
  'GET',
  `/calendar?from=${monthAgo}T00:00:00.000Z&to=${today}T23:59:59.000Z`,
);

// ---- reports ----
await call('GET', `/reports/project-delivery?from=${monthAgo}&to=${today}`);
await call('GET', `/reports/utilization?from=${monthAgo}&to=${today}`);
await call('GET', `/reports/stage-cycle-time?from=${monthAgo}&to=${today}`);
await call('GET', `/reports/time-by-client?from=${monthAgo}&to=${today}`);
await call('GET', `/reports/lead-conversion?from=${monthAgo}&to=${today}`);
await call('GET', '/reports/retainer-health');

// ---- logs ----
await call('GET', '/logs?pageSize=5');
await call('GET', '/logs/entity-types');

// ---- roles, users ----
await call('GET', '/roles');
await call('GET', '/roles/permissions');
await call('GET', '/users?pageSize=5');

// ---- masters ----
for (const key of [
  'departments',
  'designations',
  'skills',
  'service-lines',
  'project-types',
  'leave-types',
  'holidays',
  'work-schedules',
  'assets',
]) {
  await call('GET', `/masters/${key}`);
}

// ---- settings ----
await call('GET', '/settings/org');
await call('GET', '/settings/checklist-templates');
await call('GET', '/settings/sequences');

// ---- notifications ----
await call('GET', '/notifications?pageSize=5');
await call('GET', '/notifications/unread-count');

// ---- report ----
const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  const mark = entry.ok ? 'ok  ' : 'FAIL';
  console.log(
    `${mark} ${String(entry.status).padEnd(3)} ${entry.name.padEnd(58)} ${entry.note}`,
  );
}
console.log(`\n${results.length - failed.length}/${results.length} endpoints OK`);
if (failed.length) {
  console.log('\nFailures:');
  for (const entry of failed) console.log(`  ${entry.status} ${entry.name} — ${entry.note}`);
  process.exit(1);
}
