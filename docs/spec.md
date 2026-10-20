# testnet-payments: design spec

Date: 2026-10-20. Status: draft.

## Purpose

A demo of payment tracking. A bot buys silly items from a demo shop and pays in testnet USDC on Base Sepolia. Separate services detect each payment on chain, wait for confirmations, credit it exactly once, notify the shop, and stream every step to a one-page dashboard.

## Principles

- **Real data only.** Every number, note and incident the page shows comes from database rows written by the services. The front end animates real state; it never invents events.
- **Small scope.** One provider per payment method, one instance per service.
- **Configuration from the environment.** Keys and URLs come from environment variables, documented in `.env.example`, and are never committed or logged.
- **Plain wording on the page.** The dashboard says payment, confirming, settled, test network. It does not say wallet, token, coin or gas.

## Scope

- **Phase 1:** chain payments end to end, plus the dashboard.
- **Phase 2:** Stripe test mode as a second payment provider writing to the same ledger.
- **Out of scope:** deployment, more than one RPC provider, more than one chain at a time, user accounts.

## Stack

- pnpm workspace. Node 24 LTS, TypeScript strict.
- NestJS monorepo on the Fastify adapter: `apps/buyer`, `apps/tracker`, `apps/api`, shared code in `libs/`.
- `web/`: React + Vite, one page.
- Prisma with PostgreSQL. Redis for BullMQ, request rate limits and pub/sub.
- viem for chain access.
- Postgres and Redis are not started by this repository; their URLs come from the environment. A `docker-compose.yml` for local Postgres and Redis is acceptable as a convenience.

## Network and money

- Chain: Base Sepolia, set by config (`CHAIN_ID`, `RPC_URL`, `USDC_ADDRESS`), so Ethereum Sepolia can be swapped in.
- RPC: the free public endpoint by default. An optional key-based URL (for example a free Alchemy key) is just a different `RPC_URL`.
- Payments are transfers of Circle's testnet USDC (6 decimals). Verify the contract address against Circle's documentation before use.
- Two wallets: **buyer** and **shop**. Keys live only in `.env`. A script `pnpm wallets:new` generates both keys and writes them to `.env` with mode 0600. It prints only the public addresses.
- **Recycling:** a nightly job sweeps the shop's USDC back to the buyer, so USDC is claimed from a faucet once. Native gas on Base Sepolia costs almost nothing; one manual faucet claim should last months.
- **Low balance:** the API reports buyer and shop balances (gas and USDC). The page shows a warning below configured thresholds. No faucet automation.

## Orders and matching

- An order picks a random item from a small catalogue of silly items (for example "Gold rubber duck") with a price in USD.
- USDC transfers carry no reference, so orders are matched by **unique amount**: price plus an offset of 1 to 9,999 micro-units, unique among open orders. Example: $14.00 becomes 14.000731 USDC.
- A transfer to the shop that matches no open order is stored as an **unmatched payment** and logged as an incident. It is never credited to an order.
- An order not paid within a configured time expires.

## Pacing and test buys

- A daily budget caps purchases per UTC day by count and total amount. Each day's random target is at or below the cap.
- **Reservation:** a purchase reserves its count and amount in the `daily_budgets` row with one conditional update that fails when the cap would be exceeded. Scheduled and visitor purchases use the same reservation. Sent but unsettled purchases count against the budget. A reservation is released only when a send is known to have failed; a send with an unknown outcome keeps it.
- **Schedule:** each minute, the buyer decides whether to buy, with a probability of the remaining budget divided by the expected purchase size and the remaining active minutes. This gives quiet and busy minutes and spreads the target over the day. A UTC quiet window overnight lowers the probability. Remaining work is recomputed from the database each minute, so a restart resumes the day instead of starting over.
- **Visitor test buys:** `POST /test-purchases` takes one reservation from the same budget and queues the purchase. It is also limited per IP and has a global cooldown, both in Redis. When the budget is used up, the endpoint says so and nothing is sent. The response returns the order id so the page can highlight it.

## RPC budget and latency

The services run on free RPC tiers, so request volume is designed to stay inside their rate limits.

- **Adaptive polling:** the tracker polls every block (about 2s on Base Sepolia) while any order is open or any payment is unsettled or not final, and slows to a configured idle interval otherwise.
- **One call per pass for new payments:** a single `eth_getLogs` over the new range, filtered by contract and recipient. Confirmations come from the latest block number, not per-payment calls.
- **One request limiter per service** covers every RPC method it calls (head, logs, finality tag, balances), set below the provider's published rate. A rate-limit response starts a cooldown for that service instead of an immediate retry.
- **Bounded catch-up:** after a restart or outage the tracker scans at most a configured number of blocks per pass, so catching up never bursts past the limit.
- Head and finality tag are each fetched once per pass. Poll timing has a little jitter.
- **Fast path for test buys:** a visitor test buy is a high-priority job that runs immediately. The page shows the order as `sent` as soon as the buyer has the transaction hash, before the tracker sees it in a block. With 2s blocks, the payment should reach `received` within a few seconds of the click.

## Payment stages

Chain: `sent → received → confirming → settled → notified`, plus a `final` flag.

- **sent:** the buyer broadcast the transfer and stored its hash. This is the buyer's record, not yet seen by the tracker.
- **received:** the transfer log was seen in a block.
- **confirming:** waiting for `CONFIRMATIONS` blocks on top (default 10).
- **settled:** the confirmation count was reached. The ledger entry is written; this is the credit.
- **notified:** the shop accepted the signed notice.
- **final:** the chain's `finalized` block tag has passed the payment's block. Shown as a badge; on Base this comes some minutes after settled.

Stripe (phase 2): `received → processing → settled → notified`, without a confirmation count.

## Services

### buyer

- Runs the pacing schedule as a repeatable per-minute BullMQ job that queues purchase jobs with random offsets inside the minute.
- Each purchase job: reserve the budget, create the order with its unique amount, then send.
- **Sending is idempotent per order.** Nonces are allocated one at a time. The signed transaction and its hash are stored on the order before broadcast. A retry rebroadcasts the same signed transaction, or finds that it already landed, and never signs a second transfer for the same order.
- Nightly sweep as a repeatable job, using the same send path.
- A failed send is retried with backoff and recorded as an incident.

### tracker

- **Cursor:** the highest block up to which every block has been scanned, with that block's hash, in Postgres. It advances in the same database transaction that stores the range's payments, so a crash can never lose a payment.
- Each pass reads `Transfer` logs to the shop address with `eth_getLogs` over ranges no larger than a configured maximum. If the provider rejects a range as too large, the range is halved and retried, down to a configured minimum.
- **Gaps:** a range that still fails is stored as a gap with its error, attempt count and next retry time. The cursor moves past it only once the gap is stored. A BullMQ job retries gaps with bounded attempts, so one bad range cannot starve new work. Open gaps show on `/health`; a recovered gap writes an incident.
- **Overlap:** each pass re-reads the last `RESCAN_BLOCKS` blocks. A payment seen again is skipped and counted as a duplicate. If the cursor block's stored hash no longer matches the chain, the tracker steps back and rescans.
- **Credit once:** unique keys on (chain id, transaction hash, log index) for chain payments and on the payment id for ledger entries. The settle transition and the ledger insert happen in one database transaction, so a duplicate is a no-op.
- **Confirmations:** computed from the head fetched once per pass. Payments are settled when the threshold is reached. The `finalized` tag, also fetched once per pass, sets `final`.
- **Reorgs:** if the block hash stored for an unsettled payment no longer matches the chain, the payment is dropped back and an incident is written. Settled payments are rechecked until final; a mismatch there is recorded as an incident for manual review, not reversed automatically.
- **Failures:** rate limits, timeouts, connection resets and server errors are transient: bounded exponential backoff with jitter, then the gap path. Malformed requests are not retried. Each handled failure is an incident saying what happened and how it was handled. Logs never include RPC URLs, keys, signatures or raw transactions.
- On every stage change, publish an event on Redis pub/sub.
- On settle, queue a shop notice: a JSON body signed with HMAC-SHA256 and a timestamp, posted to the API. BullMQ retries it with exponential backoff. The notice is idempotent by payment id.

### api

| Route                   | Purpose                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /payments?limit=`  | Recent payments with order, stage, confirmations, block, explorer URL                                           |
| `GET /stats`            | Settled count, average time to settle, duplicates skipped, failures recovered. In-memory cache with a short TTL |
| `GET /incidents?limit=` | Recent incidents                                                                                                |
| `GET /health`           | Head, cursor, lag, open gaps, queue depth, cooldown state, balances and low-balance flags                       |
| `GET /events`           | Server-sent events relayed from Redis pub/sub                                                                   |
| `POST /test-purchases`  | Visitor test buy, as above                                                                                      |
| `POST /shop/notices`    | Receives the signed notice. Verifies the signature and timestamp, then marks the payment notified               |
| `POST /stripe/webhook`  | Phase 2                                                                                                         |

CORS is allowed only for the configured web origin.

### web

One React + Vite page with three parts:

- **Checkout:** a "Try a test purchase" card styled as a shop counter. On click, a till drawer slides up and a random catalogue item spins in. The visitor picks how to pay; phase 1 offers only **Test network**, and phase 2 adds **Test card**. A card terminal then shows the real stages: for the test network, _Sent_, then blocks stacking to the confirmation threshold; for a test card, a card marked TEST taps the terminal, then _Processing → Approved_. A receipt prints with a PAID stamp and drops into the feed, highlighted as the visitor's. The card asks for nothing (no inputs, addresses or QR codes) and is labelled "Test purchase · no real money · paid from the demo's own test account", with a "How this works" link to the repository. Every state it shows comes from the visitor's real order.

- **Small widget:** a dark card showing the latest payment as a receipt (item, price, order and block), a confirmation bar filling to the threshold, a PAID stamp when settled, a four-step strip and a footer of counts. It runs without interaction.
- **Full panel:** header with a live indicator, test network label, one-line caption; a four-lane pipeline; a receipts feed with notes (for example "Seen again on a rescan. Already credited, skipped."); stats tiles; an incident log titled "What went wrong today", pairing each problem with how it was handled.

Data comes from the REST routes on load and `/events` afterwards. Explorer links point to the configured block explorer.

## Data model

- `orders`: id, item, price, expected amount (micro-units), status (open, paid, expired), source (schedule, visitor), nonce, signed transaction, transaction hash, send attempts, created and expiry times.
- `daily_budgets`: UTC day, target count and amount, reserved count and amount.
- `scan_gaps`: block range, error category, attempts, next retry time, resolved time.
- `payments`: id, provider (chain, stripe), external key (unique per provider), order id (nullable for unmatched), amount, stage, confirmations, block number and hash, transaction hash, log index, final flag, stage timestamps.
- `ledger_entries`: id, payment id (unique), amount, created time.
- `incidents`: id, kind, what happened, how it was handled, related payment or block range, time.
- `cursors`: name, block number, block hash.
- `notices`: payment id (unique), attempts, delivered time.

Stats are computed from these tables, never stored as running totals.

## Phase 2: Stripe

- The buyer can pay an order with Stripe test mode: create a PaymentIntent with a test card and confirm it server-side.
- `POST /stripe/webhook` verifies the Stripe signature and credits once, keyed by PaymentIntent id. The event id guards against processing the same event twice.
- A repeatable reconciliation job lists recent Stripe events and processes any the webhook missed, recording an incident when it does.
- Locally, `stripe listen --forward-to` delivers webhooks.
- Scheduled purchases pick a payment method at creation by a configured split (for example 70% test network, 30% card). Both methods share the same daily budget reservation.
- `POST /test-purchases` takes the method the visitor chose. Limits and budget are the same for both.
- Stripe's test mode allows 25 requests per second per account; a `429` uses the same backoff as RPC rate limits.
- The pipeline and feed show the provider. Card payments skip the confirmation bar.

## Testing

- Unit tests: pacing and budget reservation (including concurrent reservations at the cap), unique-amount allocation and matching, idempotent send retries, credit-once under repeated logs, cursor and overlap logic, range halving and gaps, reorg handling, notice signature verification.
- Tracker logic runs against an RPC interface so tests can feed it scripted blocks and logs, including failures and reorgs.
- One manual smoke run against Base Sepolia, documented in the README.

## Acceptance

1. With funded wallets, the buyer sends paced purchases and the tracker settles each one exactly once, visible on the page within seconds of each stage change.
2. A visitor test buy appears in the feed, highlighted, and counts against the daily budget. The endpoint refuses once the budget is spent.
3. Rescans produce duplicates that are skipped and counted. Simulated failures in tests produce incidents with a handling note.
4. `pnpm test` and `pnpm lint` pass. `pnpm build` builds every app.
5. No keys or secrets are committed; `.env` is ignored.
6. The README explains what the project shows, how to run it locally, and the configuration.
