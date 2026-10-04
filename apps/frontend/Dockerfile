FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/sprites/package.json packages/sprites/
COPY apps/sim/package.json apps/sim/
COPY apps/api/package.json apps/api/
COPY apps/frontend/package.json apps/frontend/
COPY examples/starter-bot/package.json examples/starter-bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/rules packages/rules
COPY packages/shared packages/shared
COPY packages/sdk packages/sdk
COPY packages/sandbox packages/sandbox
COPY packages/sprites packages/sprites
COPY apps/frontend apps/frontend
# Library builds first (the client imports their dist). The frontend build then runs the static
# sandbox build (sandbox.html + sandbox/*.js, copied into public/) and bundles the client.
RUN pnpm exec tsc -b packages/rules packages/shared packages/sdk packages/sandbox packages/sprites \
 && pnpm --filter @daemonet/frontend build

FROM caddy:2-alpine AS runtime
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/frontend/dist /srv
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
