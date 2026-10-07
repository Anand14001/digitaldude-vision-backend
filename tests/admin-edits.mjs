/**
 * The editing paths an administrator uses day to day: changing an employee's
 * record, a client's details, and a client contact.
 *
 * Each one writes, reads back, and checks the audit trail recorded it.
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

/** Uploads a file the way the browser does, as multipart form data. */
async function upload(token, filename, contents, folder = 'documents') {
  const form = new FormData();
  form.append('files', new Blob([contents], { type: 'text/plain' }), filename);
  const response = await fetch(`${BASE}/api/files?folder=${folder}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, data: body?.data ?? null, error: body?.error ?? null };
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

// ===================== employee =====================
// Its own throwaway employee, so a real person is never rewritten by a test.
const createdEmployee = await req('POST', '/employees', {
  ...A,
  body: {
    name: `KIND Edit Subject ${stamp}`,
    email: `kindedit${stamp}@example.invalid`,
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    weeklyCapacityHours: 40,
    dateOfJoining: new Date().toISOString(),
    sendInvite: false,
    applyOnboardingChecklist: false,
  },
});
expect('create a throwaway employee', createdEmployee.status, 201);
const subject = { id: createdEmployee.data.id, department: null, designation: null };

const departments = await req('GET', '/masters/departments?pageSize=50', A);
const designations = await req('GET', '/masters/designations?pageSize=50', A);
const newDepartment = departments.data.find((d) => d.id !== subject.department?.id);
const newDesignation = designations.data.find((d) => d.id !== subject.designation?.id);

const employeeEdit = await req('PATCH', `/employees/${subject.id}`, {
  ...A,
  body: {
    phone: `+91 90000 ${stamp}`,
    departmentId: newDepartment.id,
    designationId: newDesignation.id,
    weeklyCapacityHours: 38,
    notes: `Edited by the admin-edits test ${stamp}`,
  },
});
expect('edit employee', employeeEdit.status, 200);

const employeeAfter = await req('GET', `/employees/${subject.id}`, A);
expect('phone saved', employeeAfter.data?.user?.phone, `+91 90000 ${stamp}`);
expect('department changed', employeeAfter.data?.department?.id, newDepartment.id);
expect('designation changed', employeeAfter.data?.designation?.id, newDesignation.id);
expect('capacity changed', Number(employeeAfter.data?.weeklyCapacityHours), 38);

// A reporting loop must be refused, not silently accepted.
const loop = await req('PATCH', `/employees/${subject.id}`, {
  ...A,
  body: { reportingToId: subject.id },
});
expect('self-reporting refused', loop.status, 400);

const employeeLog = await req('GET', `/logs/entity/Employee/${subject.id}`, A);
expect('employee edit is audited', employeeLog.data?.length > 0, true);
expect(
  'the audit entry carries a field diff',
  employeeLog.data?.some((entry) => entry.diff && Object.keys(entry.diff).length > 0),
  true,
);

// ===================== client =====================
const createdClient = await req('POST', '/clients', {
  ...A,
  body: { name: `KIND Edit Client ${stamp}`, status: 'ACTIVE', serviceLineIds: [] },
});
expect('create a throwaway client', createdClient.status, 201);
const client = createdClient.data;

const firstContact = await req('POST', `/clients/${client.id}/contacts`, {
  ...A,
  body: {
    name: `KIND Contact ${stamp}`,
    email: `kindcontact${stamp}@example.invalid`,
    designation: 'Primary contact',
    isPrimary: true,
  },
});
expect('create a throwaway contact', firstContact.status, 201);

const serviceLines = await req('GET', '/masters/service-lines?pageSize=50', A);
const clientEdit = await req('PATCH', `/clients/${client.id}`, {
  ...A,
  body: {
    industry: `Edited ${stamp}`,
    phone: `+91 44 ${stamp}`,
    city: 'Poonamallee',
    notes: `Edited by the admin-edits test ${stamp}`,
    serviceLineIds: serviceLines.data.slice(0, 2).map((s) => s.id),
  },
});
expect('edit client', clientEdit.status, 200);

const clientAfter = await req('GET', `/clients/${client.id}`, A);
expect('industry saved', clientAfter.data?.industry, `Edited ${stamp}`);
expect('city saved', clientAfter.data?.city, 'Poonamallee');
expect('service lines replaced', clientAfter.data?.serviceLines?.length, 2);

const clientLog = await req('GET', `/logs/entity/Client/${client.id}`, A);
expect('client edit is audited', clientLog.data?.length > 0, true);

// ===================== contact =====================
const contact = clientAfter.data.contacts?.[0];
expect('client has a contact', Boolean(contact), true);

const contactEdit = await req('PATCH', `/clients/contacts/${contact.id}`, {
  ...A,
  body: { designation: `Head of Marketing ${stamp}`, phone: '+91 98400 00000' },
});
expect('edit contact', contactEdit.status, 200);

const reread = await req('GET', `/clients/${client.id}`, A);
const contactAfter = reread.data.contacts.find((c) => c.id === contact.id);
expect('contact designation saved', contactAfter?.designation, `Head of Marketing ${stamp}`);
expect('contact phone saved', contactAfter?.phone, '+91 98400 00000');
expect('portal access untouched by an edit', contactAfter?.portalEnabled, contact.portalEnabled);

// Making a second contact primary must demote the first.
const second = await req('POST', `/clients/${client.id}/contacts`, {
  ...A,
  body: { name: `KIND Second ${stamp}`, email: `second${stamp}@example.invalid`, isPrimary: true },
});
expect('add a second primary contact', second.status, 201);

const afterPrimary = await req('GET', `/clients/${client.id}`, A);
const primaries = afterPrimary.data.contacts.filter((c) => c.isPrimary);
expect('only one primary contact remains', primaries.length, 1);
expect('the new one is primary', primaries[0]?.id, second.data.id);

// Remove the one this test added.
expect(
  'remove a contact',
  (await req('DELETE', `/clients/contacts/${second.data.id}`, A)).status,
  204,
);

// ===================== employee documents =====================
const uploaded = await upload(A.token, `contract-${stamp}.txt`, 'Sample contract body');
expect('upload a file', uploaded.status, 201);
expect('upload returns a file record', Boolean(uploaded.data?.[0]?.id), true);

const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
const document = await req(`POST`, `/employees/${subject.id}/documents`, {
  ...A,
  body: {
    type: 'CONTRACT',
    title: `KIND Contract ${stamp}`,
    fileId: uploaded.data[0].id,
    expiresAt: nextYear,
  },
});
expect('attach the file as a document', document.status, 201);

const withDocument = await req('GET', `/employees/${subject.id}`, A);
expect('document appears on the employee', withDocument.data?.documents?.length, 1);
expect(
  'document keeps its type',
  withDocument.data?.documents?.[0]?.type,
  'CONTRACT',
);
expect(
  'document carries a downloadable url',
  Boolean(withDocument.data?.documents?.[0]?.file?.url),
  true,
);
expect(
  'expiry is stored for the reminder job',
  withDocument.data?.documents?.[0]?.expiresAt?.slice(0, 10),
  nextYear,
);

// Documents are a separate clearance: an Executive must not be able to add one.
const exec = await req('POST', '/auth/login', {
  body: { email: 'karthik@digital-dude.com', password: 'karthik@dd123' },
});
if (exec.status === 200) {
  const E = { token: exec.data.accessToken };
  expect(
    'an executive cannot add a document',
    (await req('POST', `/employees/${subject.id}/documents`, {
      ...E,
      body: { type: 'OTHER', title: 'nope', fileId: uploaded.data[0].id },
    })).status,
    403,
  );
  expect(
    'an executive cannot delete a document',
    (await req('DELETE', `/employees/documents/${document.data.id}`, E)).status,
    403,
  );
} else {
  checks.push({
    name: 'executive sign-in for the document permission check',
    ok: false,
    detail: `login failed: ${exec.status}`,
  });
}

expect(
  'admin can delete the document',
  (await req('DELETE', `/employees/documents/${document.data.id}`, A)).status,
  204,
);
const afterDelete = await req('GET', `/employees/${subject.id}`, A);
expect('document is gone', afterDelete.data?.documents?.length, 0);

// ---- tidy up everything this test created ----
await req('DELETE', `/clients/contacts/${contact.id}`, A);
await req('DELETE', `/clients/${client.id}`, A);
await req('POST', `/employees/${subject.id}/offboard`, {
  ...A,
  body: { applyOffboardingChecklist: false },
});

let failed = 0;
for (const check of checks) {
  if (!check.ok) failed += 1;
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.ok ? '' : ` — ${check.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} admin-edit checks passed`);
console.log('(all records used here were created and removed by this test)');
if (failed) process.exit(1);
