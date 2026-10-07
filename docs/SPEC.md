Written for: whoever picks up this codebase next — a developer joining Digital Dude, or you in six months.

# Digital Dude CRM — specification

Internal CRM for Digital Dude, a digital marketing and development agency in
Poonamallee, Chennai. It covers the whole operating cycle: an enquiry arrives,
becomes a client, work is planned and delivered through a configurable pipeline,
time and people are tracked against it, and the client follows progress in their
own portal.

## Shape of the system

Two independent projects, with no shared build:

| | |
|---|---|
| `digital-dude-api` | Node + Express + TypeScript, Prisma, Postgres |
| `digital-dude-web` | React + Vite + TypeScript, Tailwind |

They are separate on purpose, so either can be deployed, scaled or replaced
alone, and so a future mobile app can use the same API. The contract they share
is generated, not imported: the API emits every enum and permission key to
`contract/contract.ts`, and the web project copies it in. Rename a permission in
the API and the UI stops compiling until it is updated.

## The two decisions that shape everything else

**Clients are the spine.** Projects, retainers, deliverables and portal logins
all hang off a client account. Reports about revenue or retainer health are
meaningless without it.

**Not all work is a project.** A website build has a start and an end. Monthly
social media management does not — it is the same client, the same deliverable
set, every month, indefinitely. Modelling that as a project would mean either
twelve projects a year per client or losing history. So the system has both:

- **Projects** — one-off, dated work. Web builds, campaigns, brand identities.
- **Retainers** — recurring engagements that spawn a **cycle** per billing
  period. Each cycle has its own task board and deliverables, so October's work
  is separable from November's while the agreement stays one record.

## Modules

| # | Module | What it holds |
|---|---|---|
| 1 | Clients | Accounts, multiple contacts each, industry, service lines bought, account manager, files, notes |
| 2 | Leads | Pre-sale pipeline with source (referral, Instagram, walk-in…), interaction timeline, convert-to-client |
| 3 | Projects | Client-linked, typed, running on a workflow; team, budget, milestones, stage history |
| 4 | Retainers | Recurring agreements with a billing cycle, auto-opening periods, per-cycle boards |
| 5 | Tasks | Assignee, status from the workflow, priority, estimate, subtasks, dependencies, checklist, watchers, files |
| 6 | Workflows | Admin-built: ordered stages, the task status set, and a checklist of default tasks per stage |
| 7 | Deliverables | Versioned creative, internal review, then client approval |
| 8 | Employees | Profiles, reporting line, capacity, skills, documents, compensation, assets, onboarding/offboarding |
| 9 | Timesheets | Hours against tasks, weekly submit and approve, feeding utilisation |
| 10 | Attendance | Check in/out, lateness, month grid, holidays and work schedule |
| 11 | Leave | Types with quotas, balances, requests with approval, attendance filled in on approval |
| 12 | Performance | Review cycles, self and manager assessment, goals |
| 13 | Calendar | One feed of task deadlines, milestones, events, shoots, leave, holidays, cycle ends |
| 14 | Reports | Delivery, stage cycle time, utilisation, time by client, lead conversion, retainer health; CSV export |
| 15 | Activity log | Append-only audit trail with field-level diffs |
| 16 | Notifications | In-app bell plus email on assignment, approval, leave and renewal |
| 17 | Settings | Org profile, roles and permissions, users, the workflow builder, master data |
| 18 | Client portal | A separate app surface: their projects, approvals, files, contacts |

## Authorisation

This is the part worth understanding before changing anything.

### Two kinds of user, one table

`User.kind` is `STAFF` or `CLIENT`. They share authentication but nothing else.
Custom roles apply **only** to staff. A client-portal account is given an empty
permission set and is scoped by the client account it belongs to — so no amount
of misconfiguration in Settings can expose client-side data, because the portal
authorises on ownership, never on a permission key.

### Permissions

84 keys in 16 groups, defined in `src/permissions/registry.ts`. The registry is
the source of truth: a role row stores a subset of keys, and anything the
registry no longer recognises is ignored. Keys read `<module>.<action>` with an
optional scope:

```
projects.view.all        every project in the agency
projects.view.assigned   only projects they manage or are a member of
```

Broader scopes imply narrower ones, so granting `projects.view.all` does not
also require ticking `.assigned`.

Roles are fully custom. The `Administrator` role carries `isAdmin`, which
implicitly holds every permission and cannot be edited — that is what stops the
organisation locking itself out of Settings.

Per-user overrides exist in both directions on top of a role, and an explicit
revoke always wins.

### Where it is enforced

- **Routes** declare what they need: `requirePermission('projects.update')`. A
  route listing several keys means "any of these", which is how scoped reads
  work.
- **Queries** are narrowed in `src/lib/scope.ts`. Every list builds its
  where-clause there, so "who can see this row" is decided in one file rather
  than in each handler. A `.all` permission returns an unrestricted filter, a
  `.assigned`/`.team`/`.own` one returns a narrowed filter, and no relevant
  permission throws.
- **Sensitive fields** are stripped per caller: personal details need
  `employees.pii.view`, salary needs `employees.compensation.view`, budgets need
  `projects.budget.view`.
- **The frontend only hides UI.** It is a convenience, never a boundary.

A record the caller may not see returns 404 rather than 403, so the API does not
confirm that it exists.

### Sessions

Short-lived JWT access token held in memory by the SPA, plus a rotating
refresh token in an httpOnly cookie. A replayed refresh token is treated as a
leak and every session for that user is revoked. Changing a password, suspending
an account or offboarding an employee ends sessions immediately.

## Workflows

Workflows are the backbone. A workflow belongs to a project type and defines:

- **Stages**, ordered, coloured, each optionally marked terminal (reaching it
  completes the project) or client-facing (work is waiting on the client).
- **Task statuses**, each mapped to a category (`TODO`, `IN_PROGRESS`,
  `BLOCKED`, `REVIEW`, `DONE`, `CANCELLED`). Exactly one is the default new
  tasks land in, and at least one must be `DONE`.
- **Default tasks per stage** — the agency's checklist, created automatically
  when a project enters that stage, with due dates offset from the entry date.

Movement between stages is **free**: there are no transition rules to satisfy.
That was a deliberate choice — ship the stages, learn from real usage, add rules
later if they are genuinely needed. Entering a stage seeds its checklist
(skipping titles that already exist, so moving back and forth does not
duplicate), closes the previous stage's history row, and notifies the team.

The seed ships a workflow per service line: website development, social media,
video production, performance marketing, branding, influencer campaigns.

## Things worth knowing

- **Codes** (`PRJ-0042`, `TSK-0117`, `RET-0003`, `DD-0005`) come from an atomic
  counter in the `Sequence` table, allocated inside the creating transaction so
  a failed create does not burn a number. The seed syncs those counters to the
  highest code it wrote — without that, the first record created through the UI
  would collide.
- **Soft deletes** on clients, projects, tasks, leads and retainers, because
  logged time, invoices and the audit trail must keep their references.
- **The audit trail is append-only.** No endpoint edits or deletes a row, so it
  cannot be rewritten from inside the product. Compensation changes are recorded
  as having happened without the amount, so someone with `logs.view` but not
  `employees.compensation.view` learns nothing.
- **Background work** runs on an hourly tick with a daily guard recorded in
  settings, so a restart does not re-run the day's jobs: due-date reminders,
  project health, opening retainer cycles, renewal reminders, document expiry,
  and marking yesterday's unrecorded working days absent.
- **Health is derived**, not typed in: a project is at risk or off track based
  on its own dates and its overdue task count.
- **Notifications and emails never fail a request.** They are best-effort and
  log their own failures.

## Build order as delivered

| Phase | Shipped |
|---|---|
| 0 | Schema, auth, permission registry, roles, theming, audit log, app shell |
| 1 | Clients, employees, projects, workflows, tasks, role dashboards, calendar |
| 2 | Retainers and cycles, deliverables and approvals, files, notifications, timesheets |
| 3 | Client portal and client approvals |
| 4 | Attendance, leave, performance, assets, documents |
| 5 | Reports, exports, workload |

People operations came late on purpose — attendance and KPIs are the features
most likely to sit unused before the core is in daily use — but they were in the
schema from the start, so nothing needed reworking.

## Deliberately not built

- **Invoicing and payments.** The data to support it is there (retainer amounts,
  project budgets, billable hours) but billing was out of scope.
- **Workflow transition rules.** See above.
- **WhatsApp notifications.** They fit how the agency communicates, but the
  Business API and template approval are real setup overhead; email and in-app
  came first.
- **Full request/response codegen.** Enums and permission keys are generated;
  response shapes are declared by hand in the web project, so an additive API
  change never breaks the build.
