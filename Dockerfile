# syntax=docker/dockerfile:1
#
# Runs on any container host (Railway, Render, Fly, a VPS). Two stages so the
# TypeScript compiler and the test tooling never reach the running image.
#
# Pinned to Node 20 to match "engines" in package.json. openssl is installed
# explicitly because Prisma's query engine links against it.

# ----------------------------------------------------------------- build stage
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Dependencies are copied on their own so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --------------------------------------------------------------- runtime stage
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Regenerated here rather than copied: the client must match the @prisma/client
# that --omit=dev just installed.
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./

# Only needed for STORAGE_PROVIDER=local, which does not survive a redeploy.
# Production should use cloudinary; the directory exists so local runs work.
RUN chmod +x docker-entrypoint.sh \
  && mkdir -p /app/uploads \
  && chown -R node:node /app/uploads

USER node

EXPOSE 4000

# /health is unauthenticated and skips the request log, so polling it is cheap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
