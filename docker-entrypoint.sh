#!/bin/sh
# Applies pending migrations, then hands PID 1 to the server.
#
# `exec` matters: without it the shell stays PID 1 and swallows SIGTERM, so the
# graceful shutdown in src/server.ts would never run and a deploy would cut off
# in-flight requests.
#
# Migrating on boot is safe here because the API runs as a single instance (the
# scheduled jobs in src/jobs assume that too). If you ever scale past one,
# set RUN_MIGRATIONS=false and run `prisma migrate deploy` as a release step
# instead, so two booting containers cannot migrate at the same time.
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "==> applying database migrations"
  npx prisma migrate deploy
fi

echo "==> starting API"
exec node dist/server.js
