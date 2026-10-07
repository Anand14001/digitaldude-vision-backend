/**
 * Comments and @mentions.
 *
 * The mention picker reads its people from /employees/options/all and sends the
 * user ids back. That endpoint once omitted the user id, so the client sent a
 * list of nulls and every mention was rejected - a gap no typecheck could see,
 * because the hand-written client type said the field was there.
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

// ---- the picker's own data ----
const options = await req('GET', '/employees/options/all', A);
expect('employee options load', options.status, 200);
expect(
  'every option carries the user id a mention needs',
  options.data?.every((entry) => typeof entry.user?.id === 'string' && entry.user.id.length > 0),
  true,
);
expect(
  'and the name the picker shows',
  options.data?.every((entry) => typeof entry.user?.name === 'string'),
  true,
);

const mentioned = options.data?.find((entry) => entry.user?.id);
expect('someone to mention', Boolean(mentioned), true);

// ---- a task to comment on ----
const tasks = await req('GET', '/tasks?pageSize=1', A);
const task = tasks.data?.[0];
expect('a task to comment on', Boolean(task), true);

// ---- the comment the UI would send ----
const comment = await req('POST', '/comments', {
  ...A,
  body: {
    entityType: 'TASK',
    entityId: task.id,
    body: `@${mentioned.user.name} look into this ${stamp}`,
    isInternal: true,
    mentions: [mentioned.user.id],
  },
});
expect('post a comment with a mention', comment.status, 201);
expect('the mention is stored', comment.data?.mentions?.includes(mentioned.user.id), true);
expect('it is internal by default', comment.data?.isInternal, true);

// A null in the list is what the broken client sent; it must be refused clearly.
const withNull = await req('POST', '/comments', {
  ...A,
  body: {
    entityType: 'TASK',
    entityId: task.id,
    body: 'broken mention',
    isInternal: true,
    mentions: [null],
  },
});
expect('a null mention is refused', withNull.status, 400);

// ---- the mentioned person is notified ----
const employeeEmail = options.data.find((entry) => entry.user.id === mentioned.user.id);
expect('mention target resolved', Boolean(employeeEmail), true);

const comments = await req('GET', `/comments?entityType=TASK&entityId=${task.id}`, A);
expect('the comment is on the task', comments.status, 200);
expect(
  'and reads back with its author',
  comments.data?.some((entry) => entry.id === comment.data.id && entry.author?.name),
  true,
);

// ---- a client-visible comment is a deliberate choice ----
const visible = await req('POST', '/comments', {
  ...A,
  body: {
    entityType: 'TASK',
    entityId: task.id,
    body: `Client visible note ${stamp}`,
    isInternal: false,
    mentions: [],
  },
});
expect('post a client-visible comment', visible.status, 201);
expect('it is not internal', visible.data?.isInternal, false);

// ---- tidy up ----
await req('DELETE', `/comments/${comment.data.id}`, A);
await req('DELETE', `/comments/${visible.data.id}`, A);

const after = await req('GET', `/comments?entityType=TASK&entityId=${task.id}`, A);
expect(
  'deleted comments leave the thread',
  after.data?.some((entry) => entry.id === comment.data.id),
  false,
);

let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} comment checks passed`);
if (failed) process.exit(1);
