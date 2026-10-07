# API tests

All three scripts run against a **live API** (`npm run dev` in another terminal)
and sign in as the seeded administrator, so they exercise the real stack:
Express, Prisma, Postgres, the permission layer and the audit trail.

```bash
npm run test:smoke       # every endpoint the web client calls
npm run test:portal      # client-portal scoping, end to end
npm run test:kind        # internal vs client projects
npm run test:roles       # custom project roles and the single lead
npm run test:edits       # the admin editing paths
npm run test:calendar    # the calendar feed
npm run test:api         # all three
npm run db:clean-tests   # remove everything the suites created
```

## `smoke.mjs`

Signs in and calls all 71 endpoints the UI depends on, reporting the status of
each. Catches a broken route, a bad Prisma include or a schema drift without
needing a browser.

## `portal-scoping.mjs`

The one that protects the thing most likely to cause real harm: a client seeing
another client's work, or a portal account reaching a staff surface.

It creates a throwaway client, project and deliverable, grants a contact
**view-only** portal access, accepts the invite the way the emailed link would,
and then asserts that the portal account:

- is refused on all 11 staff routes it tries,
- holds zero staff permissions,
- sees exactly its own client and its own project,
- gets a 404 (not a 403) for another client's project, so the API does not even
  confirm the record exists,
- cannot approve a deliverable, because approving is a separate right from
  viewing,
- can still message its own project team,
- and loses access immediately when portal access is revoked.

## `project-kind.mjs`

Asserts that the two project kinds stay coherent: client work must name a
client, internal work must not, converting between them clears or demands a
client, and an internal project never appears in a client portal — not in the
overview, and not by requesting its id directly.

## `project-roles.mjs`

Covers the custom project roles: several per person, exactly one lead, unknown
or retired roles refused, a role in use refused for deletion, and removals
actually taking effect. It also asserts the thing that matters most about them:
assigning a role changes nothing about what the person is allowed to do.

## `admin-edits.mjs`

The editing an administrator does day to day: an employee's record, a client's
details, and a client contact. Each change is written, read back and checked
against the audit trail, including that the diff recorded what the field was
before. It also covers the rules: a reporting loop is refused, making a second
contact primary demotes the first, and editing a contact leaves their portal
access alone.

It creates its own throwaway employee, client and contact and removes them
afterwards, so running it never rewrites a real record.

## `calendar.mjs`

Creates an event, then asks the feed for it using the **exact parameters the web
client sends**. That matters: the filter once checked plural source names while
the client sent the singular, so naming your sources silently emptied the whole
calendar and no test that called the endpoint its own way would have noticed.

It also covers an all-day event, that narrowing to one source does not empty the
feed, that the plural spelling still works, that an unknown source is an error
rather than an empty calendar, and that a cancelled event leaves the feed.

## `comments.mjs`

Posts a comment with an @mention the way the discussion box does, then checks
the mention is stored and the person named is notified. The important check is
on the picker's own data: `/employees/options/all` once returned people without
their user id, so the client sent a list of nulls and every mention was
refused. The hand-written client type claimed the id was there, so nothing
caught it until someone tried to tag a colleague.

Also covers that a null mention is a clear 400, that internal is the default,
that a client-visible comment is a deliberate choice, and that a deleted comment
leaves the thread.

## `task-access.mjs`

Runs as Meena (HR & Accounts), a staff account whose role grants nothing to do
with delivery, and checks what she can actually do with a task someone assigned
her.

The staff baseline used to include `tasks.update.assigned`, so she got full
edit rights over any task pointed at her - an Edit button on work she only
needed to progress. The baseline now grants `tasks.status.assigned`: she can
set the status, drag her own card and tick checklist steps off, while renaming,
rescheduling, reassigning and deleting all come back 403. A status change
smuggled in alongside an edit is still an edit.

It also pins down two things that were wrong alongside it: the activity log and
its CSV export are the Administrator's alone (the export used to accept
`reports.export`, which half the roles hold), and a task carries the statuses
it may take, so the dropdown works for an assignee who cannot read the project
the task belongs to.

## Notes

- They write real rows, named with a `SMOKE `, `PORTAL ` or `KIND ` prefix.
  Run `npm run db:clean-tests` afterwards to remove exactly those records —
  it leaves audit log entries alone, since the trail is append-only.
- Prefer running them against the local Docker database. If you do point them at
  a database with real data in it, clean up straight after.
- `prisma/print-invite-token.ts` reads a pending invite token from the database,
  which is how the portal test accepts an invite without a mailbox.
- Credentials come from `.env` (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`); the
  scripts assume the seeded admin password and `http://localhost:4001`.
