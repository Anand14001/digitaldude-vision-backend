# Vision — API

REST API for Vision, the Digital Dude internal workspace. Node + Express +
TypeScript, Prisma,
Postgres.

The web client lives in a separate project (`../digital-dude-web`) and is
deployed separately. See [`docs/SPEC.md`](docs/SPEC.md) for what the system does
and how authorisation works.

## Requirements

- Node 20 or newer
- Docker, for local Postgres (or any Postgres you can reach)

## Setup

```bash
npm install
cp .env.example .env

# Generate real JWT secrets
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # access
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # refresh

npm run db:up          # Postgres in Docker on port 5433
npm run migrate:dev    # apply migrations
npm run db:seed        # roles, workflows, master data, admin, demo data
npm run dev            # http://localhost:4001
```

Sign in as the address in `SEED_ADMIN_EMAIL` with `SEED_ADMIN_PASSWORD`.

> Port 4001 rather than 4000 because 4000 was already in use on the original
> development machine. Change `PORT` in `.env` and `VITE_API_URL` in the web
> project together.

### Demo data

`SEED_DEMO_DATA=true` (the default) adds sample clients, staff, projects, a
monthly retainer, time entries and attendance, so every screen has something to
show. Every demo staff login uses `Welcome@2026` and is forced to change it.

Set it to `false` for any real database.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development server with reload |
| `npm run build` / `start` | Compile to `dist/` and run it |
| `npm run typecheck` | Types only, no output |
| `npm run db:up` / `db:down` | Local Postgres in Docker |
| `npm run migrate:dev` | Create and apply a migration |
| `npm run migrate:deploy` | Apply pending migrations (production) |
| `npm run db:seed` | Seed or re-seed; safe to re-run |
| `npm run db:studio` | Prisma Studio |
| `npm run db:reset` | Drop, re-migrate, re-seed |
| `npm run admin:password` | Set the admin password from `.env` |
| `npm run emit:contract` | Write `contract/contract.ts` for the web client |
| `npm run test:api` | Run both live test suites — see [`tests/`](tests/README.md) |

## Project layout

```
src/
├── config/env.ts          Zod-validated environment; refuses to boot if wrong
├── permissions/registry.ts  The 85 permission keys — source of truth
├── lib/
│   ├── scope.ts           Who can see which rows, in one place
│   ├── audit.ts           Field-level diffs into the audit trail
│   ├── workflowRuntime.ts Stage seeding, default statuses, health
│   ├── tokens.ts          Access tokens and rotating refresh cookies
│   ├── crudFactory.ts     Shared CRUD for flat master tables
│   └── …                  storage, mailer, notify, dates, pagination
├── middleware/            auth, requirePermission, validate, errors, rate limits
├── modules/<name>/        One folder per module: routes, schema, service
├── jobs/                  Hourly tick with a daily guard
├── routes/index.ts        Mounts everything; one staff guard for the whole API
└── server.ts              Boot, health checks, graceful shutdown
```

Each module owns its routes and its Zod schemas. Anything shared between modules
belongs in `lib/`.

## Conventions

- **Validation at the edge.** Every route declares Zod schemas; handlers only
  ever see parsed, coerced data.
- **One place for scoping.** List queries build their where-clause through
  `lib/scope.ts`, so visibility rules cannot drift between handlers.
- **Audit in the service layer.** Mutations write an audit row with a
  before/after diff. Sensitive fields are stripped from diffs.
- **Honest status codes.** Prisma errors map to real HTTP statuses; a record the
  caller may not see returns 404, not 403.
- **Fail fast on config.** A missing or weak secret stops the process rather
  than half-starting.

## API surface

Everything is under `/api`. `GET /health` and `GET /health/ready` (which checks
the database) sit outside it for load balancers.

```
/api/auth          sign in, refresh, invites, password reset, preferences
/api/portal        client-portal surface (CLIENT accounts only)
/api/dashboard     role-aware home payload and sidebar badges
/api/clients       accounts, contacts, portal access
/api/leads         pipeline, interactions, convert
/api/projects      projects, stages, members, milestones
/api/retainers     retainers and cycles
/api/tasks         tasks, boards, checklists, dependencies, watchers
/api/workflows     the workflow builder
/api/deliverables  versions, internal approval, client approval, publish
/api/employees     profiles, skills, documents, compensation, assets, offboarding
/api/time          time entries and weekly timesheets
/api/attendance    check in/out, corrections, month grid
/api/leave         balances, requests, decisions
/api/performance   review cycles, reviews, goals
/api/calendar      unified feed and events
/api/reports       six reports plus CSV export
/api/logs          the audit trail (read-only)
/api/roles         roles and the permission catalogue
/api/users         accounts, roles, status, invites
/api/masters       departments, designations, skills, service lines, project
                   types, leave types, holidays, work schedules, assets
/api/settings      org profile, feature toggles, checklist templates
/api/comments      threaded comments on any supported record
/api/files         uploads and attachments
/api/notifications the signed-in user's own notifications
```

## Deployment

Any Node host works — Railway, Render, Fly, or a VPS with a process manager.

1. Set the environment from [`.env.production.example`](.env.production.example).
   Generate fresh JWT secrets; never reuse development ones.
2. `npm ci && npm run build`
3. `npm run migrate:deploy`
4. Seed once with `SEED_DEMO_DATA=false`, then clear `SEED_ADMIN_PASSWORD`.
5. `npm start`

Points to get right:

- **`WEB_ORIGINS`** must list the exact origin the SPA is served from. CORS is
  an allowlist and credentials are enabled, so a wrong value breaks sign-in.
- **`COOKIE_DOMAIN`** must be the shared parent domain when the API and the SPA
  are on different subdomains, or the refresh cookie will not be sent.
- **`trust proxy`** is already set, so rate limiting and audit IPs see the real
  client address behind a load balancer.
- **Uploads**: `STORAGE_PROVIDER=local` writes to disk, which does not survive a
  container redeploy. Use `cloudinary` in production.
- **Email**: without SMTP configured, emails are logged rather than sent — fine
  for development, not for inviting real people.
- **Background jobs** run in-process. With more than one instance, run them on a
  single worker instead (`tsx src/jobs/index.ts` runs one pass by hand).

### Hosted Postgres

With Prisma Postgres or any pooled provider, run migrations from a machine that
can reach it:

```bash
DATABASE_URL="<pooled connection string>" npx prisma migrate deploy
DATABASE_URL="<pooled connection string>" SEED_DEMO_DATA=false npx tsx prisma/seed.ts
```

## Sharing the contract with the web client

```bash
npm run emit:contract                    # here
cd ../digital-dude-web && npm run sync:contract
```

This copies every enum and permission key into the web project's
`src/types/contract.ts`. Run it after changing an enum or the permission
registry — the UI will then fail to compile until it agrees with the API.
