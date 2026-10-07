/**
 * Seeds a usable Digital Dude CRM: roles, the agency's service lines, a workflow
 * per service line, HR master data, and an administrator account. With
 * SEED_DEMO_DATA=true it also creates sample clients, staff, projects and a
 * retainer so every screen has something to show.
 *
 * Safe to re-run: everything is upserted on a natural key.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@digital-dude.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';
const WITH_DEMO = (process.env.SEED_DEMO_DATA ?? 'true') === 'true';

const log = (message: string) => console.log(`  ${message}`);

// ---------------------------------------------------------------------- roles
/**
 * Role presets. Administrator carries isAdmin, which implicitly grants every
 * permission in the registry, so its list is left empty on purpose.
 */
const ROLES: {
  name: string;
  description: string;
  isAdmin?: boolean;
  permissions: string[];
}[] = [
  {
    name: 'Administrator',
    description: 'Full access to everything, including settings and roles.',
    isAdmin: true,
    permissions: [],
  },
  {
    name: 'Operations Manager',
    description: 'Runs delivery across all clients and projects; no role editing.',
    permissions: [
      'clients.view.all', 'clients.create', 'clients.update', 'clients.contacts.manage', 'clients.portal.manage',
      'leads.view.all', 'leads.create', 'leads.update', 'leads.convert',
      'projects.view.all', 'projects.create', 'projects.update', 'projects.stage.move',
      'projects.members.manage', 'projects.budget.view',
      'retainers.view.all', 'retainers.create', 'retainers.update', 'retainers.cycles.manage',
      'tasks.view.all', 'tasks.create', 'tasks.update', 'tasks.assign', 'tasks.delete',
      'deliverables.view', 'deliverables.manage', 'deliverables.version.upload',
      'deliverables.approve.internal', 'deliverables.request.client', 'deliverables.publish',
      'employees.view.all', 'employees.update',
      'assets.view', 'assets.manage', 'assets.assign',
      'timesheets.view.all', 'timesheets.approve',
      'attendance.view.all', 'leave.view.all', 'leave.approve',
      'performance.view.all', 'performance.manage', 'performance.goals.manage',
      'calendar.view.all', 'calendar.manage',
      'reports.view', 'reports.financial.view', 'reports.export',
      'logs.view',
      'settings.workflows.manage', 'settings.masters.manage',
    ],
  },
  {
    name: 'Project Manager',
    description: 'Owns the projects they manage, their team and their clients.',
    permissions: [
      'clients.view.assigned', 'clients.update', 'clients.contacts.manage',
      'leads.view.own', 'leads.create', 'leads.update',
      'projects.view.all', 'projects.create', 'projects.update', 'projects.stage.move',
      'projects.members.manage', 'projects.budget.view',
      'retainers.view.assigned', 'retainers.cycles.manage',
      'tasks.view.all', 'tasks.create', 'tasks.update', 'tasks.assign',
      'deliverables.view', 'deliverables.manage', 'deliverables.version.upload',
      'deliverables.approve.internal', 'deliverables.request.client',
      'employees.view.team',
      'timesheets.view.team', 'timesheets.approve',
      'attendance.view.team', 'leave.view.team', 'leave.approve',
      'performance.view.team',
      'calendar.view.all', 'calendar.manage',
      'reports.view',
    ],
  },
  {
    name: 'Team Lead',
    description: 'Runs a craft team: assigns work and reviews it internally.',
    permissions: [
      'clients.view.assigned',
      'projects.view.assigned', 'projects.update',
      'tasks.view.all', 'tasks.create', 'tasks.update', 'tasks.assign',
      'deliverables.view', 'deliverables.manage', 'deliverables.version.upload',
      'deliverables.approve.internal',
      'employees.view.team',
      'timesheets.view.team',
      'attendance.view.team', 'leave.view.team',
      'calendar.view.all', 'calendar.manage',
      'reports.view',
    ],
  },
  {
    name: 'Executive',
    description: 'Designers, developers, editors and marketers working their own queue.',
    permissions: [
      'projects.view.assigned',
      'tasks.view.assigned', 'tasks.update.assigned', 'tasks.create',
      'deliverables.view', 'deliverables.version.upload',
      'calendar.view.own',
    ],
  },
  {
    name: 'HR & Accounts',
    description: 'People operations, payroll inputs and commercial reporting.',
    permissions: [
      'clients.view.all',
      'employees.view.all', 'employees.create', 'employees.update', 'employees.delete',
      'employees.pii.view', 'employees.compensation.view', 'employees.compensation.manage',
      'employees.documents.manage', 'employees.checklist.manage',
      'assets.view', 'assets.manage', 'assets.assign',
      'timesheets.view.all', 'timesheets.approve',
      'attendance.view.all', 'attendance.manage',
      'leave.view.all', 'leave.approve', 'leave.balance.manage',
      'performance.view.all', 'performance.manage',
      'reports.view', 'reports.financial.view', 'reports.export',
      'logs.view',
      'settings.masters.manage', 'settings.users.manage',
    ],
  },
];

// -------------------------------------------------------------- service lines
const SERVICE_LINES = [
  { name: 'Website & App Development', code: 'WEBDEV' },
  { name: 'SEO', code: 'SEO' },
  { name: 'Social Media Marketing', code: 'SMM' },
  { name: 'Social Media Advertising', code: 'ADS' },
  { name: 'Graphic Design', code: 'DESIGN' },
  { name: 'Videography & Editing', code: 'VIDEO' },
  { name: 'Influencer Marketing', code: 'INFLUENCER' },
  { name: 'Personal Branding', code: 'BRANDING' },
];

/** Standard task status set reused by every workflow. */
const TASK_STATUSES = [
  { name: 'To Do', category: 'TODO' as const, color: '#64748b', isDefault: true },
  { name: 'In Progress', category: 'IN_PROGRESS' as const, color: '#3b82f6', isDefault: false },
  { name: 'Blocked', category: 'BLOCKED' as const, color: '#ef4444', isDefault: false },
  { name: 'In Review', category: 'REVIEW' as const, color: '#f59e0b', isDefault: false },
  { name: 'Done', category: 'DONE' as const, color: '#22c55e', isDefault: false },
  { name: 'Cancelled', category: 'CANCELLED' as const, color: '#94a3b8', isDefault: false },
];

/** A workflow per project type, shaped around how the work actually runs. */
const WORKFLOWS: {
  projectType: { name: string; code: string; description: string };
  workflow: string;
  stages: {
    name: string;
    color: string;
    isTerminal?: boolean;
    isClientFacing?: boolean;
    tasks?: { title: string; dueOffsetDays?: number; estimateHours?: number }[];
  }[];
}[] = [
  {
    projectType: {
      name: 'Website Development',
      code: 'WEBDEV',
      description: 'Marketing sites, e-commerce and web apps.',
    },
    workflow: 'Website Development Pipeline',
    stages: [
      {
        name: 'Discovery',
        color: '#8b5cf6',
        isClientFacing: true,
        tasks: [
          { title: 'Requirement gathering call', dueOffsetDays: 2, estimateHours: 2 },
          { title: 'Sitemap and page list', dueOffsetDays: 4, estimateHours: 4 },
          { title: 'Share proposal and timeline', dueOffsetDays: 5, estimateHours: 2 },
        ],
      },
      {
        name: 'Design',
        color: '#ec4899',
        isClientFacing: true,
        tasks: [
          { title: 'Wireframes', dueOffsetDays: 4, estimateHours: 8 },
          { title: 'Homepage UI design', dueOffsetDays: 7, estimateHours: 12 },
          { title: 'Inner page designs', dueOffsetDays: 12, estimateHours: 16 },
          { title: 'Client design approval', dueOffsetDays: 14 },
        ],
      },
      {
        name: 'Development',
        color: '#3b82f6',
        tasks: [
          { title: 'Environment and repo setup', dueOffsetDays: 1, estimateHours: 3 },
          { title: 'Build pages from approved design', dueOffsetDays: 14, estimateHours: 40 },
          { title: 'CMS / admin integration', dueOffsetDays: 18, estimateHours: 16 },
          { title: 'Contact forms and integrations', dueOffsetDays: 20, estimateHours: 8 },
        ],
      },
      {
        name: 'Content & SEO',
        color: '#14b8a6',
        tasks: [
          { title: 'Upload final content', dueOffsetDays: 3, estimateHours: 6 },
          { title: 'On-page SEO basics', dueOffsetDays: 4, estimateHours: 4 },
          { title: 'Analytics and Search Console', dueOffsetDays: 5, estimateHours: 2 },
        ],
      },
      {
        name: 'QA & Review',
        color: '#f59e0b',
        isClientFacing: true,
        tasks: [
          { title: 'Cross-browser and mobile testing', dueOffsetDays: 2, estimateHours: 6 },
          { title: 'Speed and Core Web Vitals pass', dueOffsetDays: 3, estimateHours: 4 },
          { title: 'Client UAT and feedback', dueOffsetDays: 5 },
        ],
      },
      {
        name: 'Launch',
        color: '#22c55e',
        isClientFacing: true,
        tasks: [
          { title: 'Domain, SSL and hosting go-live', dueOffsetDays: 1, estimateHours: 3 },
          { title: 'Post-launch smoke test', dueOffsetDays: 1, estimateHours: 2 },
          { title: 'Handover documentation', dueOffsetDays: 3, estimateHours: 3 },
        ],
      },
      { name: 'Closed', color: '#64748b', isTerminal: true },
    ],
  },
  {
    projectType: {
      name: 'Social Media Management',
      code: 'SMM',
      description: 'Monthly social media retainers.',
    },
    workflow: 'Monthly Social Media Cycle',
    stages: [
      {
        name: 'Planning',
        color: '#8b5cf6',
        tasks: [
          { title: 'Monthly content calendar', dueOffsetDays: 3, estimateHours: 5 },
          { title: 'Campaign and hook ideation', dueOffsetDays: 4, estimateHours: 4 },
        ],
      },
      {
        name: 'Production',
        color: '#ec4899',
        tasks: [
          { title: 'Shoot / asset collection', dueOffsetDays: 8, estimateHours: 8 },
          { title: 'Creative design batch', dueOffsetDays: 12, estimateHours: 14 },
          { title: 'Reel editing batch', dueOffsetDays: 14, estimateHours: 12 },
          { title: 'Caption and hashtag copy', dueOffsetDays: 15, estimateHours: 4 },
        ],
      },
      {
        name: 'Client Approval',
        color: '#f59e0b',
        isClientFacing: true,
        tasks: [{ title: 'Send calendar for approval', dueOffsetDays: 16 }],
      },
      {
        name: 'Scheduling & Publishing',
        color: '#3b82f6',
        tasks: [
          { title: 'Schedule approved posts', dueOffsetDays: 18, estimateHours: 3 },
          { title: 'Community management pass', dueOffsetDays: 28, estimateHours: 6 },
        ],
      },
      {
        name: 'Reporting',
        color: '#22c55e',
        isClientFacing: true,
        isTerminal: true,
        tasks: [
          { title: 'Pull monthly analytics', dueOffsetDays: 1, estimateHours: 3 },
          { title: 'Share performance report', dueOffsetDays: 2, estimateHours: 2 },
        ],
      },
    ],
  },
  {
    projectType: {
      name: 'Video Production',
      code: 'VIDEO',
      description: 'Ad films, brand videos, reels and event coverage.',
    },
    workflow: 'Video Production Pipeline',
    stages: [
      {
        name: 'Brief & Concept',
        color: '#8b5cf6',
        isClientFacing: true,
        tasks: [
          { title: 'Creative brief call', dueOffsetDays: 2, estimateHours: 2 },
          { title: 'Concept and script', dueOffsetDays: 5, estimateHours: 8 },
          { title: 'Script approval', dueOffsetDays: 7 },
        ],
      },
      {
        name: 'Pre-production',
        color: '#06b6d4',
        tasks: [
          { title: 'Storyboard / shot list', dueOffsetDays: 3, estimateHours: 6 },
          { title: 'Location, crew and gear booking', dueOffsetDays: 5, estimateHours: 4 },
          { title: 'Casting and call sheet', dueOffsetDays: 6, estimateHours: 3 },
        ],
      },
      {
        name: 'Shoot',
        color: '#f97316',
        tasks: [
          { title: 'Shoot day', dueOffsetDays: 1, estimateHours: 10 },
          { title: 'Footage backup and transfer', dueOffsetDays: 1, estimateHours: 2 },
        ],
      },
      {
        name: 'Post-production',
        color: '#ec4899',
        tasks: [
          { title: 'First cut', dueOffsetDays: 5, estimateHours: 14 },
          { title: 'Colour and sound', dueOffsetDays: 8, estimateHours: 8 },
          { title: 'Graphics and subtitles', dueOffsetDays: 9, estimateHours: 6 },
        ],
      },
      {
        name: 'Client Review',
        color: '#f59e0b',
        isClientFacing: true,
        tasks: [{ title: 'Share cut for feedback', dueOffsetDays: 10 }],
      },
      {
        name: 'Delivery',
        color: '#22c55e',
        isTerminal: true,
        isClientFacing: true,
        tasks: [
          { title: 'Export platform versions', dueOffsetDays: 2, estimateHours: 4 },
          { title: 'Hand over master files', dueOffsetDays: 3, estimateHours: 1 },
        ],
      },
    ],
  },
  {
    projectType: {
      name: 'Performance Marketing',
      code: 'ADS',
      description: 'Paid social and search campaigns.',
    },
    workflow: 'Paid Campaign Pipeline',
    stages: [
      {
        name: 'Audit & Strategy',
        color: '#8b5cf6',
        tasks: [
          { title: 'Account and audience audit', dueOffsetDays: 3, estimateHours: 5 },
          { title: 'Media plan and budget split', dueOffsetDays: 5, estimateHours: 4 },
        ],
      },
      {
        name: 'Creative & Setup',
        color: '#ec4899',
        tasks: [
          { title: 'Ad creative batch', dueOffsetDays: 5, estimateHours: 10 },
          { title: 'Pixel and conversion tracking', dueOffsetDays: 4, estimateHours: 4 },
          { title: 'Campaign build', dueOffsetDays: 6, estimateHours: 5 },
        ],
      },
      {
        name: 'Live & Optimising',
        color: '#3b82f6',
        tasks: [
          { title: 'Daily pacing check', dueOffsetDays: 1, estimateHours: 1 },
          { title: 'Weekly optimisation pass', dueOffsetDays: 7, estimateHours: 3 },
        ],
      },
      {
        name: 'Reporting',
        color: '#22c55e',
        isTerminal: true,
        isClientFacing: true,
        tasks: [{ title: 'Performance report', dueOffsetDays: 2, estimateHours: 3 }],
      },
    ],
  },
  {
    projectType: {
      name: 'Branding & Design',
      code: 'BRANDING',
      description: 'Identity, collateral and personal branding.',
    },
    workflow: 'Branding Pipeline',
    stages: [
      {
        name: 'Discovery',
        color: '#8b5cf6',
        isClientFacing: true,
        tasks: [
          { title: 'Brand questionnaire and call', dueOffsetDays: 3, estimateHours: 3 },
          { title: 'Moodboard and direction', dueOffsetDays: 6, estimateHours: 6 },
        ],
      },
      {
        name: 'Concepts',
        color: '#ec4899',
        tasks: [
          { title: 'Logo concepts', dueOffsetDays: 7, estimateHours: 14 },
          { title: 'Internal review', dueOffsetDays: 8, estimateHours: 2 },
        ],
      },
      {
        name: 'Client Review',
        color: '#f59e0b',
        isClientFacing: true,
        tasks: [{ title: 'Present concepts', dueOffsetDays: 9 }],
      },
      {
        name: 'Refinement',
        color: '#06b6d4',
        tasks: [
          { title: 'Apply feedback', dueOffsetDays: 4, estimateHours: 8 },
          { title: 'Build collateral set', dueOffsetDays: 8, estimateHours: 12 },
        ],
      },
      {
        name: 'Handover',
        color: '#22c55e',
        isTerminal: true,
        isClientFacing: true,
        tasks: [
          { title: 'Brand guidelines document', dueOffsetDays: 4, estimateHours: 8 },
          { title: 'Deliver source files', dueOffsetDays: 5, estimateHours: 2 },
        ],
      },
    ],
  },
  {
    projectType: {
      name: 'Influencer Campaign',
      code: 'INFLUENCER',
      description: 'Creator-led campaigns and seeding.',
    },
    workflow: 'Influencer Campaign Pipeline',
    stages: [
      {
        name: 'Brief & Shortlist',
        color: '#8b5cf6',
        tasks: [
          { title: 'Campaign brief', dueOffsetDays: 2, estimateHours: 3 },
          { title: 'Creator shortlist with rates', dueOffsetDays: 5, estimateHours: 6 },
        ],
      },
      {
        name: 'Onboarding',
        color: '#06b6d4',
        tasks: [
          { title: 'Outreach and negotiation', dueOffsetDays: 5, estimateHours: 8 },
          { title: 'Contracts and briefs sent', dueOffsetDays: 7, estimateHours: 4 },
        ],
      },
      {
        name: 'Content Review',
        color: '#f59e0b',
        isClientFacing: true,
        tasks: [{ title: 'Review creator drafts', dueOffsetDays: 5, estimateHours: 4 }],
      },
      {
        name: 'Live',
        color: '#3b82f6',
        tasks: [{ title: 'Track go-live and engagement', dueOffsetDays: 7, estimateHours: 4 }],
      },
      {
        name: 'Wrap-up',
        color: '#22c55e',
        isTerminal: true,
        isClientFacing: true,
        tasks: [
          { title: 'Collect metrics from creators', dueOffsetDays: 3, estimateHours: 3 },
          { title: 'Campaign report', dueOffsetDays: 5, estimateHours: 3 },
        ],
      },
    ],
  },
];

const DEPARTMENTS = [
  { name: 'Management', code: 'MGMT' },
  { name: 'Design', code: 'DSGN' },
  { name: 'Development', code: 'DEV' },
  { name: 'Digital Marketing', code: 'MKTG' },
  { name: 'Video Production', code: 'VID' },
  { name: 'Client Servicing', code: 'CS' },
  { name: 'HR & Accounts', code: 'HR' },
];

const DESIGNATIONS = [
  { title: 'Founder', level: 10 },
  { title: 'Operations Manager', level: 8 },
  { title: 'Project Manager', level: 7 },
  { title: 'Team Lead', level: 6 },
  { title: 'Senior Developer', level: 5 },
  { title: 'Developer', level: 4 },
  { title: 'Senior Designer', level: 5 },
  { title: 'Graphic Designer', level: 4 },
  { title: 'Video Editor', level: 4 },
  { title: 'Videographer', level: 4 },
  { title: 'SEO Specialist', level: 4 },
  { title: 'Social Media Executive', level: 3 },
  { title: 'Performance Marketer', level: 4 },
  { title: 'Client Servicing Executive', level: 3 },
  { title: 'HR Executive', level: 4 },
  { title: 'Intern', level: 1 },
];

const SKILLS = [
  { name: 'React', category: 'Development' },
  { name: 'Node.js', category: 'Development' },
  { name: 'WordPress', category: 'Development' },
  { name: 'Shopify', category: 'Development' },
  { name: 'Figma', category: 'Design' },
  { name: 'Photoshop', category: 'Design' },
  { name: 'Illustrator', category: 'Design' },
  { name: 'Premiere Pro', category: 'Video' },
  { name: 'After Effects', category: 'Video' },
  { name: 'DaVinci Resolve', category: 'Video' },
  { name: 'Cinematography', category: 'Video' },
  { name: 'Meta Ads', category: 'Marketing' },
  { name: 'Google Ads', category: 'Marketing' },
  { name: 'Technical SEO', category: 'Marketing' },
  { name: 'Copywriting', category: 'Content' },
  { name: 'Content Strategy', category: 'Content' },
  { name: 'Influencer Outreach', category: 'Marketing' },
];

const LEAVE_TYPES = [
  { name: 'Casual Leave', code: 'CL', annualQuota: 12, isPaid: true, carryForward: false, requiresProof: false },
  { name: 'Sick Leave', code: 'SL', annualQuota: 8, isPaid: true, carryForward: false, requiresProof: true },
  { name: 'Earned Leave', code: 'EL', annualQuota: 12, isPaid: true, carryForward: true, requiresProof: false },
  { name: 'Loss of Pay', code: 'LOP', annualQuota: 0, isPaid: false, carryForward: false, requiresProof: false },
  { name: 'Maternity Leave', code: 'ML', annualQuota: 182, isPaid: true, carryForward: false, requiresProof: true },
  { name: 'Paternity Leave', code: 'PL', annualQuota: 10, isPaid: true, carryForward: false, requiresProof: false },
  { name: 'Comp Off', code: 'CO', annualQuota: 0, isPaid: true, carryForward: false, requiresProof: false },
];

/** Public holidays as observed in Tamil Nadu; adjust each year in Settings. */
const HOLIDAYS_2026 = [
  { name: 'New Year’s Day', date: '2026-01-01' },
  { name: 'Pongal', date: '2026-01-14' },
  { name: 'Thiruvalluvar Day', date: '2026-01-15' },
  { name: 'Republic Day', date: '2026-01-26' },
  { name: 'Tamil New Year', date: '2026-04-14' },
  { name: 'May Day', date: '2026-05-01' },
  { name: 'Independence Day', date: '2026-08-15' },
  { name: 'Vinayaka Chaturthi', date: '2026-09-14' },
  { name: 'Gandhi Jayanti', date: '2026-10-02' },
  { name: 'Ayudha Pooja', date: '2026-10-19' },
  { name: 'Diwali', date: '2026-11-08' },
  { name: 'Christmas', date: '2026-12-25' },
];

const ONBOARDING_ITEMS = [
  { label: 'Collect ID and address proof', dueOffsetDays: 0, ownerRoleHint: 'HR & Accounts' },
  { label: 'Signed offer letter on file', dueOffsetDays: 0, ownerRoleHint: 'HR & Accounts' },
  { label: 'Create email and CRM account', dueOffsetDays: 0, ownerRoleHint: 'Administrator' },
  { label: 'Issue laptop and accessories', dueOffsetDays: 1, ownerRoleHint: 'Operations Manager' },
  { label: 'Add to WhatsApp and project tools', dueOffsetDays: 1 },
  { label: 'Brand, tools and process walkthrough', dueOffsetDays: 3 },
  { label: 'Assign a buddy and first project', dueOffsetDays: 3, ownerRoleHint: 'Team Lead' },
  { label: '30-day check-in', dueOffsetDays: 30, ownerRoleHint: 'Project Manager' },
];

const OFFBOARDING_ITEMS = [
  { label: 'Reassign open tasks and projects', dueOffsetDays: 0, ownerRoleHint: 'Project Manager' },
  { label: 'Knowledge transfer session', dueOffsetDays: 1 },
  { label: 'Collect laptop and all assets', dueOffsetDays: 0, ownerRoleHint: 'Operations Manager' },
  { label: 'Revoke CRM, email and tool access', dueOffsetDays: 0, ownerRoleHint: 'Administrator' },
  { label: 'Final settlement processed', dueOffsetDays: 30, ownerRoleHint: 'HR & Accounts' },
  { label: 'Exit interview', dueOffsetDays: 1, ownerRoleHint: 'HR & Accounts' },
  { label: 'Issue relieving letter', dueOffsetDays: 7, ownerRoleHint: 'HR & Accounts' },
];

const day = (offset: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date;
};

async function seedMasters() {
  log('roles');
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      create: {
        name: role.name,
        description: role.description,
        isSystem: true,
        isAdmin: role.isAdmin ?? false,
        permissions: role.permissions,
      },
      update: {
        description: role.description,
        isSystem: true,
        isAdmin: role.isAdmin ?? false,
        // Re-running the seed re-applies the preset, which is what makes it
        // useful after new permissions are added to the registry.
        permissions: role.permissions,
      },
    });
  }

  log('departments, designations and skills');
  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { name: dept.name },
      create: dept,
      update: { code: dept.code },
    });
  }
  for (const designation of DESIGNATIONS) {
    await prisma.designation.upsert({
      where: { title: designation.title },
      create: designation,
      update: { level: designation.level },
    });
  }
  for (const skill of SKILLS) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      create: skill,
      update: { category: skill.category },
    });
  }

  log('service lines');
  for (const line of SERVICE_LINES) {
    await prisma.serviceLine.upsert({
      where: { code: line.code },
      create: line,
      update: { name: line.name },
    });
  }

  log('leave types, holidays and work schedule');
  for (const type of LEAVE_TYPES) {
    await prisma.leaveType.upsert({
      where: { code: type.code },
      create: type,
      update: type,
    });
  }
  for (const holiday of HOLIDAYS_2026) {
    await prisma.holiday.upsert({
      where: { name_date: { name: holiday.name, date: new Date(holiday.date) } },
      create: { name: holiday.name, date: new Date(holiday.date) },
      update: {},
    });
  }
  await prisma.workSchedule.upsert({
    where: { name: 'Standard (Mon-Sat)' },
    create: {
      name: 'Standard (Mon-Sat)',
      workingDays: [1, 2, 3, 4, 5, 6],
      startTime: '09:00',
      endTime: '20:00',
      isDefault: true,
    },
    update: { isDefault: true },
  });

  log('onboarding and offboarding checklists');
  const onboarding = await prisma.checklistTemplate.upsert({
    where: { name_kind: { name: 'Standard Onboarding', kind: 'ONBOARDING' } },
    create: { name: 'Standard Onboarding', kind: 'ONBOARDING', isDefault: true },
    update: { isDefault: true },
  });
  await prisma.checklistTemplateItem.deleteMany({ where: { templateId: onboarding.id } });
  await prisma.checklistTemplateItem.createMany({
    data: ONBOARDING_ITEMS.map((item, index) => ({
      templateId: onboarding.id,
      label: item.label,
      ownerRoleHint: item.ownerRoleHint ?? null,
      dueOffsetDays: item.dueOffsetDays,
      sortOrder: index,
    })),
  });

  const offboarding = await prisma.checklistTemplate.upsert({
    where: { name_kind: { name: 'Standard Offboarding', kind: 'OFFBOARDING' } },
    create: { name: 'Standard Offboarding', kind: 'OFFBOARDING', isDefault: true },
    update: { isDefault: true },
  });
  await prisma.checklistTemplateItem.deleteMany({ where: { templateId: offboarding.id } });
  await prisma.checklistTemplateItem.createMany({
    data: OFFBOARDING_ITEMS.map((item, index) => ({
      templateId: offboarding.id,
      label: item.label,
      ownerRoleHint: item.ownerRoleHint ?? null,
      dueOffsetDays: item.dueOffsetDays,
      sortOrder: index,
    })),
  });
}

async function seedWorkflows() {
  log('project types and workflows');
  for (const entry of WORKFLOWS) {
    const projectType = await prisma.projectType.upsert({
      where: { code: entry.projectType.code },
      create: entry.projectType,
      update: { name: entry.projectType.name, description: entry.projectType.description },
    });

    const existing = await prisma.workflowTemplate.findFirst({
      where: { name: entry.workflow, projectTypeId: projectType.id },
    });
    if (existing) {
      await prisma.projectType.update({
        where: { id: projectType.id },
        data: { defaultWorkflowId: existing.id },
      });
      continue;
    }

    const workflow = await prisma.workflowTemplate.create({
      data: {
        name: entry.workflow,
        description: `Default pipeline for ${entry.projectType.name.toLowerCase()}.`,
        projectTypeId: projectType.id,
        taskStatuses: {
          create: TASK_STATUSES.map((status, index) => ({ ...status, sortOrder: index })),
        },
        stages: {
          create: entry.stages.map((stage, index) => ({
            name: stage.name,
            color: stage.color,
            sortOrder: index,
            isTerminal: stage.isTerminal ?? false,
            isClientFacing: stage.isClientFacing ?? false,
            defaultTasks: {
              create: (stage.tasks ?? []).map((task, taskIndex) => ({
                title: task.title,
                dueOffsetDays: task.dueOffsetDays ?? 0,
                estimateHours: task.estimateHours ?? null,
                sortOrder: taskIndex,
              })),
            },
          })),
        },
      },
    });

    await prisma.projectType.update({
      where: { id: projectType.id },
      data: { defaultWorkflowId: workflow.id },
    });
  }
}

async function seedOrgSettings() {
  log('organisation profile');
  const profile = {
    name: 'Digital Dude',
    tagline: 'Your Digital Partner',
    email: 'wedigitaldude@gmail.com',
    phone: '+91 97870 97006',
    website: 'https://digital-dude.com',
    addressLine: 'No. 90, Ramanujakoodam Street, Poonamallee',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600056',
    country: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    financialYearStartMonth: 4,
  };

  await prisma.setting.upsert({
    where: { key: 'org.profile' },
    create: { key: 'org.profile', value: profile as Prisma.InputJsonObject },
    update: { value: profile as Prisma.InputJsonObject },
  });
}

async function seedAdmin() {
  log(`administrator (${ADMIN_EMAIL})`);
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'Administrator' } });

  const user = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      kind: 'STAFF',
      email: ADMIN_EMAIL,
      name: 'Lalith',
      status: 'ACTIVE',
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
      roleId: adminRole.id,
      // The seeded password is known, so force a change on first sign-in.
      mustChangePassword: true,
    },
    update: { roleId: adminRole.id, status: 'ACTIVE' },
  });

  const existingEmployee = await prisma.employee.findUnique({ where: { userId: user.id } });
  if (!existingEmployee) {
    const [department, designation] = await Promise.all([
      prisma.department.findUnique({ where: { name: 'Management' } }),
      prisma.designation.findUnique({ where: { title: 'Founder' } }),
    ]);
    const sequence = await prisma.sequence.upsert({
      where: { key: 'employee' },
      create: { key: 'employee', current: 1 },
      update: { current: { increment: 1 } },
    });

    await prisma.employee.create({
      data: {
        employeeCode: `DD-${String(sequence.current).padStart(4, '0')}`,
        userId: user.id,
        departmentId: department?.id ?? null,
        designationId: designation?.id ?? null,
        status: 'ACTIVE',
        dateOfJoining: day(-900),
        weeklyCapacityHours: 45,
      },
    });
  }

  return user;
}

async function seedDemo() {
  const existingClients = await prisma.client.count();
  if (existingClients > 0) {
    log('demo data already present, skipping');
    return;
  }

  log('demo employees');
  const roles = await prisma.role.findMany();
  const roleByName = new Map(roles.map((r) => [r.name, r.id]));
  const departments = new Map(
    (await prisma.department.findMany()).map((d) => [d.name, d.id]),
  );
  const designations = new Map(
    (await prisma.designation.findMany()).map((d) => [d.title, d.id]),
  );

  const staffSeed = [
    { name: 'Priya Raman', email: 'priya@digital-dude.com', role: 'Operations Manager', dept: 'Management', title: 'Operations Manager', capacity: 45 },
    { name: 'Arun Kumar', email: 'arun@digital-dude.com', role: 'Project Manager', dept: 'Client Servicing', title: 'Project Manager', capacity: 45 },
    { name: 'Divya Sekar', email: 'divya@digital-dude.com', role: 'Team Lead', dept: 'Design', title: 'Senior Designer', capacity: 45 },
    { name: 'Karthik Vel', email: 'karthik@digital-dude.com', role: 'Team Lead', dept: 'Development', title: 'Senior Developer', capacity: 45 },
    { name: 'Sneha Iyer', email: 'sneha@digital-dude.com', role: 'Executive', dept: 'Digital Marketing', title: 'Social Media Executive', capacity: 40 },
    { name: 'Vignesh Babu', email: 'vignesh@digital-dude.com', role: 'Executive', dept: 'Video Production', title: 'Video Editor', capacity: 40 },
    { name: 'Meena Lakshmi', email: 'meena@digital-dude.com', role: 'HR & Accounts', dept: 'HR & Accounts', title: 'HR Executive', capacity: 40 },
    { name: 'Rahul Dev', email: 'rahul@digital-dude.com', role: 'Executive', dept: 'Development', title: 'Developer', capacity: 40 },
  ];

  const password = await bcrypt.hash('Welcome@2026', 12);
  const employees: { id: string; name: string; userId: string }[] = [];

  for (const [index, person] of staffSeed.entries()) {
    const user = await prisma.user.create({
      data: {
        kind: 'STAFF',
        email: person.email,
        name: person.name,
        status: 'ACTIVE',
        passwordHash: password,
        mustChangePassword: true,
        roleId: roleByName.get(person.role) ?? null,
      },
    });

    const employee = await prisma.employee.create({
      data: {
        employeeCode: `DD-${String(index + 2).padStart(4, '0')}`,
        userId: user.id,
        departmentId: departments.get(person.dept) ?? null,
        designationId: designations.get(person.title) ?? null,
        status: 'ACTIVE',
        dateOfJoining: day(-400 + index * 30),
        weeklyCapacityHours: person.capacity,
      },
    });

    employees.push({ id: employee.id, name: person.name, userId: user.id });
  }

  // Reporting lines: everyone rolls up to Priya, with leads under Arun.
  const priya = employees[0];
  const arun = employees[1];
  if (priya && arun) {
    await prisma.employee.update({
      where: { id: arun.id },
      data: { reportingToId: priya.id },
    });
    for (const employee of employees.slice(2)) {
      await prisma.employee.update({
        where: { id: employee.id },
        data: { reportingToId: arun.id },
      });
    }
  }

  // Leave balances for the current year.
  const leaveTypes = await prisma.leaveType.findMany({ where: { active: true } });
  const year = new Date().getFullYear();
  await prisma.leaveBalance.createMany({
    data: employees.flatMap((employee) =>
      leaveTypes.map((type) => ({
        employeeId: employee.id,
        leaveTypeId: type.id,
        year,
        entitled: type.annualQuota,
      })),
    ),
    skipDuplicates: true,
  });

  log('demo clients and contacts');
  const serviceLines = new Map(
    (await prisma.serviceLine.findMany()).map((s) => [s.code, s.id]),
  );

  const clientSeed = [
    { name: 'LetsPropStore', industry: 'Real Estate', city: 'Chennai', lines: ['WEBDEV', 'SMM', 'ADS'], contact: 'Vikram Shah', email: 'vikram@letspropstore.example' },
    { name: 'TinyLittleToes', industry: 'Kids Retail', city: 'Chennai', lines: ['SMM', 'DESIGN', 'VIDEO'], contact: 'Anitha Rao', email: 'anitha@tinylittletoes.example' },
    { name: 'Wishkart', industry: 'E-commerce', city: 'Bengaluru', lines: ['WEBDEV', 'SEO', 'ADS'], contact: 'Rohit Menon', email: 'rohit@wishkart.example' },
    { name: 'Saravana Caterers', industry: 'Food Services', city: 'Poonamallee', lines: ['SMM', 'VIDEO'], contact: 'Saravanan M', email: 'saravanan@caterers.example' },
    { name: 'Dr. Kavitha Clinic', industry: 'Healthcare', city: 'Chennai', lines: ['BRANDING', 'SMM'], contact: 'Dr. Kavitha', email: 'kavitha@clinic.example' },
  ];

  const clients: { id: string; name: string }[] = [];
  for (const [index, entry] of clientSeed.entries()) {
    const client = await prisma.client.create({
      data: {
        name: entry.name,
        status: 'ACTIVE',
        industry: entry.industry,
        city: entry.city,
        state: 'Tamil Nadu',
        onboardedAt: day(-200 + index * 20),
        accountManagerId: index % 2 === 0 ? arun?.id : priya?.id,
        serviceLines: {
          create: entry.lines
            .map((code) => serviceLines.get(code))
            .filter(Boolean)
            .map((serviceLineId) => ({ serviceLineId: serviceLineId as string })),
        },
        contacts: {
          create: {
            name: entry.contact,
            email: entry.email,
            isPrimary: true,
            designation: 'Owner',
          },
        },
      },
    });
    clients.push({ id: client.id, name: client.name });
  }

  log('demo leads');
  const leadSeed = [
    { title: 'Website revamp enquiry', companyName: 'Chennai Interiors', contactName: 'Suresh K', source: 'INSTAGRAM' as const, status: 'QUALIFIED' as const, value: 120000 },
    { title: 'Monthly social media', companyName: 'Fitness First Gym', contactName: 'Deepak R', source: 'REFERRAL' as const, status: 'PROPOSAL_SENT' as const, value: 25000 },
    { title: 'Product shoot + reels', companyName: 'Mango Threads', contactName: 'Nisha P', source: 'WALK_IN' as const, status: 'NEW' as const, value: 60000 },
    { title: 'Google Ads for clinic', companyName: 'Smile Dental', contactName: 'Dr. Ramesh', source: 'GOOGLE' as const, status: 'NEGOTIATION' as const, value: 40000 },
    { title: 'Brand identity', companyName: 'Verdant Organics', contactName: 'Lakshmi S', source: 'WEBSITE' as const, status: 'CONTACTED' as const, value: 85000 },
  ];

  for (const [index, lead] of leadSeed.entries()) {
    await prisma.lead.create({
      data: {
        title: lead.title,
        companyName: lead.companyName,
        contactName: lead.contactName,
        source: lead.source,
        status: lead.status,
        estimatedValue: lead.value,
        ownerId: index % 2 === 0 ? arun?.id : priya?.id,
        nextFollowUpAt: day(index - 1),
        requirement: 'Captured from the enquiry form. Needs a scoped proposal.',
      },
    });
  }

  log('demo projects, tasks and a retainer');
  const projectTypes = new Map(
    (await prisma.projectType.findMany({ include: { defaultWorkflow: true } })).map((t) => [
      t.code,
      t,
    ]),
  );

  const projectSeed = [
    { client: 'LetsPropStore', type: 'WEBDEV', name: 'LetsPropStore website revamp', line: 'WEBDEV', budget: 185000, dueIn: 25, manager: arun?.id, members: [employees[3]?.id, employees[7]?.id, employees[2]?.id] },
    { client: 'Wishkart', type: 'WEBDEV', name: 'Wishkart Shopify migration', line: 'WEBDEV', budget: 240000, dueIn: 45, manager: arun?.id, members: [employees[3]?.id, employees[7]?.id] },
    { client: 'TinyLittleToes', type: 'VIDEO', name: 'TinyLittleToes festive campaign film', line: 'VIDEO', budget: 95000, dueIn: 12, manager: priya?.id, members: [employees[5]?.id, employees[2]?.id] },
    { client: 'Dr. Kavitha Clinic', type: 'BRANDING', name: 'Clinic brand identity', line: 'BRANDING', budget: 70000, dueIn: 30, manager: priya?.id, members: [employees[2]?.id] },
  ];

  let projectCounter = 0;
  let taskCounter = 0;

  for (const entry of projectSeed) {
    const client = clients.find((c) => c.name === entry.client);
    const type = projectTypes.get(entry.type);
    if (!client || !type?.defaultWorkflow) continue;

    projectCounter += 1;
    const workflowId = type.defaultWorkflow.id;
    const stages = await prisma.workflowStage.findMany({
      where: { workflowId },
      orderBy: { sortOrder: 'asc' },
      include: { defaultTasks: { orderBy: { sortOrder: 'asc' } } },
    });
    const statuses = await prisma.taskStatus.findMany({ where: { workflowId } });
    const todo = statuses.find((s) => s.isDefault) ?? statuses[0];
    const inProgress = statuses.find((s) => s.category === 'IN_PROGRESS') ?? todo;
    const done = statuses.find((s) => s.category === 'DONE') ?? todo;
    // Park each demo project a little way into its pipeline.
    const currentStage = stages[Math.min(1, stages.length - 1)];
    if (!todo || !currentStage) continue;

    const project = await prisma.project.create({
      data: {
        code: `PRJ-${String(projectCounter).padStart(4, '0')}`,
        name: entry.name,
        clientId: client.id,
        projectTypeId: type.id,
        serviceLineId: serviceLines.get(entry.line) ?? null,
        workflowId,
        currentStageId: currentStage.id,
        managerId: entry.manager ?? null,
        status: 'ACTIVE',
        priority: 'HIGH',
        startDate: day(-20),
        dueDate: day(entry.dueIn),
        budgetAmount: entry.budget,
        description: 'Seeded demo project so the dashboards and boards have data.',
        members: {
          create: (entry.members.filter(Boolean) as string[]).map((employeeId, i) => ({
            employeeId,
            role: i === 0 ? 'LEAD' : 'MEMBER',
            allocationHours: i === 0 ? 16 : 10,
          })),
        },
        milestones: {
          create: [
            { title: 'Design sign-off', dueDate: day(Math.round(entry.dueIn / 3)) },
            { title: 'Go-live', dueDate: day(entry.dueIn) },
          ],
        },
      },
    });

    await prisma.projectStageHistory.create({
      data: {
        projectId: project.id,
        stageId: stages[0]?.id ?? currentStage.id,
        enteredAt: day(-20),
        exitedAt: day(-8),
        note: 'Seeded',
      },
    });
    await prisma.projectStageHistory.create({
      data: { projectId: project.id, stageId: currentStage.id, enteredAt: day(-8) },
    });

    // Seed the first two stages' checklists, with the earliest ones closed off.
    for (const [stageIndex, stage] of stages.slice(0, 2).entries()) {
      for (const [taskIndex, template] of stage.defaultTasks.entries()) {
        taskCounter += 1;
        const assignee = (entry.members.filter(Boolean) as string[])[
          taskIndex % Math.max(1, entry.members.filter(Boolean).length)
        ];
        const complete = stageIndex === 0;
        const working = stageIndex === 1 && taskIndex === 0;

        await prisma.task.create({
          data: {
            reference: `TSK-${String(taskCounter).padStart(4, '0')}`,
            title: template.title,
            projectId: project.id,
            stageId: stage.id,
            statusId: complete ? (done?.id ?? todo.id) : working ? (inProgress?.id ?? todo.id) : todo.id,
            assigneeId: assignee ?? null,
            estimateHours: template.estimateHours,
            dueDate: day(-10 + stageIndex * 8 + template.dueOffsetDays),
            completedAt: complete ? day(-9 + taskIndex) : null,
            priority: taskIndex === 0 ? 'HIGH' : 'MEDIUM',
            sortOrder: taskIndex,
          },
        });
      }
    }

    await prisma.deliverable.create({
      data: {
        title: `${entry.name} - first review pack`,
        projectId: project.id,
        status: 'INTERNAL_REVIEW',
        dueDate: day(5),
        description: 'Seeded deliverable awaiting internal review.',
      },
    });
  }

  // A monthly SMM retainer with an open cycle, which is how most of the
  // agency's recurring work actually looks.
  const smmType = projectTypes.get('SMM');
  const toes = clients.find((c) => c.name === 'TinyLittleToes');
  if (smmType?.defaultWorkflow && toes) {
    const workflowId = smmType.defaultWorkflow.id;
    const stages = await prisma.workflowStage.findMany({
      where: { workflowId },
      orderBy: { sortOrder: 'asc' },
      include: { defaultTasks: { orderBy: { sortOrder: 'asc' } } },
    });
    const statuses = await prisma.taskStatus.findMany({ where: { workflowId } });
    const todo = statuses.find((s) => s.isDefault) ?? statuses[0];
    const firstStage = stages[0];

    if (todo && firstStage) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);

      const retainer = await prisma.retainer.create({
        data: {
          code: 'RET-0001',
          name: 'TinyLittleToes social media retainer',
          clientId: toes.id,
          serviceLineId: serviceLines.get('SMM') ?? null,
          projectTypeId: smmType.id,
          workflowId,
          managerId: priya?.id ?? null,
          status: 'ACTIVE',
          billingCycle: 'MONTHLY',
          amountPerCycle: 35000,
          startDate: day(-90),
          endDate: day(275),
          scopeNotes: '16 static posts, 8 reels, community management, monthly report.',
        },
      });

      const cycle = await prisma.retainerCycle.create({
        data: {
          retainerId: retainer.id,
          label: monthStart.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
          periodStart: monthStart,
          periodEnd: monthEnd,
          status: 'IN_PROGRESS',
          currentStageId: firstStage.id,
        },
      });

      for (const [index, template] of firstStage.defaultTasks.entries()) {
        taskCounter += 1;
        await prisma.task.create({
          data: {
            reference: `TSK-${String(taskCounter).padStart(4, '0')}`,
            title: template.title,
            retainerCycleId: cycle.id,
            stageId: firstStage.id,
            statusId: todo.id,
            assigneeId: employees[4]?.id ?? null,
            estimateHours: template.estimateHours,
            dueDate: day(template.dueOffsetDays),
            sortOrder: index,
          },
        });
      }
    }
  }

  log('demo time entries');
  const demoTasks = await prisma.task.findMany({
    where: { assigneeId: { not: null } },
    select: { id: true, assigneeId: true, projectId: true },
    take: 24,
  });
  for (const [index, task] of demoTasks.entries()) {
    if (!task.assigneeId) continue;
    const workDate = day(-(index % 10) - 1);
    await prisma.timeEntry.create({
      data: {
        employeeId: task.assigneeId,
        taskId: task.id,
        projectId: task.projectId,
        workDate,
        hours: 2 + (index % 4),
        billable: true,
        note: 'Seeded time entry',
      },
    });
  }

  log('demo attendance for the last 10 days');
  for (const employee of employees) {
    for (let offset = 1; offset <= 10; offset += 1) {
      const workDate = day(-offset);
      if (workDate.getDay() === 0) continue;
      await prisma.attendanceRecord.upsert({
        where: { employeeId_workDate: { employeeId: employee.id, workDate } },
        create: {
          employeeId: employee.id,
          workDate,
          status: offset % 7 === 0 ? 'WORK_FROM_HOME' : 'PRESENT',
          checkInAt: new Date(workDate.getTime() + 9.5 * 3600_000),
          checkOutAt: new Date(workDate.getTime() + 19 * 3600_000),
          workedMinutes: 570,
        },
        update: {},
      });
    }
  }

  log(
    `demo accounts created - every staff login uses the password "Welcome@2026" and must change it on first sign-in`,
  );
}


/**
 * The seed writes human-readable codes (PRJ-0001, TSK-0007) directly, so the
 * shared counters must be advanced to match. Without this the first record
 * created through the app reuses a code and the unique index rejects it.
 *
 * Runs on every seed, and is safe to re-run: each counter is set to the highest
 * number actually in use.
 */
async function syncSequences() {
  log('sequence counters');

  const highest = (values: (string | null | undefined)[], prefix: string) =>
    values.reduce((max, value) => {
      if (!value?.startsWith(`${prefix}-`)) return max;
      const parsed = Number.parseInt(value.slice(prefix.length + 1), 10);
      return Number.isNaN(parsed) ? max : Math.max(max, parsed);
    }, 0);

  const [projects, tasks, retainers, employees] = await Promise.all([
    prisma.project.findMany({ select: { code: true } }),
    prisma.task.findMany({ select: { reference: true } }),
    prisma.retainer.findMany({ select: { code: true } }),
    prisma.employee.findMany({ select: { employeeCode: true } }),
  ]);

  const counters: { key: string; current: number }[] = [
    { key: 'project', current: highest(projects.map((r) => r.code), 'PRJ') },
    { key: 'task', current: highest(tasks.map((r) => r.reference), 'TSK') },
    { key: 'retainer', current: highest(retainers.map((r) => r.code), 'RET') },
    { key: 'employee', current: highest(employees.map((r) => r.employeeCode), 'DD') },
  ];

  for (const counter of counters) {
    const existing = await prisma.sequence.findUnique({ where: { key: counter.key } });
    // Never move a counter backwards - that would hand out a code already taken.
    const next = Math.max(counter.current, existing?.current ?? 0);
    await prisma.sequence.upsert({
      where: { key: counter.key },
      create: { key: counter.key, current: next },
      update: { current: next },
    });
  }
}

async function main() {
  console.log('\nSeeding Digital Dude CRM\n');
  await seedMasters();
  await seedWorkflows();
  await seedOrgSettings();
  await seedAdmin();
  if (WITH_DEMO) await seedDemo();
  await syncSequences();

  console.log('\nDone.');
  console.log(`  Admin: ${ADMIN_EMAIL}`);
  console.log(`  Password: ${ADMIN_PASSWORD} (must be changed on first sign-in)\n`);
}

main()
  .catch((error) => {
    console.error('\nSeed failed:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
