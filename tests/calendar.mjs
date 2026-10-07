/**
 * The calendar feed.
 *
 * Its filter once checked plural source names while every caller sent the
 * singular, so naming your sources silently emptied the whole calendar. These
 * checks use the exact parameters the web client sends, which is the only way
 * that class of mismatch shows up.
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

// An event tomorrow, so it falls inside any sensible window.
const start = new Date(Date.now() + 86_400_000);
start.setHours(10, 0, 0, 0);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const created = await req('POST', '/calendar/events', {
  ...A,
  body: {
    title: `KIND Calendar Check ${stamp}`,
    type: 'MEETING',
    location: 'Studio',
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    allDay: false,
    attendeeUserIds: [],
  },
});
expect('create an event', created.status, 201);
const eventId = created.data?.id;

// The window the month grid asks for: a few days either side.
const from = new Date(start.getTime() - 7 * 86_400_000).toISOString();
const to = new Date(start.getTime() + 7 * 86_400_000).toISOString();
const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/** The exact source list the web client sends. */
const UI_SOURCES = 'event,task,milestone,leave,holiday,cycle';

const asUi = await req('GET', `/calendar?${range}&sources=${UI_SOURCES}`, A);
expect('feed responds to the client’s own parameters', asUi.status, 200);
expect(
  'the new event is in the feed',
  asUi.data?.items?.some((item) => item.id === eventId),
  true,
);

const entry = asUi.data?.items?.find((item) => item.id === eventId);
expect('it is tagged as an event', entry?.source, 'event');
expect('it keeps its start time', entry?.start, start.toISOString());
expect('it carries a colour for the grid', Boolean(entry?.color), true);
expect('its location comes through', entry?.meta?.location, 'Studio');

// Naming one source must narrow the feed, not empty it.
const onlyEvents = await req('GET', `/calendar?${range}&sources=event`, A);
expect(
  'asking for events alone returns events',
  onlyEvents.data?.items?.every((item) => item.source === 'event'),
  true,
);
expect(
  'and still includes the new one',
  onlyEvents.data?.items?.some((item) => item.id === eventId),
  true,
);

// Omitting the filter must match asking for everything.
const noFilter = await req('GET', `/calendar?${range}`, A);
expect(
  'no filter returns at least as much as naming every source',
  noFilter.data?.items?.length >= asUi.data?.items?.length,
  true,
);

// The plural spelling an older client might send still works.
const plural = await req('GET', `/calendar?${range}&sources=events`, A);
expect(
  'the plural spelling is tolerated',
  plural.data?.items?.some((item) => item.id === eventId),
  true,
);

// A filter nobody recognises is an error, not an empty calendar.
const nonsense = await req('GET', `/calendar?${range}&sources=banana`, A);
expect('an unknown source is refused', nonsense.status, 400);

// An all-day event lands on its day.
const allDayStart = new Date(start);
allDayStart.setHours(0, 0, 0, 0);
const allDay = await req('POST', '/calendar/events', {
  ...A,
  body: {
    title: `KIND All Day ${stamp}`,
    type: 'SHOOT',
    startAt: allDayStart.toISOString(),
    endAt: new Date(allDayStart.getTime() + 86_340_000).toISOString(),
    allDay: true,
    attendeeUserIds: [],
  },
});
expect('create an all-day event', allDay.status, 201);

const withAllDay = await req('GET', `/calendar?${range}&sources=${UI_SOURCES}`, A);
const allDayEntry = withAllDay.data?.items?.find((item) => item.id === allDay.data?.id);
expect('the all-day event is in the feed', Boolean(allDayEntry), true);
expect('it is marked all day', allDayEntry?.allDay, true);

// ---- tidy up ----
await req('DELETE', `/calendar/events/${eventId}`, A);
await req('DELETE', `/calendar/events/${allDay.data?.id}`, A);

const afterDelete = await req('GET', `/calendar?${range}&sources=event`, A);
expect(
  'a cancelled event leaves the feed',
  afterDelete.data?.items?.some((item) => item.id === eventId),
  false,
);

let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} calendar checks passed`);
if (failed) process.exit(1);
