# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.11-alpine3.22

FROM ${NODE_IMAGE} AS base
ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch && rm -rf node_modules

FROM deps AS build
COPY package.json ./
COPY web/package.json web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter .
COPY apps apps
COPY libs libs
COPY scripts scripts
COPY tsconfig*.json nest-cli.json prisma.config.ts ./
RUN pnpm prisma generate \
    && pnpm nest build api \
    && pnpm nest build buyer \
    && pnpm nest build tracker

FROM deps AS prod-deps
COPY package.json ./
COPY web/package.json web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --prod --filter .
COPY scripts/prune-modules.mjs scripts/
RUN node scripts/prune-modules.mjs node_modules

FROM base AS node-binary
RUN apk add --no-cache binutils \
    && strip --strip-unneeded /usr/local/bin/node

FROM alpine:3.22.2 AS runtime
RUN apk add --no-cache libstdc++ tini \
    && addgroup -g 1000 -S node \
    && adduser -u 1000 -S -G node node
COPY --from=node-binary /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node libs/db/prisma libs/db/prisma
COPY --from=build --chown=node:node /app/dist dist
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/apps/api/apps/api/src/main.js"]
