/**
 * GENERATED FILE - do not edit by hand.
 * Produced by digital-dude-api: npm run emit:contract
 * Generated at 2026-10-07T05:39:45.253Z
 */

export type UserKind = 'STAFF' | 'CLIENT';
export const USER_KIND_VALUES: readonly UserKind[] = [
  'STAFF',
  'CLIENT',
];

export type UserStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED';
export const USER_STATUS_VALUES: readonly UserStatus[] = [
  'INVITED',
  'ACTIVE',
  'SUSPENDED',
];

export type ThemePreference = 'LIGHT' | 'DARK' | 'SYSTEM';
export const THEME_PREFERENCE_VALUES: readonly ThemePreference[] = [
  'LIGHT',
  'DARK',
  'SYSTEM',
];

export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN' | 'FREELANCE';
export const EMPLOYMENT_TYPE_VALUES: readonly EmploymentType[] = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'FREELANCE',
];

export type EmployeeStatus = 'ONBOARDING' | 'ACTIVE' | 'ON_NOTICE' | 'EXITED';
export const EMPLOYEE_STATUS_VALUES: readonly EmployeeStatus[] = [
  'ONBOARDING',
  'ACTIVE',
  'ON_NOTICE',
  'EXITED',
];

export type SkillLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT';
export const SKILL_LEVEL_VALUES: readonly SkillLevel[] = [
  'BEGINNER',
  'INTERMEDIATE',
  'ADVANCED',
  'EXPERT',
];

export type EmployeeDocumentType = 'OFFER_LETTER' | 'CONTRACT' | 'ID_PROOF' | 'ADDRESS_PROOF' | 'EDUCATION' | 'PAYSLIP' | 'NDA' | 'OTHER';
export const EMPLOYEE_DOCUMENT_TYPE_VALUES: readonly EmployeeDocumentType[] = [
  'OFFER_LETTER',
  'CONTRACT',
  'ID_PROOF',
  'ADDRESS_PROOF',
  'EDUCATION',
  'PAYSLIP',
  'NDA',
  'OTHER',
];

export type AssetCategory = 'LAPTOP' | 'DESKTOP' | 'MONITOR' | 'PHONE' | 'CAMERA' | 'LENS' | 'AUDIO' | 'LIGHTING' | 'DRONE' | 'ACCESSORY' | 'SOFTWARE_LICENSE' | 'OTHER';
export const ASSET_CATEGORY_VALUES: readonly AssetCategory[] = [
  'LAPTOP',
  'DESKTOP',
  'MONITOR',
  'PHONE',
  'CAMERA',
  'LENS',
  'AUDIO',
  'LIGHTING',
  'DRONE',
  'ACCESSORY',
  'SOFTWARE_LICENSE',
  'OTHER',
];

export type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'IN_REPAIR' | 'RETIRED' | 'LOST';
export const ASSET_STATUS_VALUES: readonly AssetStatus[] = [
  'AVAILABLE',
  'ASSIGNED',
  'IN_REPAIR',
  'RETIRED',
  'LOST',
];

export type ChecklistKind = 'ONBOARDING' | 'OFFBOARDING';
export const CHECKLIST_KIND_VALUES: readonly ChecklistKind[] = [
  'ONBOARDING',
  'OFFBOARDING',
];

export type ClientStatus = 'PROSPECT' | 'ACTIVE' | 'PAUSED' | 'CHURNED';
export const CLIENT_STATUS_VALUES: readonly ClientStatus[] = [
  'PROSPECT',
  'ACTIVE',
  'PAUSED',
  'CHURNED',
];

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'PROPOSAL_SENT' | 'NEGOTIATION' | 'WON' | 'LOST';
export const LEAD_STATUS_VALUES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'WON',
  'LOST',
];

export type LeadSource = 'REFERRAL' | 'INSTAGRAM' | 'FACEBOOK' | 'GOOGLE' | 'LINKEDIN' | 'WALK_IN' | 'COLD_OUTREACH' | 'WEBSITE' | 'EXISTING_CLIENT' | 'OTHER';
export const LEAD_SOURCE_VALUES: readonly LeadSource[] = [
  'REFERRAL',
  'INSTAGRAM',
  'FACEBOOK',
  'GOOGLE',
  'LINKEDIN',
  'WALK_IN',
  'COLD_OUTREACH',
  'WEBSITE',
  'EXISTING_CLIENT',
  'OTHER',
];

export type LeadActivityType = 'CALL' | 'EMAIL' | 'MEETING' | 'WHATSAPP' | 'NOTE' | 'STATUS_CHANGE';
export const LEAD_ACTIVITY_TYPE_VALUES: readonly LeadActivityType[] = [
  'CALL',
  'EMAIL',
  'MEETING',
  'WHATSAPP',
  'NOTE',
  'STATUS_CHANGE',
];

export type TaskStatusCategory = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'REVIEW' | 'DONE' | 'CANCELLED';
export const TASK_STATUS_CATEGORY_VALUES: readonly TaskStatusCategory[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'REVIEW',
  'DONE',
  'CANCELLED',
];

export type ProjectKind = 'CLIENT' | 'INTERNAL';
export const PROJECT_KIND_VALUES: readonly ProjectKind[] = [
  'CLIENT',
  'INTERNAL',
];

export type ProjectStatus = 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export const PROJECT_STATUS_VALUES: readonly ProjectStatus[] = [
  'PLANNING',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
];

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export const PRIORITY_VALUES: readonly Priority[] = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
];

export type HealthStatus = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';
export const HEALTH_STATUS_VALUES: readonly HealthStatus[] = [
  'ON_TRACK',
  'AT_RISK',
  'OFF_TRACK',
];

export type ProjectRole = 'LEAD' | 'MEMBER' | 'REVIEWER' | 'OBSERVER';
export const PROJECT_ROLE_VALUES: readonly ProjectRole[] = [
  'LEAD',
  'MEMBER',
  'REVIEWER',
  'OBSERVER',
];

export type BillingCycle = 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'ANNUAL';
export const BILLING_CYCLE_VALUES: readonly BillingCycle[] = [
  'MONTHLY',
  'QUARTERLY',
  'HALF_YEARLY',
  'ANNUAL',
];

export type RetainerStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';
export const RETAINER_STATUS_VALUES: readonly RetainerStatus[] = [
  'ACTIVE',
  'PAUSED',
  'ENDED',
];

export type CycleStatus = 'UPCOMING' | 'IN_PROGRESS' | 'DELIVERED' | 'CLOSED';
export const CYCLE_STATUS_VALUES: readonly CycleStatus[] = [
  'UPCOMING',
  'IN_PROGRESS',
  'DELIVERED',
  'CLOSED',
];

export type DependencyType = 'FINISH_TO_START' | 'START_TO_START' | 'FINISH_TO_FINISH';
export const DEPENDENCY_TYPE_VALUES: readonly DependencyType[] = [
  'FINISH_TO_START',
  'START_TO_START',
  'FINISH_TO_FINISH',
];

export type DeliverableStatus = 'DRAFT' | 'INTERNAL_REVIEW' | 'CLIENT_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'PUBLISHED';
export const DELIVERABLE_STATUS_VALUES: readonly DeliverableStatus[] = [
  'DRAFT',
  'INTERNAL_REVIEW',
  'CLIENT_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHED',
];

export type ApprovalDecision = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED';
export const APPROVAL_DECISION_VALUES: readonly ApprovalDecision[] = [
  'PENDING',
  'APPROVED',
  'CHANGES_REQUESTED',
];

export type ApprovalStage = 'INTERNAL' | 'CLIENT';
export const APPROVAL_STAGE_VALUES: readonly ApprovalStage[] = [
  'INTERNAL',
  'CLIENT',
];

export type TimesheetStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export const TIMESHEET_STATUS_VALUES: readonly TimesheetStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
];

export type AttendanceStatus = 'PRESENT' | 'WORK_FROM_HOME' | 'HALF_DAY' | 'ON_LEAVE' | 'HOLIDAY' | 'WEEKLY_OFF' | 'ABSENT';
export const ATTENDANCE_STATUS_VALUES: readonly AttendanceStatus[] = [
  'PRESENT',
  'WORK_FROM_HOME',
  'HALF_DAY',
  'ON_LEAVE',
  'HOLIDAY',
  'WEEKLY_OFF',
  'ABSENT',
];

export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export const LEAVE_REQUEST_STATUS_VALUES: readonly LeaveRequestStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

export type ReviewCycleStatus = 'DRAFT' | 'OPEN' | 'CLOSED';
export const REVIEW_CYCLE_STATUS_VALUES: readonly ReviewCycleStatus[] = [
  'DRAFT',
  'OPEN',
  'CLOSED',
];

export type ReviewStatus = 'PENDING_SELF' | 'PENDING_MANAGER' | 'COMPLETED';
export const REVIEW_STATUS_VALUES: readonly ReviewStatus[] = [
  'PENDING_SELF',
  'PENDING_MANAGER',
  'COMPLETED',
];

export type GoalStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ACHIEVED' | 'MISSED';
export const GOAL_STATUS_VALUES: readonly GoalStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'ACHIEVED',
  'MISSED',
];

export type EventType = 'MEETING' | 'SHOOT' | 'CLIENT_CALL' | 'INTERNAL' | 'DEADLINE' | 'OTHER';
export const EVENT_TYPE_VALUES: readonly EventType[] = [
  'MEETING',
  'SHOOT',
  'CLIENT_CALL',
  'INTERNAL',
  'DEADLINE',
  'OTHER',
];

export type AttendeeResponse = 'INVITED' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';
export const ATTENDEE_RESPONSE_VALUES: readonly AttendeeResponse[] = [
  'INVITED',
  'ACCEPTED',
  'DECLINED',
  'TENTATIVE',
];

export type CommentEntity = 'TASK' | 'PROJECT' | 'CLIENT' | 'LEAD' | 'DELIVERABLE' | 'RETAINER_CYCLE';
export const COMMENT_ENTITY_VALUES: readonly CommentEntity[] = [
  'TASK',
  'PROJECT',
  'CLIENT',
  'LEAD',
  'DELIVERABLE',
  'RETAINER_CYCLE',
];

export type StorageProvider = 'LOCAL' | 'CLOUDINARY' | 'S3';
export const STORAGE_PROVIDER_VALUES: readonly StorageProvider[] = [
  'LOCAL',
  'CLOUDINARY',
  'S3',
];

export type NotificationType = 'TASK_ASSIGNED' | 'TASK_DUE_SOON' | 'TASK_OVERDUE' | 'MENTION' | 'COMMENT_REPLY' | 'APPROVAL_REQUESTED' | 'APPROVAL_DECIDED' | 'LEAVE_REQUESTED' | 'LEAVE_DECIDED' | 'TIMESHEET_SUBMITTED' | 'TIMESHEET_DECIDED' | 'PROJECT_STAGE_CHANGED' | 'RETAINER_RENEWAL_DUE' | 'DOCUMENT_EXPIRING' | 'SYSTEM';
export const NOTIFICATION_TYPE_VALUES: readonly NotificationType[] = [
  'TASK_ASSIGNED',
  'TASK_DUE_SOON',
  'TASK_OVERDUE',
  'MENTION',
  'COMMENT_REPLY',
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
  'LEAVE_REQUESTED',
  'LEAVE_DECIDED',
  'TIMESHEET_SUBMITTED',
  'TIMESHEET_DECIDED',
  'PROJECT_STAGE_CHANGED',
  'RETAINER_RENEWAL_DUE',
  'DOCUMENT_EXPIRING',
  'SYSTEM',
];

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'LOGIN' | 'LOGIN_FAILED' | 'LOGOUT' | 'PERMISSION_CHANGE' | 'STATUS_CHANGE' | 'STAGE_CHANGE' | 'APPROVE' | 'REJECT' | 'EXPORT' | 'FILE_UPLOAD' | 'FILE_DELETE';
export const AUDIT_ACTION_VALUES: readonly AuditAction[] = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'RESTORE',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PERMISSION_CHANGE',
  'STATUS_CHANGE',
  'STAGE_CHANGE',
  'APPROVE',
  'REJECT',
  'EXPORT',
  'FILE_UPLOAD',
  'FILE_DELETE',
];

/** Every permission key the API recognises. */
export type PermissionKey =
  | 'clients.view.all'
  | 'clients.view.assigned'
  | 'clients.create'
  | 'clients.update'
  | 'clients.delete'
  | 'clients.contacts.manage'
  | 'clients.portal.manage'
  | 'leads.view.all'
  | 'leads.view.own'
  | 'leads.create'
  | 'leads.update'
  | 'leads.delete'
  | 'leads.convert'
  | 'projects.view.all'
  | 'projects.view.assigned'
  | 'projects.create'
  | 'projects.update'
  | 'projects.delete'
  | 'projects.stage.move'
  | 'projects.members.manage'
  | 'projects.budget.view'
  | 'retainers.view.all'
  | 'retainers.view.assigned'
  | 'retainers.create'
  | 'retainers.update'
  | 'retainers.delete'
  | 'retainers.cycles.manage'
  | 'tasks.view.all'
  | 'tasks.view.assigned'
  | 'tasks.create'
  | 'tasks.update'
  | 'tasks.update.assigned'
  | 'tasks.assign'
  | 'tasks.delete'
  | 'deliverables.view'
  | 'deliverables.manage'
  | 'deliverables.version.upload'
  | 'deliverables.approve.internal'
  | 'deliverables.request.client'
  | 'deliverables.publish'
  | 'employees.view.all'
  | 'employees.view.team'
  | 'employees.create'
  | 'employees.update'
  | 'employees.delete'
  | 'employees.pii.view'
  | 'employees.compensation.view'
  | 'employees.compensation.manage'
  | 'employees.documents.manage'
  | 'employees.checklist.manage'
  | 'assets.view'
  | 'assets.manage'
  | 'assets.assign'
  | 'timesheets.log.own'
  | 'timesheets.view.all'
  | 'timesheets.view.team'
  | 'timesheets.approve'
  | 'timesheets.edit.others'
  | 'attendance.mark.own'
  | 'attendance.view.all'
  | 'attendance.view.team'
  | 'attendance.manage'
  | 'leave.request.own'
  | 'leave.view.all'
  | 'leave.view.team'
  | 'leave.approve'
  | 'leave.balance.manage'
  | 'performance.view.own'
  | 'performance.view.team'
  | 'performance.view.all'
  | 'performance.manage'
  | 'performance.goals.manage'
  | 'calendar.view.own'
  | 'calendar.view.all'
  | 'calendar.manage'
  | 'reports.view'
  | 'reports.financial.view'
  | 'reports.export'
  | 'logs.view'
  | 'settings.org.manage'
  | 'settings.roles.manage'
  | 'settings.users.manage'
  | 'settings.workflows.manage'
  | 'settings.masters.manage';

export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'clients.view.all',
  'clients.view.assigned',
  'clients.create',
  'clients.update',
  'clients.delete',
  'clients.contacts.manage',
  'clients.portal.manage',
  'leads.view.all',
  'leads.view.own',
  'leads.create',
  'leads.update',
  'leads.delete',
  'leads.convert',
  'projects.view.all',
  'projects.view.assigned',
  'projects.create',
  'projects.update',
  'projects.delete',
  'projects.stage.move',
  'projects.members.manage',
  'projects.budget.view',
  'retainers.view.all',
  'retainers.view.assigned',
  'retainers.create',
  'retainers.update',
  'retainers.delete',
  'retainers.cycles.manage',
  'tasks.view.all',
  'tasks.view.assigned',
  'tasks.create',
  'tasks.update',
  'tasks.update.assigned',
  'tasks.assign',
  'tasks.delete',
  'deliverables.view',
  'deliverables.manage',
  'deliverables.version.upload',
  'deliverables.approve.internal',
  'deliverables.request.client',
  'deliverables.publish',
  'employees.view.all',
  'employees.view.team',
  'employees.create',
  'employees.update',
  'employees.delete',
  'employees.pii.view',
  'employees.compensation.view',
  'employees.compensation.manage',
  'employees.documents.manage',
  'employees.checklist.manage',
  'assets.view',
  'assets.manage',
  'assets.assign',
  'timesheets.log.own',
  'timesheets.view.all',
  'timesheets.view.team',
  'timesheets.approve',
  'timesheets.edit.others',
  'attendance.mark.own',
  'attendance.view.all',
  'attendance.view.team',
  'attendance.manage',
  'leave.request.own',
  'leave.view.all',
  'leave.view.team',
  'leave.approve',
  'leave.balance.manage',
  'performance.view.own',
  'performance.view.team',
  'performance.view.all',
  'performance.manage',
  'performance.goals.manage',
  'calendar.view.own',
  'calendar.view.all',
  'calendar.manage',
  'reports.view',
  'reports.financial.view',
  'reports.export',
  'logs.view',
  'settings.org.manage',
  'settings.roles.manage',
  'settings.users.manage',
  'settings.workflows.manage',
  'settings.masters.manage',
];

export interface PermissionGroupDefinition {
  module: string;
  label: string;
  permissions: { key: PermissionKey; label: string }[];
}

/** Grouped for the permission matrix in Settings. */
export const PERMISSION_GROUPS: readonly PermissionGroupDefinition[] = [
  {
    module: 'clients',
    label: "Clients & Contacts",
    permissions: [
      { key: 'clients.view.all', label: "View all clients" },
      { key: 'clients.view.assigned', label: "View clients they manage" },
      { key: 'clients.create', label: "Create clients" },
      { key: 'clients.update', label: "Edit clients" },
      { key: 'clients.delete', label: "Delete clients" },
      { key: 'clients.contacts.manage', label: "Manage client contacts" },
      { key: 'clients.portal.manage', label: "Grant & revoke portal access" },
    ],
  },
  {
    module: 'leads',
    label: "Leads",
    permissions: [
      { key: 'leads.view.all', label: "View all leads" },
      { key: 'leads.view.own', label: "View their own leads" },
      { key: 'leads.create', label: "Create leads" },
      { key: 'leads.update', label: "Edit leads" },
      { key: 'leads.delete', label: "Delete leads" },
      { key: 'leads.convert', label: "Convert a lead into a client" },
    ],
  },
  {
    module: 'projects',
    label: "Projects",
    permissions: [
      { key: 'projects.view.all', label: "View all projects" },
      { key: 'projects.view.assigned', label: "View projects they are on" },
      { key: 'projects.create', label: "Create projects" },
      { key: 'projects.update', label: "Edit projects" },
      { key: 'projects.delete', label: "Delete projects" },
      { key: 'projects.stage.move', label: "Move a project between stages" },
      { key: 'projects.members.manage', label: "Add & remove project members" },
      { key: 'projects.budget.view', label: "See project budget & cost" },
    ],
  },
  {
    module: 'retainers',
    label: "Retainers",
    permissions: [
      { key: 'retainers.view.all', label: "View all retainers" },
      { key: 'retainers.view.assigned', label: "View retainers they are on" },
      { key: 'retainers.create', label: "Create retainers" },
      { key: 'retainers.update', label: "Edit retainers" },
      { key: 'retainers.delete', label: "Delete retainers" },
      { key: 'retainers.cycles.manage', label: "Open, close & edit cycles" },
    ],
  },
  {
    module: 'tasks',
    label: "Tasks",
    permissions: [
      { key: 'tasks.view.all', label: "View all tasks" },
      { key: 'tasks.view.assigned', label: "View their own tasks" },
      { key: 'tasks.create', label: "Create tasks" },
      { key: 'tasks.update', label: "Edit any task" },
      { key: 'tasks.update.assigned', label: "Edit tasks assigned to them" },
      { key: 'tasks.assign', label: "Assign tasks to others" },
      { key: 'tasks.delete', label: "Delete tasks" },
    ],
  },
  {
    module: 'deliverables',
    label: "Deliverables & Approvals",
    permissions: [
      { key: 'deliverables.view', label: "View deliverables" },
      { key: 'deliverables.manage', label: "Create & edit deliverables" },
      { key: 'deliverables.version.upload', label: "Upload new versions" },
      { key: 'deliverables.approve.internal', label: "Give internal approval" },
      { key: 'deliverables.request.client', label: "Send to client for approval" },
      { key: 'deliverables.publish', label: "Mark as published" },
    ],
  },
  {
    module: 'employees',
    label: "Employees",
    permissions: [
      { key: 'employees.view.all', label: "View all employees" },
      { key: 'employees.view.team', label: "View their direct reports" },
      { key: 'employees.create', label: "Add employees" },
      { key: 'employees.update', label: "Edit employees" },
      { key: 'employees.delete', label: "Deactivate employees" },
      { key: 'employees.pii.view', label: "See personal details (DOB, address)" },
      { key: 'employees.compensation.view', label: "See salary information" },
      { key: 'employees.compensation.manage', label: "Edit salary information" },
      { key: 'employees.documents.manage', label: "Manage employee documents" },
      { key: 'employees.checklist.manage', label: "Manage onboarding & exit checklists" },
    ],
  },
  {
    module: 'assets',
    label: "Assets & Equipment",
    permissions: [
      { key: 'assets.view', label: "View assets" },
      { key: 'assets.manage', label: "Add & edit assets" },
      { key: 'assets.assign', label: "Issue & return assets" },
    ],
  },
  {
    module: 'timesheets',
    label: "Time Tracking",
    permissions: [
      { key: 'timesheets.log.own', label: "Log their own time" },
      { key: 'timesheets.view.all', label: "View everyone’s time" },
      { key: 'timesheets.view.team', label: "View their team’s time" },
      { key: 'timesheets.approve', label: "Approve & reject timesheets" },
      { key: 'timesheets.edit.others', label: "Edit other people’s entries" },
    ],
  },
  {
    module: 'attendance',
    label: "Attendance",
    permissions: [
      { key: 'attendance.mark.own', label: "Check in & out" },
      { key: 'attendance.view.all', label: "View all attendance" },
      { key: 'attendance.view.team', label: "View their team’s attendance" },
      { key: 'attendance.manage', label: "Correct attendance records" },
    ],
  },
  {
    module: 'leave',
    label: "Leave",
    permissions: [
      { key: 'leave.request.own', label: "Request leave" },
      { key: 'leave.view.all', label: "View all leave" },
      { key: 'leave.view.team', label: "View their team’s leave" },
      { key: 'leave.approve', label: "Approve & reject leave" },
      { key: 'leave.balance.manage', label: "Adjust leave balances" },
    ],
  },
  {
    module: 'performance',
    label: "Performance",
    permissions: [
      { key: 'performance.view.own', label: "View their own reviews & goals" },
      { key: 'performance.view.team', label: "View their team’s reviews" },
      { key: 'performance.view.all', label: "View all reviews" },
      { key: 'performance.manage', label: "Run review cycles & write reviews" },
      { key: 'performance.goals.manage', label: "Set goals for others" },
    ],
  },
  {
    module: 'calendar',
    label: "Calendar",
    permissions: [
      { key: 'calendar.view.own', label: "View their own calendar" },
      { key: 'calendar.view.all', label: "View the org calendar" },
      { key: 'calendar.manage', label: "Create & edit events" },
    ],
  },
  {
    module: 'reports',
    label: "Reports",
    permissions: [
      { key: 'reports.view', label: "View reports" },
      { key: 'reports.financial.view', label: "View revenue & cost reports" },
      { key: 'reports.export', label: "Export report data" },
    ],
  },
  {
    module: 'logs',
    label: "Activity Log",
    permissions: [
      { key: 'logs.view', label: "View the activity log" },
    ],
  },
  {
    module: 'settings',
    label: "Settings & Administration",
    permissions: [
      { key: 'settings.org.manage', label: "Edit organisation profile" },
      { key: 'settings.roles.manage', label: "Manage roles & permissions" },
      { key: 'settings.users.manage', label: "Invite & deactivate users" },
      { key: 'settings.workflows.manage', label: "Build workflows & project types" },
      { key: 'settings.masters.manage', label: "Manage departments, skills, leave types, holidays" },
    ],
  },
];
