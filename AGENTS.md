# payment-pipeline-demo: agent rules

A pnpm workspace: three NestJS apps (`apps/api`, `apps/buyer`, `apps/tracker`) over shared libraries in `libs/`, a React and Vite dashboard in `web/`, Prisma on PostgreSQL, BullMQ on Redis, viem on Base Sepolia and Stripe in test mode. The README is the full reference; `docs/spec.md` is the design.

## Checks

Run before calling work done:

- `pnpm lint`: ESLint (type-checked), `tsc` for the apps, the build config and `web/`, and `prettier --check`.
- `pnpm test:local`: starts the local Postgres and Redis from `docker-compose.yml`, applies the migrations and runs the backend and `web/` tests against them. Each test file gets its own schema. Run tests this way rather than with plain `pnpm test`, so they never reach a database named in `.env`.
- `pnpm build` when a change touches the build, the Dockerfile or `deploy/`.

## Code

- Import shared code through the path aliases in `tsconfig.json`: `@app/<lib>` for `libs/<lib>/src` and `@testing/<lib>/*` for its test helpers, never with `../` paths across libraries.
- A schema change is a new migration under `libs/db/prisma/migrations/` (`pnpm db:migrate --name <name>`); never edit one that is already applied.
- `libs/events/src/public-payment.ts` copies each public payment field by name, so a new column stays private until it is added there.
- A new incident kind goes in `libs/core/src/incidents.ts`.
- A changed setting or default is changed in `libs/config/src/index.ts`, the README's Configuration table, `.env.example` and, where the design states it, `docs/spec.md`.
- The services run on free tiers; README "RPC and Stripe budgets" sets each service's request rate. A new RPC or Stripe call in a hot path needs room in that budget.

## Safety

- Test money only. Configuration accepts only `sk_test_` Stripe keys; never weaken that check.
- `.env` and `deploy/.env` hold keys and are ignored by git. Never commit, print or paste them, and read only the setting a task needs.
- New wallets come from `pnpm wallets:new`; a deploy uses its own wallets and its own Stripe sandbox, never the development ones.

## Text

Tracked text (code, comments, docs and commit messages) describes this project only. It names no other project, personal host, address or local path. The README's live-demo links are the exception.
