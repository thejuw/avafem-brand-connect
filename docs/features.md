# Avafem backend + CRM features (branch `ava/backend-crm`)

Everything here is **local-only and sandbox**: email/SMS go to a simulated outbox
(`message_outbox`, status `simulated`), Stripe/Shopify/WooCommerce/BigCommerce calls are
mocked, and no live credentials are read. Platform modules live in `server/platform/`,
their tables in `server/platform/schema.sql` (created idempotently on boot), REST routes in
`server/platform/routes.mjs`, OpenAPI additions in `server/platform/openapi.mjs`, and brand
MCP tools are appended to the existing `/mcp` server. The operator UI is the
**Backend & CRM** nav item (`web/PlatformPanel.jsx`).

Conventions kept from the core: tenant isolation by brand id (brand sessions/bearers can only
read their own records), admin routes need the operations workspace + CSRF, PII is AES‑256‑GCM
encrypted (purpose‑bound keys derived from the configured encryption key), integer USD cents,
idempotency keys on `/v1` and MCP mutations, audit log entries for sensitive operator actions.

## Phase 1 — CRM / shopper

| Capability | Where |
|---|---|
| Unified shopper profile (orders/Bags, lifetime spend, intake answers, cycle phase, swipe likes/passes, Beauty Bank balance, consent flags) | `crm.profile`, `GET /api/crm/shoppers/:id` |
| Shopper upsert (email is the dedupe key; stored only as SHA‑256 hash + ciphertext) | `POST /api/crm/shoppers` |
| Consent flags `email`, `sms`, `marketing`, `health` | `PATCH /api/crm/shoppers/:id/consent` |
| Health vault for intake + cycle (separate table, separate key, purpose‑bound reads, access log) | `server/platform/health.mjs`, `PUT /api/crm/shoppers/:id/intake` |
| Order linking (one shopper per Bag) and swipe likes | `POST /api/crm/shoppers/:id/orders`, `/swipes` |
| Segments: `cyclePhase`, `concern`, `minSpendCents`/`maxSpendCents`, `lapsedDays` | `POST /api/crm/segments`, `GET /api/crm/segments/:id/members` |
| Campaign flows: `broadcast` and cycle‑timed `restock_reminder` (fires `leadDays` before next period and ≥ `minDaysSinceOrder` after delivery; dedupe per cycle) | `POST /api/crm/campaigns`, `/run`, `POST /api/crm/jobs/run`, background worker |
| Simulated outbox (masked recipient hint; recipient stored encrypted) | `GET /api/crm/outbox` |
| Support inbox: tickets linked to order, Bag, brand and latest shipment; replies notify the shopper via outbox; actions `refund` (core sandbox refund + approval) and `credit` (Beauty Bank goodwill, Phase 2) | `/api/crm/tickets…`, `GET /v1/tickets`, `POST /v1/tickets/:id/replies` |
| Post‑delivery reviews (1–5, body, https photo URL) synced to a brand feed without shopper id/PII | `POST /api/crm/shoppers/:id/reviews`, `GET /v1/reviews`, `GET /api/crm/brand/reviews` |
| MCP tools | `list_reviews`, `list_support_tickets`, `reply_support_ticket` |

Consent rules: segments using cycle/concern exclude shoppers without `health` consent;
campaigns require `marketing` **and** the channel consent (`email`/`sms`); ticket replies are
service messages and go by email without marketing consent. Shopper endpoints are operator‑only
(there is no shopper login in this repo; the shopper app would call these through a backend).

Tests: `tests/platform-crm.test.mjs`, `tests/platform-openapi.test.mjs`, `web/lib/platform-panel.test.mjs`.

## Phase 2 — Money / operations

| Capability | Where |
|---|---|
| Beauty Bank lots: `LAB` (pending) → `VAULT` (spendable) once the earning Bag is delivered **and** its return window has passed; `REVERSED` on refund/cancel; `EXPIRED` after `expiryDays` (365). Earn rate 300 bps of merchandise subtotal (configurable). Every transition is journaled in `bank_events`. | `server/platform/money.mjs` (`createBeautyBank`) |
| Earn / goodwill / redeem (idempotency key, soonest-expiring lots first, `INSUFFICIENT_CREDIT`, key reuse conflict) | `POST /api/bank/shoppers/:id/earn`, `/goodwill`, `/redeem`, `GET /api/bank/shoppers/:id` |
| Jobs: maturity, expiry, auto-reversal of refunded Bags (also triggered immediately by support-ticket refunds) | `POST /api/bank/run`, background worker via `platform.jobs()` |
| Liability report (VAULT = liability, LAB = contingent, redeemed, breakage, reversed, expiring in 30 days, self-balancing check) | `GET /api/bank/liability` |
| Disputes (simulated Stripe disputes): opening holds the Bag's scheduled transfer + payout job; evidence packet built from shipments; `won` restores the payout when nothing else blocks it; `lost` keeps the hold and raises an alert | `/api/admin/disputes…`, `GET /v1/disputes`, MCP `list_disputes` |
| Holds (with open refund/dispute counts; release refused while blocked) | `GET /api/admin/holds`, `POST /api/admin/holds/:id/release` |
| Stuck transfers (scheduled > 1 day past due or failed payout job) + requeue | `GET /api/admin/stuck-transfers`, `POST …/:id/retry` |
| Reconciliation alerts (unbalanced ledger, Bag/transfer mismatch, stuck transfers, dispute deadlines), deduped + acknowledgeable | `GET /api/admin/alerts`, `POST /api/admin/alerts/scan`, `POST /api/admin/alerts/:id/ack`, `GET /api/admin/console` |
| Checkout risk score (amount, billing/ship/IP country mismatch, velocity, new account, bulk qty, disposable email, returning-customer credit) → `allow`/`review`/`block` | `POST /api/risk/checkout`, `GET /api/risk/assessments` |
| Pre-payout brand checks (payouts enabled, paused/disconnected, refund rate, open/lost disputes, late shipments); `enforce:true` holds failing brands' scheduled sandbox transfers | `POST /api/admin/payout-checks`, `GET /api/brands/:id/payout-check` |
| Sales-tax report by ship-to state (gross, shipping, tax collected/refunded, net), JSON or `?format=csv` | `GET /api/reports/sales-tax?from=&to=` |
| Brand annual payout report (1099-K style: gross volume, transaction count, monthly gross, refunds, commission, net transfers paid), JSON/CSV, brand-scoped | `GET /api/reports/brand-payouts?year=`, `GET /v1/reports/payouts`, MCP `get_annual_payout_report` |

Notes: risk scoring is an endpoint the checkout calls; it is not yet wired to block the existing
unified/test checkout flows (deliberately, to keep their behaviour and tests intact). The tax
and 1099-K outputs are data exports for an accountant, not filings.

Tests: `tests/platform-money.test.mjs`.
