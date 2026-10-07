/**
 * The permission registry is the single source of truth for which permission
 * keys exist. Roles in the database merely store a subset of these keys, so a
 * key that is renamed or removed here simply stops being honoured - a role can
 * never grant a permission the code does not know about.
 *
 * Naming: "<module>.<action>" with an optional scope suffix.
 *   projects.view.all       - every project in the org
 *   projects.view.assigned  - only projects the user is a member or manager of
 *
 * Scope rule: a ".all" key always implies the matching ".assigned"/".own" key.
 */

export const PERMISSION_GROUPS = [
  {
    module: 'clients',
    label: 'Clients & Contacts',
    permissions: [
      { key: 'clients.view.all', label: 'View all clients' },
      { key: 'clients.view.assigned', label: 'View clients they manage' },
      { key: 'clients.create', label: 'Create clients' },
      { key: 'clients.update', label: 'Edit clients' },
      { key: 'clients.delete', label: 'Delete clients' },
      { key: 'clients.contacts.manage', label: 'Manage client contacts' },
      { key: 'clients.portal.manage', label: 'Grant & revoke portal access' },
    ],
  },
  {
    module: 'leads',
    label: 'Leads',
    permissions: [
      { key: 'leads.view.all', label: 'View all leads' },
      { key: 'leads.view.own', label: 'View their own leads' },
      { key: 'leads.create', label: 'Create leads' },
      { key: 'leads.update', label: 'Edit leads' },
      { key: 'leads.delete', label: 'Delete leads' },
      { key: 'leads.convert', label: 'Convert a lead into a client' },
    ],
  },
  {
    module: 'projects',
    label: 'Projects',
    permissions: [
      { key: 'projects.view.all', label: 'View all projects' },
      { key: 'projects.view.assigned', label: 'View projects they are on' },
      { key: 'projects.create', label: 'Create projects' },
      { key: 'projects.update', label: 'Edit projects' },
      { key: 'projects.delete', label: 'Delete projects' },
      { key: 'projects.stage.move', label: 'Move a project between stages' },
      { key: 'projects.members.manage', label: 'Add & remove project members' },
      { key: 'projects.budget.view', label: 'See project budget & cost' },
    ],
  },
  {
    module: 'retainers',
    label: 'Retainers',
    permissions: [
      { key: 'retainers.view.all', label: 'View all retainers' },
      { key: 'retainers.view.assigned', label: 'View retainers they are on' },
      { key: 'retainers.create', label: 'Create retainers' },
      { key: 'retainers.update', label: 'Edit retainers' },
      { key: 'retainers.delete', label: 'Delete retainers' },
      { key: 'retainers.cycles.manage', label: 'Open, close & edit cycles' },
    ],
  },
  {
    module: 'tasks',
    label: 'Tasks',
    permissions: [
      { key: 'tasks.view.all', label: 'View all tasks' },
      { key: 'tasks.view.assigned', label: 'View their own tasks' },
      { key: 'tasks.create', label: 'Create tasks' },
      { key: 'tasks.update', label: 'Edit any task' },
      { key: 'tasks.update.assigned', label: 'Edit tasks assigned to them' },
      { key: 'tasks.assign', label: 'Assign tasks to others' },
      { key: 'tasks.delete', label: 'Delete tasks' },
    ],
  },
  {
    module: 'deliverables',
    label: 'Deliverables & Approvals',
    permissions: [
      { key: 'deliverables.view', label: 'View deliverables' },
      { key: 'deliverables.manage', label: 'Create & edit deliverables' },
      { key: 'deliverables.version.upload', label: 'Upload new versions' },
      { key: 'deliverables.approve.internal', label: 'Give internal approval' },
      { key: 'deliverables.request.client', label: 'Send to client for approval' },
      { key: 'deliverables.publish', label: 'Mark as published' },
    ],
  },
  {
    module: 'employees',
    label: 'Employees',
    permissions: [
      { key: 'employees.view.all', label: 'View all employees' },
      { key: 'employees.view.team', label: 'View their direct reports' },
      { key: 'employees.create', label: 'Add employees' },
      { key: 'employees.update', label: 'Edit employees' },
      { key: 'employees.delete', label: 'Deactivate employees' },
      { key: 'employees.pii.view', label: 'See personal details (DOB, address)' },
      { key: 'employees.compensation.view', label: 'See salary information' },
      { key: 'employees.compensation.manage', label: 'Edit salary information' },
      { key: 'employees.documents.manage', label: 'Manage employee documents' },
      { key: 'employees.checklist.manage', label: 'Manage onboarding & exit checklists' },
    ],
  },
  {
    module: 'assets',
    label: 'Assets & Equipment',
    permissions: [
      { key: 'assets.view', label: 'View assets' },
      { key: 'assets.manage', label: 'Add & edit assets' },
      { key: 'assets.assign', label: 'Issue & return assets' },
    ],
  },
  {
    module: 'timesheets',
    label: 'Time Tracking',
    permissions: [
      { key: 'timesheets.log.own', label: 'Log their own time' },
      { key: 'timesheets.view.all', label: 'View everyone’s time' },
      { key: 'timesheets.view.team', label: 'View their team’s time' },
      { key: 'timesheets.approve', label: 'Approve & reject timesheets' },
      { key: 'timesheets.edit.others', label: 'Edit other people’s entries' },
    ],
  },
  {
    module: 'attendance',
    label: 'Attendance',
    permissions: [
      { key: 'attendance.mark.own', label: 'Check in & out' },
      { key: 'attendance.view.all', label: 'View all attendance' },
      { key: 'attendance.view.team', label: 'View their team’s attendance' },
      { key: 'attendance.manage', label: 'Correct attendance records' },
    ],
  },
  {
    module: 'leave',
    label: 'Leave',
    permissions: [
      { key: 'leave.request.own', label: 'Request leave' },
      { key: 'leave.view.all', label: 'View all leave' },
      { key: 'leave.view.team', label: 'View their team’s leave' },
      { key: 'leave.approve', label: 'Approve & reject leave' },
      { key: 'leave.balance.manage', label: 'Adjust leave balances' },
    ],
  },
  {
    module: 'performance',
    label: 'Performance',
    permissions: [
      { key: 'performance.view.own', label: 'View their own reviews & goals' },
      { key: 'performance.view.team', label: 'View their team’s reviews' },
      { key: 'performance.view.all', label: 'View all reviews' },
      { key: 'performance.manage', label: 'Run review cycles & write reviews' },
      { key: 'performance.goals.manage', label: 'Set goals for others' },
    ],
  },
  {
    module: 'calendar',
    label: 'Calendar',
    permissions: [
      { key: 'calendar.view.own', label: 'View their own calendar' },
      { key: 'calendar.view.all', label: 'View the org calendar' },
      { key: 'calendar.manage', label: 'Create & edit events' },
    ],
  },
  {
    module: 'reports',
    label: 'Reports',
    permissions: [
      { key: 'reports.view', label: 'View reports' },
      { key: 'reports.financial.view', label: 'View revenue & cost reports' },
      { key: 'reports.export', label: 'Export report data' },
    ],
  },
  {
    module: 'logs',
    label: 'Activity Log',
    permissions: [{ key: 'logs.view', label: 'View the activity log' }],
  },
  {
    module: 'settings',
    label: 'Settings & Administration',
    permissions: [
      { key: 'settings.org.manage', label: 'Edit organisation profile' },
      { key: 'settings.roles.manage', label: 'Manage roles & permissions' },
      { key: 'settings.users.manage', label: 'Invite & deactivate users' },
      { key: 'settings.workflows.manage', label: 'Build workflows & project types' },
      { key: 'settings.masters.manage', label: 'Manage departments, skills, leave types, holidays' },
    ],
  },
] as const;

export type PermissionKey =
  (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key'];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

const PERMISSION_SET = new Set(ALL_PERMISSIONS);

export function isKnownPermission(key: string): boolean {
  return PERMISSION_SET.has(key);
}

/** Drops anything the registry no longer recognises. */
export function sanitizePermissions(keys: string[]): string[] {
  return [...new Set(keys.filter(isKnownPermission))];
}

/**
 * Broader scopes imply narrower ones, so a role granted `projects.view.all`
 * does not also need `projects.view.assigned` ticked.
 */
const IMPLIED: Record<string, string[]> = {
  'clients.view.all': ['clients.view.assigned'],
  'leads.view.all': ['leads.view.own'],
  'projects.view.all': ['projects.view.assigned'],
  'retainers.view.all': ['retainers.view.assigned'],
  'tasks.view.all': ['tasks.view.assigned'],
  'tasks.update': ['tasks.update.assigned'],
  'employees.view.all': ['employees.view.team'],
  'timesheets.view.all': ['timesheets.view.team'],
  'attendance.view.all': ['attendance.view.team'],
  'leave.view.all': ['leave.view.team'],
  'performance.view.all': ['performance.view.team', 'performance.view.own'],
  'performance.view.team': ['performance.view.own'],
  'calendar.view.all': ['calendar.view.own'],
  'employees.compensation.manage': ['employees.compensation.view'],
};

/** Expands a granted set to include everything those grants imply. */
export function expandPermissions(granted: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const queue = [...granted];
  while (queue.length) {
    const key = queue.pop() as string;
    if (out.has(key)) continue;
    out.add(key);
    for (const implied of IMPLIED[key] ?? []) queue.push(implied);
  }
  return out;
}

/** Permissions every staff member gets regardless of role. */
export const BASELINE_STAFF_PERMISSIONS: string[] = [
  'tasks.view.assigned',
  'tasks.update.assigned',
  'projects.view.assigned',
  'timesheets.log.own',
  'attendance.mark.own',
  'leave.request.own',
  'performance.view.own',
  'calendar.view.own',
];
