# testnet-payments: design spec

Date: 2026-10-20, revised 2026-10-23. Status: current.

## Purpose

A demo of payment tracking. A bot buys silly items from a demo shop and pays on one of two rails: testnet USDC on Base Sepolia, or a saved Stripe test card. Separate services follow each payment to settlement (on chain by waiting for confirmations, by card from a signed Stripe webhook), credit it exactly once, notify the shop, and stream every step to a one-page dashboard.

Both rails are test-only. Stripe runs in test mode, and configuration rejects every secret key that does not start with `sk_test_`, so a live key (`sk_live_`) stops the service at startup. Visitors never enter card details: the demo pays with a test card saved in Stripe for its own customer.

## Principles

- **Real data only.** Every number and note the page shows comes from database rows written by the services. The front end animates real state; it never invents events.
- **Small scope.** One provider per payment method, one instance per service.
- **Configuration from the environment.** Keys and URLs come from environment variables, documented in `.env.example`, and are never committed or logged.
- **Plain wording on the page.** The dashboard says payment, confirming, settled, test network. It does not say wallet, token, coin or gas.

## Scope

- **Rails:** chain payments (Base Sepolia, USDC) and card payments (Stripe test mode), both writing to one ledger, plus the dashboard.
- **Out of scope:** deployment scripts, more than one RPC provider, more than one chain at a time, user accounts, refunds and disputes, card entry by visitors. The services can run behind a reverse proxy (`TRUST_PROXY`).

## Stack

- pnpm workspace. Node 24 LTS, TypeScript strict.
- NestJS monorepo: `apps/buyer`, `apps/tracker`, `apps/api`, shared code in `libs/`. The API runs on the Express adapter with controllers, DTOs validated by `class-validator`, `@nestjs/throttler` for the request limit and `@nestjs/config` for settings. Buyer and tracker are application contexts whose jobs are `@nestjs/bullmq` processors. Each app is split into feature modules (a module, its controller or processor, its service and DTOs).
- `web/`: React + Vite, one page.
- Prisma with PostgreSQL. Redis for BullMQ, request rate limits and pub/sub.
- viem for chain access. The `stripe` SDK for the card rail.
- Postgres and Redis are not started by this repository; their URLs come from the environment. A `docker-compose.yml` for local Postgres and Redis is acceptable as a convenience.

## Network and money

- Chain: Base Sepolia, set by config (`CHAIN_ID`, `RPC_URL`, `USDC_ADDRESS`), so Ethereum Sepolia can be swapped in.
- RPC: the free public endpoint by default. An optional key-based URL (for example a free Alchemy key) is just a different `RPC_URL`.
- Payments are transfers of Circle's testnet USDC (6 decimals). Verify the contract address against Circle's documentation before use.
- Two wallets: **buyer** and **shop**. Keys live only in `.env`. A script `pnpm wallets:new` generates both keys and writes them to `.env` with mode 0600. It prints only the public addresses.
- **Recycling:** a nightly job sweeps the shop's USDC back to the buyer. A **refill** does the same on demand: when the buyer's USDC falls below `REFILL_BELOW` and the shop holds USDC and enough gas, the shop sends its whole USDC balance to the buyer, at most once per `REFILL_COOLDOWN_SECONDS` (default 20). USDC only circulates between the two wallets; the running cost is gas, a fraction of a cent per purchase.
- **Stripe:** test mode only. `STRIPE_SECRET_KEY` (`sk_test_…`) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`) come from the environment, are validated, and are never logged or returned. The buyer charges cards only with the key set, and the card rail is offered only when `pnpm stripe:setup` has created the demo customer with a saved card and `STRIPE_WEBHOOK_SECRET` is set. No card data is stored beyond Stripe IDs (`cus_…`, `pm_…`, `pi_…`, `evt_…`), the card brand and its last four digits.
- **Gas floor:** chain test buys pause while the buyer's gas balance is below `GAS_FLOOR` (default 0.0002 ETH) and resume when it is topped up. The page says the demo account is being topped up, in its plain wording.
- **Low balance:** the API reports buyer and shop balances (gas and USDC). `/health` flags each balance below its configured threshold for monitoring; the page shows no balance warnings. No faucet automation.

## Orders and matching

- An order picks a random item from a small catalogue of silly items (for example "Gold rubber duck") priced between $0.50 and $2.00 (Stripe's smallest USD charge is $0.50).
- **Rail:** every order is paid on the chain rail or the card rail. The rail is fixed when the order is created. A scheduled order is paid by card for one order id in three (the first byte of `sha256(orderId)` modulo 3 is 0) when the demo customer has a saved card and the buyer has `STRIPE_SECRET_KEY`, and on chain otherwise. A visitor order uses the rail the visitor chose.
- **Chain orders:** USDC transfers carry no reference, so orders are matched by **unique amount**: price plus an offset of 1 to 9,999 micro-units, unique among chain orders of the last 24 hours. Example: $1.40 becomes 1.400731 USDC. The offsets bound chain orders to 9,999 a day; the visitor daily limit keeps well below it.
- **Card orders:** the expected amount is the price in micro-units with no offset (price in cents times 10,000), and Stripe is charged the price in cents in USD. The tracker matches transfers to chain orders only, so a transfer whose amount equals a card order's never settles it.
- On the chain rail, only transfers whose sender is `BUYER_ADDRESS` (compared case-insensitively) are matched to orders. A buyer transfer that matches no open order is stored with no order and logged as an incident; it is never credited to an order.
- Any other USDC transfer to the shop is a **donation**. It is stored with its sender (`from_address`, `donation`), settles with a ledger entry like any payment, and has no order, no shop notice and no `unmatched` incident (a reorg or duplicate still records its own incident). USDC is the only asset tracked. The API derives a stable two-word name from the sender and never returns the address. Donations below `DONATION_MIN` (default 10,000 micro-units, 0.01 USDC) stay stored but are left out of `/payments`, the event stream, `/stats` and `/stats/daily`.
- An order not paid within a configured time expires.

## Pacing and test buys

Two kinds of purchase share one send path but not their limits: **scheduled** purchases make the shop look busy through the day, and **visitor test buys** let a visitor watch a payment settle in seconds.

- **Rail split (scheduled only):** one in three scheduled purchases is paid by card, chosen from the order id as above; the rest are paid on chain. Both rails reserve from the same daily budget.
- **Daily budget (scheduled only):** caps scheduled purchases per UTC day by count and total amount (`DAILY_COUNT_CAP`, default 100; `DAILY_AMOUNT_CAP`, default 200 USDC, so the count is what binds). Each day's target is drawn between half and all of each cap from the date and a seed, so days differ and a restart keeps the same target.
- **Reservation:** a scheduled purchase reserves its count and amount in the `daily_budgets` row with one conditional update that fails when the cap would be exceeded. Sent but unsettled purchases count against the budget. A reservation is released only when a send is known to have failed; a send with an unknown outcome keeps it.
- **Schedule:** each minute, the buyer decides whether to buy, with a probability of the remaining budget divided by the expected purchase size and the remaining active minutes. This gives quiet and busy minutes and spreads the target over the day. A UTC quiet window overnight lowers the probability. Remaining work is recomputed from the database each minute, so a restart resumes the day instead of starting over.
- **Visitor test buys:** `POST /test-purchases` takes `{"rail": "chain" | "card"}` (default `chain`), creates an order and queues it at the highest priority. It takes no daily budget, so a visitor never waits behind the schedule. A card buy answers `503` `card_unavailable` unless the card rail is available (a saved card and `STRIPE_WEBHOOK_SECRET`). Its limits, each a configuration value, protect gas, the RPC budget, the Stripe budget and the matching offsets. They are shared by both rails, except the gas floor, which applies to chain buys only:

| Limit                         | Default                    | Response                         |
| ----------------------------- | -------------------------- | -------------------------------- |
| Per visitor (IP, hashed)      | 10 a minute, 100 a UTC day | `429` with `Retry-After`         |
| Waiting visitor purchases     | 30                         | `429` "busy", with `Retry-After` |
| Visitor purchases per UTC day | 2,000                      | `409` until 00:00 UTC            |
| Buyer gas below `GAS_FLOOR`   | — (chain only)             | `503` until topped up            |

The response returns the order id and its queue position, so the page can highlight the order and show "queued" until it is sent. `GET /test-purchases/:id` returns `{position, closed}`: the position while the order waits, and whether it closed without a payment being sent.

**Shared and per-rail limits.** Shared by both rails: visitor admission limits and queue, the scheduled daily budget, orders, the ledger (one entry per payment), payment events, the live list, shop notices and retention. Chain only: the gas floor, funds hold, in-flight cap, nonces, confirmations, reorg handling and amount matching. Card only: the Stripe request limiter.

## RPC budget and latency

The services run on free RPC tiers, so request volume is designed to stay inside their rate limits. Card sends make no RPC calls and are not part of this budget; they have their own limiter (see Card rail).

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

Card: `sent → processing → settled → notified`, without a confirmation count, or the terminal `failed`.

- **sent:** the PaymentIntent exists. The webhook may create the payment at this stage when it arrives before the buyer has written its own record.
- **processing:** the buyer recorded the accepted charge, or Stripe sent `payment_intent.processing`.
- **settled:** the webhook received `payment_intent.succeeded`. The ledger entry, the shop notice and the order's `paid` status are written in one database transaction, and `final` is set at once.
- **notified:** the shop accepted the signed notice, as on the chain rail.
- **failed:** the PaymentIntent was declined or canceled. The payment is `final`, the order is closed unless it already is, one `card_failed` incident is recorded and nothing is credited. It is terminal: a later `processing` or `succeeded` for the payment changes nothing.

A stage never moves backwards: an event that would move a payment to an earlier or equal stage is ignored.

## Services

### buyer

- Runs the pacing schedule as a repeatable per-minute BullMQ job that queues purchase jobs with random offsets inside the minute.
- Each purchase job: reserve the budget, create the order with its unique amount, then send.
- **Hold before a send:** before an order is sent, the buyer checks that its cached USDC balance (refreshed every few seconds), less the amounts still in flight, covers the order. If not, the job is delayed 2 seconds without using an attempt, so the order can still expire and close.
- **Upkeep queue:** `check-unseen` and `refill-check` run on their own `buyer-upkeep` queue and worker, so held sends never delay them.
- **Card orders** skip the in-flight cap and the funds hold, which count chain transfers only. The buyer charges the demo customer's saved card off-session for the order's price in cents, with idempotency key `order-<order id>`, then records the payment as `processing`. It never writes a ledger entry or sets `settled`; only the webhook settles a card payment.
- **Sending is idempotent per order.** Nonces are allocated one at a time. The signed transaction and its hash are stored on the order before broadcast. A retry rebroadcasts the same signed transaction, or finds that it already landed, and never signs a second transfer for the same order.
- Nightly sweep as a repeatable job, and the on-demand refill, both using the same send path.
- **Card reconciliation:** every minute on the `buyer-upkeep` queue, unless Stripe is cooling down. It reads from Stripe up to 20 card payments a run, oldest first, that are still `sent` or `processing` three minutes after their last stage time. With room left in the 20, it searches Stripe by order id for card orders created in the last 24 hours that were tried but have no payment row (`sendState` `review`, or `failed` with the order expired). Each PaymentIntent goes through `applyIntent`, the function the webhook uses, in its own transaction.
- A failed send is retried with backoff and recorded as an incident. A declined card fails the payment and closes the order with a `card_failed` incident and credits nothing. A Stripe error that retries cannot fix (no key, no saved card) closes the order with a `send_failed` incident.
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
| `GET /events`             | Server-sent events relayed from Redis pub/sub: payments, order changes, the visitor queue and a heartbeat                         |
| `POST /test-purchases`    | Visitor test buy, as above                                                                                                        |
| `GET /test-purchases/:id` | Queue position of a waiting visitor purchase, and whether it closed without a payment being sent                                  |
| `POST /shop/notices`      | Receives the signed notice. Verifies the signature and timestamp, then marks the payment notified                                 |
| `POST /stripe/webhooks`   | Receives Stripe events. Verifies the signature over the raw body, then moves the card payment the event names. See Card rail      |

**Request limit:** one budget per client address across all routes, `API_REQUESTS_PER_MINUTE` (default 300) a minute, answered with `429`, `rate_limited` and `Retry-After`. `POST /shop/notices` and `POST /stripe/webhooks` are outside it; their signatures are their checks. The counted address is the same one the visitor limits and the stream cap use.

**Body limits:** a JSON body may be 4 KB at most, except `POST /stripe/webhooks`, which accepts 64 KB. A larger body answers `413` `payload_too_large`.

**Live streams:** `GET /events` allows `STREAMS_PER_IP` (default 5) open connections per client address and `STREAMS_TOTAL` (default 500) in all. A connection over either cap gets `429`, `rate_limited` and `Retry-After: 5`. A closed connection frees its slot. Payments arrive as unnamed events. Order changes arrive as named `order` events (`{id, closed}`), and the waiting visitor queue as `queue` events (`{waiting}`, the order ids oldest first), sent only when it changes. The stream sends a `heartbeat` event every 15 seconds, and a client that stops reading is dropped.

**Payments cache:** `GET /payments` keeps its result per `limit` for 5 seconds, and concurrent requests share one database read.

Every 4xx answers with a fixed body. Errors that reach the error filter get a fixed code for their status (for example `bad_request`, `not_found`, `rate_limited`), and routes send their own fixed codes (for example `busy`, `daily_limit`); bodies never echo messages. CORS is allowed only for the configured web origin. With `TRUST_PROXY` set, client addresses come from the proxy's forwarding header, so per-visitor limits apply to visitors rather than to the proxy.

### web

One React + Vite page with three parts:

- **Checkout:** a "Try a test purchase" card styled as a shop counter. On click, a till drawer slides up and a random catalogue item spins in. The visitor picks how to pay with one of two buttons, **Pay on the test network** and **Pay with a test card**; the card button is shown only when `/health` reports `cardAvailable`. A terminal then shows the real stages: for the test network, _Sent_, then blocks stacking to the confirmation threshold; for a test card, the saved card (brand and last four digits) taps the terminal, then _Sent → Processing → Settled_. A card receipt carries a "Test card" badge naming the brand and last four digits (a long brand shortens, the digits always stay visible) and a link to Stripe's receipt, and has no confirmation bar. A receipt prints with a PAID stamp and drops into the feed, highlighted as the visitor's. The card asks for nothing (no inputs, addresses or QR codes) and is labelled "Test purchase · no real money · paid from the demo's own test account", with a "How this works" link to the repository. Every state it shows comes from the visitor's real order.

- The checkout shows "Queued · N ahead" while a visitor purchase waits, and each limit's message says which limit applies and when it lifts. It follows the visitor's order on the event stream, not by polling: it reads `GET /test-purchases/:id` once and again each time the stream opens, and takes the queue position and the closed state from the `queue` and `order` events. A payment that fails ends the terminal on "Failed" and reopens the buttons with a "did not go through" note. A card payment still `processing` two minutes after its `processingAt` stops holding the checkout: the buttons reopen with "Still processing at Stripe. It will appear in the feed when it settles.", and the payment stays in the feed.
- **Small widget:** a dark card showing the latest payment as a receipt (item, price, order and block), a confirmation bar filling to the threshold, a PAID stamp when settled, a stage strip and a footer of counts. A chain payment's strip is Received, Confirming, Settled, Shop notified. A card payment's strip is Sent, Processing, Settled, Shop notified, and a failed payment's strip ends on a red Failed step in place of the stages it never reached. A card receipt shows the brand and last four digits in its badge and no confirmation bar. It runs without interaction. It can also be shown on its own at `/?view=widget`.
- **Full panel:** header with a live indicator, test network label, one-line caption; a five-lane pipeline (Received, Confirming, Processing, Settled, Shop notified) with a separate line under it counting payments that did not go through, since a failed payment is in no lane; a receipts feed in which a receipt shows at most one note (a reorg, a payment that did not go through, a payment after its order expired, or a thank-you on a donation; the widget shows none; `/payments` sends each payment's note kinds, the distinct incident kinds that have a note, never incident text); stats tiles.

Confirmation progress reads "N of `CONFIRMATIONS`" until the threshold, then "`CONFIRMATIONS`+ confirmations". The full panel adds a chart of settled payments per day and per week over the retained period, from `/stats/daily`, with scheduled and visitor purchases stacked and the average time to settle as a line.

Data comes from the REST routes on load and `/events` afterwards. Explorer links point to the configured block explorer.

Failures are quiet. Once the page has data, a failed refresh or health read keeps what is shown and tries again on the next 15-second cycle. The page shows the offline state only when it has no data. A closed or failed live stream is reopened after 30 seconds, and the open stream triggers a refresh.

## Data model

- `orders`: id, item, price, expected amount (micro-units), status (open, paid, expired), source (schedule, visitor), rail (chain, card), customer id, nonce, signed transaction, transaction hash, send attempts, created and expiry times.
- `daily_budgets`: UTC day, target count and amount, reserved count and amount.
- `scan_gaps`: block range, error category, attempts, next retry time, resolved time.
- `customers`: id, name, chain address, Stripe customer id, Stripe payment method id, card brand, last four digits. One demo customer.
- `stripe_events`: Stripe event id, type, received time. An event id is stored once.
- `order_events`: order id, created time and published time; one row for each change to an order's status or send state, written in the same transaction and published after it commits.
- `payments`: id, provider (chain, stripe), external key (unique per provider; the PaymentIntent id for Stripe), order id (null for a donation), sender address (chain payments) and donation flag, amount, stage, confirmations, block number and hash, transaction hash, log index, Stripe receipt URL, final flag, stage timestamps.
- `ledger_entries`: id, payment id (unique), amount, created time.
- `incidents`: id, kind, what happened, how it was handled, related payment or block range, time.
- `cursors`: name, block number, block hash.
- `notices`: payment id (unique), attempts, delivered time.

Stats are computed from these tables, never stored as running totals.

**Retention:** a nightly job deletes orders, payments, ledger entries, notices, payment events, order events, Stripe events and incidents older than `RETENTION_DAYS` (default 30), and resolved gaps of the same age. Open orders and unsettled or non-final payments are kept until they close.

## Monitoring

`/health` reports signals an external monitor can alert on. Each condition must hold for its whole window, so transient failures that the services recover from on their own never alert:

| Signal                                                                        | Alert when      |
| ----------------------------------------------------------------------------- | --------------- |
| Time since the tracker cursor last advanced                                   | over 1 hour     |
| Age of the oldest payment in `sent`, `received`, `confirming` or `processing` | over 1 hour     |
| Age of the oldest settled payment not yet notified                            | over 1 hour     |
| Time since the last scheduled purchase                                        | over 24 hours   |
| Time visitor test buys have been paused by the gas floor                      | over 24 hours   |
| `/health` itself unreachable                                                  | over 30 minutes |

The monitor sends one message when a condition starts, one when it clears, and at most one reminder a day while it lasts.

## Card rail

- **Setup:** `pnpm stripe:setup` (needs `STRIPE_SECRET_KEY`, `DATABASE_URL` and `BUYER_PRIVATE_KEY`) creates the demo customer in the database and in Stripe, attaches the test card named by `STRIPE_PAYMENT_METHOD` (default `pm_card_visa`) as the customer's payment method, and stores the Stripe IDs, brand and last four digits. It records the chain address of the buyer key on the customer. It prints only those IDs and the card label. A second run changes nothing, and a run that failed part-way reuses the card already attached. A saved card together with `STRIPE_WEBHOOK_SECRET` makes the rail available: `/health` reports `cardAvailable` and card visitor buys are accepted. Scheduled purchases pick cards when the buyer also has `STRIPE_SECRET_KEY`.
- **Charge:** the buyer creates a PaymentIntent with the saved card, `confirm: true`, `off_session: true`, currency `usd`, the order id in its metadata and idempotency key `order-<order id>`. A retry after a timeout returns the same PaymentIntent, so the card is never charged twice.
- **Webhook:** `POST /stripe/webhooks` verifies the `Stripe-Signature` header over the exact request bytes with `STRIPE_WEBHOOK_SECRET`. A missing or bad signature, or a missing secret, answers `400` `invalid_signature`. The event id is stored in `stripe_events` and the event is applied in the same transaction, so a repeated id is skipped and recorded as a `duplicate` incident. Handled events:
  - `payment_intent.processing` moves a `sent` payment to `processing`.
  - `payment_intent.succeeded` settles a payment that is `sent`, `received`, `confirming` or `processing`, once, with `final` set. An order that was expired or past its expiry gets a `paid_after_expiry` incident.
  - `payment_intent.payment_failed` moves a payment that has not settled to `failed`.
  - The status of the PaymentIntent decides the outcome, so the webhook and reconciliation agree: `processing`, `succeeded`, and `requires_payment_method` or `canceled` for a failure.
  - Any other type is stored and ignored. An intent changes a payment only when its metadata names a card order, its amount equals the order's price in cents, its currency is `usd` and the order has no other PaymentIntent. Otherwise the event is stored, nothing changes and an `unmatched` incident is recorded.
- **Order of events:** the webhook can arrive before the buyer has written its payment. It then creates the payment from the event, and the buyer's later write adds its send time and receipt link without duplicating the row or moving its stage back. Orders are row-locked, so the two writers agree.
- **Rate limit:** the buyer's Stripe requests go through a limiter of their own (`STRIPE_REQUESTS_PER_SECOND`, default 5) with the same cooldown as RPC rate limits (`RPC_COOLDOWN_MS`), shown as `cooldowns.stripe` in `/health`. A rate-limited, unreachable or erroring Stripe delays card sends only, retried with backoff; chain sends and the API are unaffected.
- **Locally:** after `stripe login` (or with `--api-key`), `stripe listen --forward-to localhost:<API_PORT>/stripe/webhooks` delivers webhooks and prints the `whsec_…` value for `STRIPE_WEBHOOK_SECRET`. A Dashboard endpoint at `/stripe/webhooks` subscribes to `payment_intent.processing`, `payment_intent.succeeded` and `payment_intent.payment_failed`.
- **Not handled:** refunds and disputes.

## Testing

- Unit tests: the request limit, the stream cap and the `/payments` cache, pacing and budget reservation (including concurrent reservations at the cap), visitor limits and queue positions, refill triggering and cooldown, the in-flight cap, unique-amount allocation and matching, idempotent send retries, credit-once under repeated logs, the hold before a send, the two-run drop check, buyer-only matching and donations, cursor and overlap logic (silent re-reads versus recorded duplicates), range halving and gaps, reorg handling, notice signature verification, retention, and the monitoring signals.
- Card rail tests never call Stripe. They inject a fake Stripe client and sign webhook bodies with `stripe.webhooks.generateTestHeaderString`. They cover: the charge and its idempotency key (a retry after a timeout charges once); a declined card; a transient failure retried and sent to review; Stripe rate limiting that leaves chain sends running; settlement from `succeeded` once; a `succeeded` event that arrives before the buyer's write; duplicate and out-of-order events; bad and missing signatures and a missing secret; a body over 4 KB refused globally and accepted on the webhook route up to 64 KB; `payment_failed` moving the payment to `failed`; events that fail the order, amount, currency or single-intent rule; reconciliation of a missed webhook; the availability rule and the Stripe-key rule for scheduled cards; order and queue events on the stream; the two-minute exit from `processing`; a card order never matched to a chain transfer; card amounts and the repriced catalogue; the one-in-three rail choice; and the checkout's card flow, receipt and closed state.
- API routes are tested over HTTP with `supertest` against an application built with `@nestjs/testing`.
- Tracker logic runs against an RPC interface so tests can feed it scripted blocks and logs, including failures and reorgs.
- One manual smoke run against Base Sepolia, documented in the README.

## Acceptance

1. With funded wallets, the buyer sends paced purchases and the tracker settles each one exactly once, visible on the page within seconds of each stage change.
2. A visitor test buy, on either rail, is sent at once, appears in the feed highlighted, and settles within seconds. It takes nothing from the daily budget. Each visitor limit refuses with its own message.
3. Re-reads inside the rescan overlap are skipped without an incident; a log seen again outside it is skipped and counted as a duplicate. Simulated failures in tests produce incidents with a handling note.
4. `pnpm test` and `pnpm lint` pass. `pnpm build` builds every app.
5. No keys or secrets are committed; `.env` is ignored.
6. The README explains what the project shows, how to run it locally, and the configuration.
