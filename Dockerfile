# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.11-alpine3.22@sha256:2867d550cf9d8bb50059a0fff528741f11a84d985c732e60e19e8e75c7239c43

FROM ${NODE_IMAGE} AS base
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch && rm -rf node_modules

FROM deps AS build
COPY package.json ./
COPY web/package.json web/
COPY tools/migrate/package.json tools/migrate/
RUN --network=none \
    pnpm install --offline --frozen-lockfile --filter .
COPY apps apps
COPY libs libs
COPY scripts scripts
COPY tsconfig*.json nest-cli.json prisma.config.ts ./
RUN pnpm prisma generate \
    && pnpm nest build api \
    && pnpm nest build buyer \
    && pnpm nest build tracker \
    && pnpm tsc -p tsconfig.scripts.json

FROM deps AS prod-deps
COPY package.json ./
COPY web/package.json web/
COPY tools/migrate/package.json tools/migrate/
RUN --network=none \
    pnpm install --offline --frozen-lockfile --prod --no-optional --filter .
# The generated client imports only the PostgreSQL query compiler, so the
# other databases' copies are dead weight. Declarations, maps and docs are
# never read at run time.
RUN find node_modules/.pnpm \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
        -o -name '*.map' -o -name '*.md' \) -type f -delete \
    && find node_modules/.pnpm -path '*/@prisma/client/runtime/*' -type f \
        -regex '.*\(mysql\|sqlite\|sqlserver\|cockroachdb\|mongodb\).*' -delete

FROM deps AS migrate-deps
COPY package.json ./
COPY web/package.json web/
COPY tools/migrate/package.json tools/migrate/
RUN --network=none \
    pnpm --filter migrate --prod --offline deploy /migrate

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist dist
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/apps/api/apps/api/src/main.js"]

FROM runtime AS migrate
WORKDIR /migrate
COPY --from=migrate-deps --chown=node:node /migrate/node_modules node_modules
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node libs/db/prisma libs/db/prisma
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
