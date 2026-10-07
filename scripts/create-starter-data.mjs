/**
 * Creates a usable starting set of people, clients and work.
 *
 *   npm run data:starter
 *
 * Everything goes through the API rather than straight into the database, so it
 * passes the same validation, permission checks and audit logging as if someone
 * had clicked it. Re-running is safe: anything that already exists is skipped.
 *
 * Passwords follow {username}@dd123, where the username is the part of the
 * email before the @.
 */
const BASE = process.env.API_URL ?? 'http://localhost:4001';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@digital-dude.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123';

const passwordFor = (email) => `${email.split('@')[0]}@dd123`;
const created = { employees: [], clients: [], portalUsers: [], projects: [], retainers: [] };
const skipped = [];

let token = '';

async function req(method, path, body) {
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

function fail(label, result) {
  console.error(`\n  FAILED ${label}: ${result.status} ${result.error?.message ?? ''}`);
  if (result.error?.details) console.error('  ', JSON.stringify(result.error.details));
  process.exit(1);
}

// ---------------------------------------------------------------- the people
const TEAM = [
  {
    name: 'Priya Raman',
    email: 'priya@digital-dude.com',
    role: 'Operations Manager',
    department: 'Management',
    designation: 'Operations Manager',
    capacity: 45,
  },
  {
    name: 'Arun Kumar',
    email: 'arun@digital-dude.com',
    role: 'Project Manager',
    department: 'Client Servicing',
    designation: 'Project Manager',
    capacity: 45,
    reportsTo: 'priya@digital-dude.com',
  },
  {
    name: 'Divya Sekar',
    email: 'divya@digital-dude.com',
    role: 'Team Lead',
    department: 'Design',
    designation: 'Senior Designer',
    capacity: 45,
    reportsTo: 'arun@digital-dude.com',
  },
  {
    name: 'Karthik Vel',
    email: 'karthik@digital-dude.com',
    role: 'Executive',
    department: 'Development',
    designation: 'Developer',
    capacity: 40,
    reportsTo: 'arun@digital-dude.com',
  },
  {
    name: 'Meena Lakshmi',
    email: 'meena@digital-dude.com',
    role: 'HR & Accounts',
    department: 'HR & Accounts',
    designation: 'HR Executive',
    capacity: 40,
    reportsTo: 'priya@digital-dude.com',
  },
];

// --------------------------------------------------------------- the clients
// One portal login each. Emails are placeholders - change them before inviting
// anyone for real.
const CLIENTS = [
  {
    name: 'LetsPropStore',
    industry: 'Real Estate',
    city: 'Chennai',
    serviceCodes: ['WEBDEV', 'SMM', 'ADS'],
    contact: { name: 'Vikram Shah', email: 'vikram@letspropstore.example', canApprove: true },
    accountManager: 'arun@digital-dude.com',
  },
  {
    name: 'TinyLittleToes',
    industry: 'Kids Retail',
    city: 'Chennai',
    serviceCodes: ['SMM', 'DESIGN', 'VIDEO'],
    contact: { name: 'Anitha Rao', email: 'anitha@tinylittletoes.example', canApprove: true },
    accountManager: 'priya@digital-dude.com',
  },
  {
    name: 'Wishkart',
    industry: 'E-commerce',
    city: 'Bengaluru',
    serviceCodes: ['WEBDEV', 'SEO', 'ADS'],
    contact: { name: 'Rohit Menon', email: 'rohit@wishkart.example', canApprove: false },
    accountManager: 'arun@digital-dude.com',
  },
  {
    name: 'Smile Dental Clinic',
    industry: 'Healthcare',
    city: 'Chennai',
    serviceCodes: ['BRANDING', 'SMM'],
    contact: { name: 'Dr. Ramesh', email: 'ramesh@smiledental.example', canApprove: false },
    accountManager: 'priya@digital-dude.com',
  },
];

const PROJECTS = [
  {
    name: 'LetsPropStore website revamp',
    client: 'LetsPropStore',
    workflow: 'Website Development Pipeline',
    serviceCode: 'WEBDEV',
    manager: 'arun@digital-dude.com',
    members: ['karthik@digital-dude.com', 'divya@digital-dude.com'],
    budget: 185000,
    dueInDays: 35,
    priority: 'HIGH',
  },
  {
    name: 'TinyLittleToes festive campaign film',
    client: 'TinyLittleToes',
    workflow: 'Video Production Pipeline',
    serviceCode: 'VIDEO',
    manager: 'priya@digital-dude.com',
    members: ['divya@digital-dude.com'],
    budget: 95000,
    dueInDays: 18,
    priority: 'URGENT',
  },
  {
    name: 'Wishkart Shopify migration',
    client: 'Wishkart',
    workflow: 'Website Development Pipeline',
    serviceCode: 'WEBDEV',
    manager: 'arun@digital-dude.com',
    members: ['karthik@digital-dude.com'],
    budget: 240000,
    dueInDays: 50,
    priority: 'MEDIUM',
  },
];

const INTERNAL_PROJECT = {
  name: 'Digital Dude website refresh',
  workflow: 'Website Development Pipeline',
  manager: 'priya@digital-dude.com',
  members: ['divya@digital-dude.com', 'karthik@digital-dude.com'],
  dueInDays: 60,
  priority: 'MEDIUM',
};

const RETAINER = {
  name: 'TinyLittleToes social media retainer',
  client: 'TinyLittleToes',
  workflow: 'Monthly Social Media Cycle',
  serviceCode: 'SMM',
  manager: 'priya@digital-dude.com',
  amountPerCycle: 35000,
  scopeNotes:
    '16 static posts, 8 reels, daily community management and a monthly performance report.',
};

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

async function main() {
  console.log(`\nCreating starter data on ${BASE}\n`);

  const login = await req('POST', '/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (login.status !== 200) fail('admin sign-in', login);
  token = login.data.accessToken;

  // ---- look up the reference data everything hangs off ----
  const [roles, departments, designations, serviceLines, workflows] = await Promise.all([
    req('GET', '/roles'),
    req('GET', '/masters/departments?pageSize=100'),
    req('GET', '/masters/designations?pageSize=100'),
    req('GET', '/masters/service-lines?pageSize=100'),
    req('GET', '/workflows'),
  ]);

  const roleId = (name) => roles.data.find((r) => r.name === name)?.id ?? null;
  const departmentId = (name) => departments.data.find((d) => d.name === name)?.id ?? null;
  const designationId = (title) => designations.data.find((d) => d.title === title)?.id ?? null;
  const serviceLineId = (code) => serviceLines.data.find((s) => s.code === code)?.id ?? null;
  const workflowId = (name) => workflows.data.find((w) => w.name === name)?.id ?? null;

  // ---- 1. employees -------------------------------------------------------
  console.log('Employees');
  const employeeByEmail = new Map();

  for (const person of TEAM) {
    const existing = await req('GET', `/users?q=${encodeURIComponent(person.email)}`);
    if (existing.data?.length) {
      skipped.push(`employee ${person.email}`);
      const match = existing.data[0];
      if (match.employee) employeeByEmail.set(person.email, match.employee.id);
      console.log(`  - ${person.name} already exists`);
      continue;
    }

    const result = await req('POST', '/employees', {
      name: person.name,
      email: person.email,
      roleId: roleId(person.role),
      departmentId: departmentId(person.department),
      designationId: designationId(person.designation),
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      weeklyCapacityHours: person.capacity,
      dateOfJoining: new Date().toISOString(),
      sendInvite: true,
      applyOnboardingChecklist: true,
    });
    if (result.status !== 201) fail(`create employee ${person.email}`, result);

    employeeByEmail.set(person.email, result.data.id);
    created.employees.push({
      name: person.name,
      email: person.email,
      role: person.role,
      password: passwordFor(person.email),
    });
    console.log(`  + ${person.name} (${person.role})`);
  }

  // Reporting lines need every employee to exist first.
  for (const person of TEAM) {
    if (!person.reportsTo) continue;
    const self = employeeByEmail.get(person.email);
    const manager = employeeByEmail.get(person.reportsTo);
    if (self && manager) await req('PATCH', `/employees/${self}`, { reportingToId: manager });
  }

  // Accept each invite so the accounts can actually sign in.
  for (const person of created.employees) {
    const tokenResult = await readInviteToken(person.email);
    if (!tokenResult) continue;
    const accepted = await fetch(`${BASE}/api/auth/accept-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenResult, password: person.password }),
    });
    if (!accepted.ok) {
      const body = await accepted.text();
      console.error(`  ! could not set a password for ${person.email}: ${body.slice(0, 160)}`);
    }
  }

  // ---- 2. clients and their portal logins --------------------------------
  console.log('\nClients');
  const clientByName = new Map();

  for (const entry of CLIENTS) {
    const existing = await req('GET', `/clients?q=${encodeURIComponent(entry.name)}`);
    const match = existing.data?.find((c) => c.name === entry.name);
    if (match) {
      clientByName.set(entry.name, match.id);
      skipped.push(`client ${entry.name}`);
      console.log(`  - ${entry.name} already exists`);
      continue;
    }

    const result = await req('POST', '/clients', {
      name: entry.name,
      industry: entry.industry,
      city: entry.city,
      state: 'Tamil Nadu',
      status: 'ACTIVE',
      onboardedAt: new Date().toISOString(),
      accountManagerId: employeeByEmail.get(entry.accountManager) ?? null,
      serviceLineIds: entry.serviceCodes.map(serviceLineId).filter(Boolean),
    });
    if (result.status !== 201) fail(`create client ${entry.name}`, result);
    clientByName.set(entry.name, result.data.id);
    created.clients.push(entry.name);
    console.log(`  + ${entry.name}`);

    // Primary contact, then portal access, then accept the invite so the login
    // works straight away.
    const contact = await req('POST', `/clients/${result.data.id}/contacts`, {
      name: entry.contact.name,
      email: entry.contact.email,
      designation: 'Primary contact',
      isPrimary: true,
    });
    if (contact.status !== 201) fail(`create contact for ${entry.name}`, contact);

    const grant = await req('POST', `/clients/contacts/${contact.data.id}/portal-access`, {
      canApprove: entry.contact.canApprove,
    });
    if (grant.status !== 201) fail(`grant portal access for ${entry.name}`, grant);

    const inviteToken = await readInviteToken(entry.contact.email);
    if (inviteToken) {
      const accepted = await fetch(`${BASE}/api/auth/accept-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: inviteToken,
          password: passwordFor(entry.contact.email),
        }),
      });
      if (!accepted.ok) {
        console.error(`  ! could not set a portal password for ${entry.contact.email}`);
      }
    }

    created.portalUsers.push({
      name: entry.contact.name,
      email: entry.contact.email,
      client: entry.name,
      canApprove: entry.contact.canApprove,
      password: passwordFor(entry.contact.email),
    });
    console.log(
      `    portal: ${entry.contact.name} (${entry.contact.canApprove ? 'can approve' : 'view only'})`,
    );
  }

  // ---- 3. client projects -------------------------------------------------
  console.log('\nProjects');
  for (const entry of PROJECTS) {
    const existing = await req('GET', `/projects?q=${encodeURIComponent(entry.name)}`);
    if (existing.data?.some((p) => p.name === entry.name)) {
      skipped.push(`project ${entry.name}`);
      console.log(`  - ${entry.name} already exists`);
      continue;
    }

    const result = await req('POST', '/projects', {
      name: entry.name,
      kind: 'CLIENT',
      clientId: clientByName.get(entry.client),
      workflowId: workflowId(entry.workflow),
      serviceLineId: serviceLineId(entry.serviceCode),
      managerId: employeeByEmail.get(entry.manager) ?? null,
      memberIds: entry.members.map((email) => employeeByEmail.get(email)).filter(Boolean),
      status: 'ACTIVE',
      priority: entry.priority,
      startDate: new Date().toISOString(),
      dueDate: inDays(entry.dueInDays),
      budgetAmount: entry.budget,
      visibleToClient: true,
      seedDefaultTasks: true,
    });
    if (result.status !== 201) fail(`create project ${entry.name}`, result);
    created.projects.push(`${result.data.code} ${entry.name}`);
    console.log(`  + ${result.data.code} ${entry.name}`);
  }

  // ---- 4. the internal project -------------------------------------------
  const existingInternal = await req(
    'GET',
    `/projects?q=${encodeURIComponent(INTERNAL_PROJECT.name)}`,
  );
  if (existingInternal.data?.some((p) => p.name === INTERNAL_PROJECT.name)) {
    skipped.push(`project ${INTERNAL_PROJECT.name}`);
    console.log(`  - ${INTERNAL_PROJECT.name} already exists`);
  } else {
    const result = await req('POST', '/projects', {
      name: INTERNAL_PROJECT.name,
      kind: 'INTERNAL',
      clientId: null,
      workflowId: workflowId(INTERNAL_PROJECT.workflow),
      managerId: employeeByEmail.get(INTERNAL_PROJECT.manager) ?? null,
      memberIds: INTERNAL_PROJECT.members
        .map((email) => employeeByEmail.get(email))
        .filter(Boolean),
      status: 'ACTIVE',
      priority: INTERNAL_PROJECT.priority,
      startDate: new Date().toISOString(),
      dueDate: inDays(INTERNAL_PROJECT.dueInDays),
      seedDefaultTasks: true,
    });
    if (result.status !== 201) fail('create internal project', result);
    created.projects.push(`${result.data.code} ${INTERNAL_PROJECT.name} (internal)`);
    console.log(`  + ${result.data.code} ${INTERNAL_PROJECT.name} (internal)`);
  }

  // ---- 5. the recurring engagement ---------------------------------------
  console.log('\nRetainer');
  const existingRetainer = await req(
    'GET',
    `/retainers?q=${encodeURIComponent(RETAINER.name)}`,
  );
  if (existingRetainer.data?.some((r) => r.name === RETAINER.name)) {
    skipped.push(`retainer ${RETAINER.name}`);
    console.log(`  - ${RETAINER.name} already exists`);
  } else {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const result = await req('POST', '/retainers', {
      name: RETAINER.name,
      clientId: clientByName.get(RETAINER.client),
      workflowId: workflowId(RETAINER.workflow),
      serviceLineId: serviceLineId(RETAINER.serviceCode),
      managerId: employeeByEmail.get(RETAINER.manager) ?? null,
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      amountPerCycle: RETAINER.amountPerCycle,
      startDate: monthStart.toISOString(),
      endDate: inDays(365),
      cycleStartDay: 1,
      autoGenerateCycles: true,
      openFirstCycle: true,
      scopeNotes: RETAINER.scopeNotes,
    });
    if (result.status !== 201) fail('create retainer', result);
    created.retainers.push(`${result.data.code} ${RETAINER.name}`);
    console.log(`  + ${result.data.code} ${RETAINER.name} (monthly, first cycle open)`);
  }

  // ---- summary ------------------------------------------------------------
  console.log('\n--- created ---');
  console.log(`  ${created.employees.length} employee account(s)`);
  console.log(`  ${created.clients.length} client(s) with ${created.portalUsers.length} portal login(s)`);
  console.log(`  ${created.projects.length} project(s)`);
  console.log(`  ${created.retainers.length} retainer(s)`);
  if (skipped.length) console.log(`  ${skipped.length} already existed and were left alone`);

  if (created.employees.length || created.portalUsers.length) {
    console.log('\n--- sign in ---');
    for (const person of created.employees) {
      console.log(`  ${person.email.padEnd(32)} ${person.password.padEnd(20)} ${person.role}`);
    }
    for (const person of created.portalUsers) {
      console.log(
        `  ${person.email.padEnd(32)} ${person.password.padEnd(20)} portal: ${person.client}`,
      );
    }
  }
  console.log('');
}

/** Reads a pending invite token, which stands in for the email we do not send. */
async function readInviteToken(email) {
  const { execSync } = await import('node:child_process');
  try {
    return execSync(`npx tsx prisma/print-invite-token.ts ${email}`, { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .pop();
  } catch {
    return null;
  }
}

await main();
