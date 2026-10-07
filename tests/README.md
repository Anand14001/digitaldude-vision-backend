# API tests

All three scripts run against a **live API** (`npm run dev` in another terminal)
and sign in as the seeded administrator, so they exercise the real stack:
Express, Prisma, Postgres, the permission layer and the audit trail.

```bash
npm run test:smoke       # every endpoint the web client calls
npm run test:portal      # client-portal scoping, end to end
npm run test:kind        # internal vs client projects
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
