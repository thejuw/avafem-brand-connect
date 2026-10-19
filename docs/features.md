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

## Phase 3 — Brand side

| Capability | Where |
|---|---|
| Public self-serve signup (rate limited 5/min): creates an `invited` brand, encrypted contact, and a 48 h invite; accepting the invite (existing `/api/invites/:token/accept`) signs the agreement and opens a brand session | `POST /api/portal/signup` |
| Onboarding checklist: signup → agreement → profile (ship-from, shipping table, support email) → store connection → Stripe Express → catalog submitted → catalog approved → live, plus the core `onboardingRequirements` | `GET /api/portal/:brandId/status`, `PATCH …/profile`, MCP `get_onboarding_status` |
| Stripe Express onboarding (**mocked** AccountLink + simulated `account.updated`; uses `acct_sandbox_…` ids) | `POST /api/portal/:brandId/stripe/link`, `…/stripe/return` |
| Store connection: WooCommerce (consumer key/secret), BigCommerce (store hash + token), CSV, or Shopify (hands off to the existing OAuth install). Credentials are verified, then stored AES‑GCM encrypted; disconnect wipes them | `POST /api/portal/:brandId/connect`, `GET …/connectors`, `DELETE …/connectors/:platform` |
| Connector adapters behind one interface (`verify`, `listProducts`, `createOrder`), all HTTP via injected `fetch` | `server/platform/connectors.mjs` |
| Catalog sync from Woo/BigCommerce and CSV fallback (Avafem columns or Shopify product export) into the core catalog (products land in draft/in_review with validation issues) | `POST …/connectors/:platform/sync`, `POST /api/portal/:brandId/catalog/csv`, `POST /v1/catalog/csv`, MCP `upload_catalog_csv` |
| Catalog approval queue (validation issues + Phase 4 compliance flags); approve with the existing `POST /api/products/:id/review` | `GET /api/portal/review-queue` |
| Operator activation (refuses while core requirements remain) | `POST /api/portal/:brandId/activate` |
| Push a Bag to the brand's Woo/BigCommerce store (idempotent per Bag) | `POST /api/connectors/orders/:bagId/push` |
| Brand analytics: sales (gross, net, AOV, commission), returns (rate), conversion (swipes, likes, liked→purchased rate, placement impressions/clicks/CTR), top products | `GET /api/brands/:id/analytics`, `GET /v1/analytics`, MCP `get_brand_analytics` |
| Paid placements: `featured_spot` ($25/day), `sponsored_swipe` ($10 per 1,000 impressions), `sampling_box` ($1.50/unit); approved product only; operator approval creates an `invoiced` billing record (`invoice` or `payout_offset`); cancel before start voids it; shopper feed caps sponsored swipes at purchased impressions | `/api/placements…`, `/api/billing…`, `/v1/placements`, `/v1/billing`, MCP `list_placements`, `request_placement` |

Tests: `tests/platform-brands.test.mjs` (WooCommerce/BigCommerce HTTP fully mocked).
