# testnet-payments: design spec

Date: 2026-10-20, revised 2026-10-23. Status: current.

## Purpose

A demo of payment tracking. A bot buys silly items from a demo shop and pays in testnet USDC on Base Sepolia. Separate services detect each payment on chain, wait for confirmations, credit it exactly once, notify the shop, and stream every step to a one-page dashboard.

## Principles

- **Real data only.** Every number and note the page shows comes from database rows written by the services. The front end animates real state; it never invents events.
- **Small scope.** One provider per payment method, one instance per service.
- **Configuration from the environment.** Keys and URLs come from environment variables, documented in `.env.example`, and are never committed or logged.
- **Plain wording on the page.** The dashboard says payment, confirming, settled, test network. It does not say wallet, token, coin or gas.

## Scope

- **Phase 1:** chain payments end to end, plus the dashboard.
- **Phase 2:** Stripe test mode as a second payment provider writing to the same ledger.
- **Out of scope:** deployment scripts, more than one RPC provider, more than one chain at a time, user accounts. The services can run behind a reverse proxy (`TRUST_PROXY`).

## Stack

- pnpm workspace. Node 24 LTS, TypeScript strict.
- NestJS monorepo: `apps/buyer`, `apps/tracker`, `apps/api`, shared code in `libs/`. The API runs on the Express adapter with controllers, DTOs validated by `class-validator`, `@nestjs/throttler` for the request limit and `@nestjs/config` for settings. Buyer and tracker are application contexts whose jobs are `@nestjs/bullmq` processors. Each app is split into feature modules (a module, its controller or processor, its service and DTOs).
- `web/`: React + Vite, one page.
- Prisma with PostgreSQL. Redis for BullMQ, request rate limits and pub/sub.
- viem for chain access.
- Postgres and Redis are not started by this repository; their URLs come from the environment. A `docker-compose.yml` for local Postgres and Redis is acceptable as a convenience.

## Network and money

- Chain: Base Sepolia, set by config (`CHAIN_ID`, `RPC_URL`, `USDC_ADDRESS`), so Ethereum Sepolia can be swapped in.
- RPC: the free public endpoint by default. An optional key-based URL (for example a free Alchemy key) is just a different `RPC_URL`.
- Payments are transfers of Circle's testnet USDC (6 decimals). Verify the contract address against Circle's documentation before use.
- Two wallets: **buyer** and **shop**. Keys live only in `.env`. A script `pnpm wallets:new` generates both keys and writes them to `.env` with mode 0600. It prints only the public addresses.
- **Recycling:** a nightly job sweeps the shop's USDC back to the buyer. A **refill** does the same on demand: when the buyer's USDC falls below `REFILL_BELOW` and the shop holds USDC and enough gas, the shop sends its whole USDC balance to the buyer, at most once per `REFILL_COOLDOWN_SECONDS` (default 20). USDC only circulates between the two wallets; the running cost is gas, a fraction of a cent per purchase.
- **Gas floor:** visitor test buys pause while the buyer's gas balance is below `GAS_FLOOR` (default 0.0002 ETH) and resume when it is topped up. The page says the demo account is being topped up, in its plain wording.
- **Low balance:** the API reports buyer and shop balances (gas and USDC). `/health` flags each balance below its configured threshold for monitoring; the page shows no balance warnings. No faucet automation.

## Orders and matching

- An order picks a random item from a small catalogue of silly items (for example "Gold rubber duck") priced between $0.10 and $2.00.
- USDC transfers carry no reference, so orders are matched by **unique amount**: price plus an offset of 1 to 9,999 micro-units, unique among orders of the last 24 hours. Example: $1.40 becomes 1.400731 USDC. The offsets bound orders to 9,999 a day; the visitor daily limit keeps well below it.
- Only transfers whose sender is `BUYER_ADDRESS` (compared case-insensitively) are matched to orders. A buyer transfer that matches no open order is stored with no order and logged as an incident; it is never credited to an order.
- Any other USDC transfer to the shop is a **donation**. It is stored with its sender (`from_address`, `donation`), settles with a ledger entry like any payment, and has no order, no shop notice and no `unmatched` incident (a reorg or duplicate still records its own incident). USDC is the only asset tracked. The API derives a stable two-word name from the sender and never returns the address. Donations below `DONATION_MIN` (default 10,000 micro-units, 0.01 USDC) stay stored but are left out of `/payments`, the event stream, `/stats` and `/stats/daily`.
- An order not paid within a configured time expires.

## Pacing and test buys

Two kinds of purchase share one send path but not their limits: **scheduled** purchases make the shop look busy through the day, and **visitor test buys** let a visitor watch a payment settle in seconds.

- **Daily budget (scheduled only):** caps scheduled purchases per UTC day by count and total amount (`DAILY_COUNT_CAP`, default 100; `DAILY_AMOUNT_CAP`, default 200 USDC, so the count is what binds). Each day's target is drawn between half and all of each cap from the date and a seed, so days differ and a restart keeps the same target.
- **Reservation:** a scheduled purchase reserves its count and amount in the `daily_budgets` row with one conditional update that fails when the cap would be exceeded. Sent but unsettled purchases count against the budget. A reservation is released only when a send is known to have failed; a send with an unknown outcome keeps it.
- **Schedule:** each minute, the buyer decides whether to buy, with a probability of the remaining budget divided by the expected purchase size and the remaining active minutes. This gives quiet and busy minutes and spreads the target over the day. A UTC quiet window overnight lowers the probability. Remaining work is recomputed from the database each minute, so a restart resumes the day instead of starting over.
- **Visitor test buys:** `POST /test-purchases` creates an order and queues it at the highest priority. It takes no daily budget, so a visitor never waits behind the schedule. Its limits, each a configuration value, protect gas, the RPC budget and the matching offsets:

| Limit                         | Default                    | Response                         |
| ----------------------------- | -------------------------- | -------------------------------- |
| Per visitor (IP, hashed)      | 10 a minute, 100 a UTC day | `429` with `Retry-After`         |
| Waiting visitor purchases     | 30                         | `429` "busy", with `Retry-After` |
| Visitor purchases per UTC day | 2,000                      | `409` until 00:00 UTC            |
| Buyer gas below `GAS_FLOOR`   | —                          | `503` until topped up            |

The response returns the order id and its queue position, so the page can highlight the order and show "queued" until it is sent.

## RPC budget and latency

The services run on free RPC tiers, so request volume is designed to stay inside their rate limits.

- **Split budget:** each service has its own limiter (`RPC_REQUESTS_PER_SECOND_TRACKER`, `_BUYER`, `_API`; defaults 2, 2 and 1), and together they stay at or below the provider's rate. A limiter delays a call until its slot rather than refusing it. The tracker's share is its own, so a burst of purchases cannot stall confirmations.
- **Adaptive polling:** the tracker polls every pass interval while any order is open or any payment is unsettled or not final, and slows to a configured idle interval otherwise.
- **One call per pass for new payments:** a single `eth_getLogs` over the new range, filtered by contract and recipient. Confirmations come from the latest block number, not per-payment calls.
- **About one call per send:** the buyer signs locally with a nonce allocated in the database, a fixed gas limit for a USDC transfer and a fee cached for a few seconds, then broadcasts. It checks for a receipt only when retrying. At most `MAX_IN_FLIGHT` (default 10) of a wallet's transfers wait unconfirmed at once; a send beyond that returns to its queue for a moment without counting as a failed attempt.
- A rate-limit response starts a cooldown for that service instead of an immediate retry.
- **Bounded catch-up:** after a restart or outage the tracker scans at most a configured number of blocks per pass, so catching up never bursts past the limit.
- Head and finality tag are each fetched once per pass. Poll timing has a little jitter.
- **Fast path for test buys:** the page shows the order as `sent` as soon as the buyer has the transaction hash, before the tracker sees it in a block. With sub-second blocks on Base Sepolia, a payment settles within seconds of the click.

## Payment stages

Chain: `sent → received → confirming → settled → notified`, plus a `final` flag.

- **sent:** the buyer broadcast the transfer and stored its hash. This is the buyer's record, not yet seen by the tracker.
- **received:** the transfer log was seen in a block.
- **confirming:** waiting for `CONFIRMATIONS` blocks on top (default 10). Counting stops at the threshold: after settlement only finality is recorded.
- **settled:** the confirmation count was reached. The ledger entry is written; this is the credit.
- **notified:** the shop accepted the signed notice.
- **final:** the chain's `finalized` block tag has passed the payment's block. Shown as a badge; on Base this comes some minutes after settled.

Stripe (phase 2): `received → processing → settled → notified`, without a confirmation count.

## Services

### buyer

- Runs the pacing schedule as a repeatable per-minute BullMQ job that queues purchase jobs with random offsets inside the minute.
- Each purchase job: reserve the budget, create the order with its unique amount, then send.
- **Hold before a send:** before an order is sent, the buyer checks that its cached USDC balance (refreshed every few seconds), less the amounts still in flight, covers the order. If not, the job is delayed 2 seconds without using an attempt, so the order can still expire and close.
- **Upkeep queue:** `check-unseen` and `refill-check` run on their own `buyer-upkeep` queue and worker, so held sends never delay them.
- **Sending is idempotent per order.** Nonces are allocated one at a time. The signed transaction and its hash are stored on the order before broadcast. A retry rebroadcasts the same signed transaction, or finds that it already landed, and never signs a second transfer for the same order.
- Nightly sweep as a repeatable job, and the on-demand refill, both using the same send path.
- A failed send is retried with backoff and recorded as an incident.
- **Dropped transfers:** every minute the buyer checks transfers the tracker has not seen two minutes after sending. One that reverted (read from its receipt) is closed with an incident at once. One with no receipt whose nonce another transaction used is closed only after two consecutive checks agree; an order that leaves the unseen list forgets the suspicion.

### tracker

- **Cursor:** the highest block up to which every block has been scanned, with that block's hash, in Postgres. It advances in the same database transaction that stores the range's payments, so a crash can never lose a payment.
- Each pass reads `Transfer` logs to the shop address with `eth_getLogs` over ranges no larger than a configured maximum. If the provider rejects a range as too large, the range is halved and retried, down to a configured minimum.
- **Gaps:** a range that still fails is stored as a gap with its error, attempt count and next retry time. The cursor moves past it only once the gap is stored. A BullMQ job retries gaps with bounded attempts, so one bad range cannot starve new work. Open gaps show on `/health`; a recovered gap writes an incident.
- **Overlap:** each pass re-reads the last `RESCAN_BLOCKS` blocks. A log re-read inside that overlap, in the same block, is expected and skipped silently. A log seen again anywhere else, such as a gap retry or a replay after a restart, is skipped and recorded as a duplicate. If the cursor block's stored hash no longer matches the chain, the tracker steps back and rescans.
- **Credit once:** unique keys on (chain id, transaction hash, log index) for chain payments and on the payment id for ledger entries. The settle transition and the ledger insert happen in one database transaction, so a duplicate is a no-op.
- **Confirmations:** computed from the head fetched once per pass. Payments are settled when the threshold is reached. The `finalized` tag, also fetched once per pass, sets `final`.
- **Reorgs:** if the block hash stored for an unsettled payment no longer matches the chain, the payment is dropped back and an incident is written. Settled payments are rechecked until final; a mismatch there is recorded as an incident for manual review, not reversed automatically.
- **Failures:** rate limits, timeouts, connection resets and server errors are transient: bounded exponential backoff with jitter, then the gap path. Malformed requests are not retried. Each handled failure is an incident saying what happened and how it was handled. Logs never include RPC URLs, keys, signatures or raw transactions.
- On every stage change, publish an event on Redis pub/sub.
- On settle, queue a shop notice: a JSON body signed with HMAC-SHA256 and a timestamp, posted to the API. BullMQ retries it with exponential backoff. The notice is idempotent by payment id.

### api

| Route                     | Purpose                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /payments?limit=`    | Recent payments with order or donor name, stage, confirmations, block, explorer URL, note kinds                                   |
| `GET /stats`              | Today: settled count, average time to settle, duplicates skipped, failures recovered. In-memory cache with a short TTL            |
| `GET /stats/daily`        | Per UTC day for the retained period: settled count, average time to settle, scheduled and visitor purchases. Cached like `/stats` |
| `GET /incidents?limit=`   | Recent incidents                                                                                                                  |
| `GET /health`             | Head, cursor, lag, open gaps, queue depth, cooldown state, balances and low-balance flags, and the monitoring signals below       |
| `GET /events`             | Server-sent events relayed from Redis pub/sub                                                                                     |
| `POST /test-purchases`    | Visitor test buy, as above                                                                                                        |
| `GET /test-purchases/:id` | Queue position of a waiting visitor purchase, and whether it closed without a payment being sent                                  |
| `POST /shop/notices`      | Receives the signed notice. Verifies the signature and timestamp, then marks the payment notified                                 |
| `POST /stripe/webhooks`   | Phase 2                                                                                                                           |

**Request limit:** one budget per client address across all routes, `API_REQUESTS_PER_MINUTE` (default 300) a minute, answered with `429`, `rate_limited` and `Retry-After`. `POST /shop/notices` is outside it; its signature is its check. The counted address is the same one the visitor limits and the stream cap use.

**Live streams:** `GET /events` allows `STREAMS_PER_IP` (default 5) open connections per client address and `STREAMS_TOTAL` (default 500) in all. A connection over either cap gets `429`, `rate_limited` and `Retry-After: 5`. A closed connection frees its slot. The stream sends a `heartbeat` event every 15 seconds, and a client that stops reading is dropped.

**Payments cache:** `GET /payments` keeps its result per `limit` for 5 seconds, and concurrent requests share one database read.

Every 4xx answers with a fixed body. Errors that reach the error filter get a fixed code for their status (for example `bad_request`, `not_found`, `rate_limited`), and routes send their own fixed codes (for example `busy`, `daily_limit`); bodies never echo messages. CORS is allowed only for the configured web origin. With `TRUST_PROXY` set, client addresses come from the proxy's forwarding header, so per-visitor limits apply to visitors rather than to the proxy.

### web

One React + Vite page with three parts:

- **Checkout:** a "Try a test purchase" card styled as a shop counter. On click, a till drawer slides up and a random catalogue item spins in. The visitor picks how to pay; phase 1 offers only **Test network**, and phase 2 adds **Test card**. A card terminal then shows the real stages: for the test network, _Sent_, then blocks stacking to the confirmation threshold; for a test card, a card marked TEST taps the terminal, then _Processing → Approved_. A receipt prints with a PAID stamp and drops into the feed, highlighted as the visitor's. The card asks for nothing (no inputs, addresses or QR codes) and is labelled "Test purchase · no real money · paid from the demo's own test account", with a "How this works" link to the repository. Every state it shows comes from the visitor's real order.

- The checkout shows "Queued · N ahead" while a visitor purchase waits, and each limit's message says which limit applies and when it lifts.
- **Small widget:** a dark card showing the latest payment as a receipt (item, price, order and block), a confirmation bar filling to the threshold, a PAID stamp when settled, a four-step strip and a footer of counts. It runs without interaction. It can also be shown on its own at `/?view=widget`.
- **Full panel:** header with a live indicator, test network label, one-line caption; a four-lane pipeline; a receipts feed in which a receipt shows at most one note (a reorg, a transfer that did not go through, a payment after its order expired, or a thank-you on a donation; the widget shows none; `/payments` sends each payment's note kinds, the distinct incident kinds that have a note, never incident text); stats tiles.

Confirmation progress reads "N of `CONFIRMATIONS`" until the threshold, then "`CONFIRMATIONS`+ confirmations". The full panel adds a chart of settled payments per day and per week over the retained period, from `/stats/daily`, with scheduled and visitor purchases stacked and the average time to settle as a line.

Data comes from the REST routes on load and `/events` afterwards. Explorer links point to the configured block explorer.

Failures are quiet. Once the page has data, a failed refresh or health read keeps what is shown and tries again on the next 15-second cycle. The page shows the offline state only when it has no data. A closed or failed live stream is reopened after 30 seconds, and the open stream triggers a refresh.

## Data model

- `orders`: id, item, price, expected amount (micro-units), status (open, paid, expired), source (schedule, visitor), nonce, signed transaction, transaction hash, send attempts, created and expiry times.
- `daily_budgets`: UTC day, target count and amount, reserved count and amount.
- `scan_gaps`: block range, error category, attempts, next retry time, resolved time.
- `payments`: id, provider (chain, stripe), external key (unique per provider), order id (null for a donation), sender address (chain payments) and donation flag, amount, stage, confirmations, block number and hash, transaction hash, log index, final flag, stage timestamps.
- `ledger_entries`: id, payment id (unique), amount, created time.
- `incidents`: id, kind, what happened, how it was handled, related payment or block range, time.
- `cursors`: name, block number, block hash.
- `notices`: payment id (unique), attempts, delivered time.

Stats are computed from these tables, never stored as running totals.

**Retention:** a nightly job deletes orders, payments, ledger entries, notices, events and incidents older than `RETENTION_DAYS` (default 30), and resolved gaps of the same age. Open orders and unsettled or non-final payments are kept until they close.

## Monitoring

`/health` reports signals an external monitor can alert on. Each condition must hold for its whole window, so transient failures that the services recover from on their own never alert:

| Signal                                                          | Alert when      |
| --------------------------------------------------------------- | --------------- |
| Time since the tracker cursor last advanced                     | over 1 hour     |
| Age of the oldest payment in `sent`, `received` or `confirming` | over 1 hour     |
| Age of the oldest settled payment not yet notified              | over 1 hour     |
| Time since the last scheduled purchase                          | over 24 hours   |
| Time visitor test buys have been paused by the gas floor        | over 24 hours   |
| `/health` itself unreachable                                    | over 30 minutes |

The monitor sends one message when a condition starts, one when it clears, and at most one reminder a day while it lasts.

## Phase 2: Stripe

- The buyer can pay an order with Stripe test mode: create a PaymentIntent with a test card and confirm it server-side.
- `POST /stripe/webhooks` verifies the Stripe signature and credits once, keyed by PaymentIntent id. The event id guards against processing the same event twice.
- A repeatable reconciliation job lists recent Stripe events and processes any the webhook missed, recording an incident when it does.
- Locally, `stripe listen --forward-to` delivers webhooks.
- Scheduled purchases pick a payment method at creation by a configured split (for example 70% test network, 30% card). Both methods share the same daily budget reservation.
- `POST /test-purchases` takes the method the visitor chose. Limits and budget are the same for both.
- Stripe's test mode allows 25 requests per second per account; a `429` uses the same backoff as RPC rate limits.
- The pipeline and feed show the provider. Card payments skip the confirmation bar.

## Testing

- Unit tests: the request limit, the stream cap and the `/payments` cache, pacing and budget reservation (including concurrent reservations at the cap), visitor limits and queue positions, refill triggering and cooldown, the in-flight cap, unique-amount allocation and matching, idempotent send retries, credit-once under repeated logs, the hold before a send, the two-run drop check, buyer-only matching and donations, cursor and overlap logic (silent re-reads versus recorded duplicates), range halving and gaps, reorg handling, notice signature verification, retention, and the monitoring signals.
- API routes are tested over HTTP with `supertest` against an application built with `@nestjs/testing`.
- Tracker logic runs against an RPC interface so tests can feed it scripted blocks and logs, including failures and reorgs.
- One manual smoke run against Base Sepolia, documented in the README.

## Acceptance

1. With funded wallets, the buyer sends paced purchases and the tracker settles each one exactly once, visible on the page within seconds of each stage change.
2. A visitor test buy is sent at once, appears in the feed highlighted, and settles within seconds. It takes nothing from the daily budget. Each visitor limit refuses with its own message.
3. Re-reads inside the rescan overlap are skipped without an incident; a log seen again outside it is skipped and counted as a duplicate. Simulated failures in tests produce incidents with a handling note.
4. `pnpm test` and `pnpm lint` pass. `pnpm build` builds every app.
5. No keys or secrets are committed; `.env` is ignored.
6. The README explains what the project shows, how to run it locally, and the configuration.
