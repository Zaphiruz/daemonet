FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/rules/package.json packages/rules/
COPY packages/bus/package.json packages/bus/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/sdk/package.json packages/sdk/
COPY apps/sim/package.json apps/sim/
COPY apps/api/package.json apps/api/
COPY examples/starter-bot/package.json examples/starter-bot/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/rules packages/rules
COPY packages/bus packages/bus
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @daemonet/db generate && pnpm exec tsc -b apps/api

FROM node:24-alpine AS runtime
RUN apk add --no-cache openssl tzdata
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./
COPY --from=build --chown=node:node /repo/packages/rules/package.json packages/rules/
COPY --from=build --chown=node:node /repo/packages/rules/dist packages/rules/dist
COPY --from=build --chown=node:node /repo/packages/rules/node_modules packages/rules/node_modules
COPY --from=build --chown=node:node /repo/packages/bus/package.json packages/bus/
COPY --from=build --chown=node:node /repo/packages/bus/dist packages/bus/dist
COPY --from=build --chown=node:node /repo/packages/bus/node_modules packages/bus/node_modules
COPY --from=build --chown=node:node /repo/packages/db/package.json packages/db/
COPY --from=build --chown=node:node /repo/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /repo/packages/db/node_modules packages/db/node_modules
COPY --from=build --chown=node:node /repo/apps/api/package.json apps/api/
COPY --from=build --chown=node:node /repo/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/node_modules apps/api/node_modules
COPY --chown=node:node apps/api/entrypoint.mjs apps/api/env-filter.mjs apps/api/
USER node
EXPOSE 3000
# /api/ready probes PostgreSQL and is what the deploy workflow checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/entrypoint.mjs"]
