# Production image for apps/web (Next.js standalone). Build from the repo root:
#   docker build -f apps/web/Dockerfile -t bukalaris-web .
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages/db packages/db
RUN pnpm --filter @bukalaris/web build

# Migration job: only packages/db with its production deps (drizzle-orm, postgres, zod).
FROM base AS migrate-build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/db packages/db
RUN pnpm --filter @bukalaris/db deploy --prod --legacy /out && rm -rf /out/docker

# One-off migration job (Coolify pre-deployment step / manual run):
#   docker build -f apps/web/Dockerfile --target migrate -t bukalaris-migrate .
#   docker run --rm -e DATABASE_URL=... bukalaris-migrate
FROM node:24-alpine AS migrate
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=migrate-build --chown=app:app /out ./
USER app
CMD ["node", "src/migrate.ts"]

FROM node:24-alpine AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
