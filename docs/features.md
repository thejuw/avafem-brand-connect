# Avafem backend + CRM features (branch `ava/backend-crm`)

These modules are **sandbox features, not a production-completion claim**. CRM email/SMS
go to a simulated outbox (`message_outbox`, status `simulated`) and subscription charges
are mocked. New two-step payout onboarding is unavailable without a configured server
test adapter; the legacy portal's simulated Express shortcut cannot complete it.
Invitation email has a separate default-off, server-only Resend opt-in; no actual
invitation email was sent in the local checks. WooCommerce/BigCommerce adapters can make
real HTTPS requests when explicitly connected; automated tests inject fake transports
and never use provider credentials. The existing provider-backed Shopify/Stripe unified
checkout remains separate. Platform modules live in `server/platform/`,
their tables in `server/platform/schema.sql` (created idempotently on boot), REST routes in
`server/platform/routes.mjs`, OpenAPI additions in `server/platform/openapi.mjs`, and brand
MCP tools are appended to the existing `/mcp` server. The operator UI is the
**Backend & CRM** nav item (`web/PlatformPanel.jsx`).
Its admin-only **Recovery desk** now provides guarded recovery queues and audit
history; see [the operator runbook](admin-recovery.md) for actions and limitations.
Its **Brand invites**, **Connect your brand** and **Product curation** screens now
implement the local two-step/curation foundation; see [the onboarding runbook](two-step-onboarding.md).
Public native approval, real invitation acceptance/delivery and embedded payout
onboarding remain separate, unverified acceptance work.

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
| Simulated outbox (masked recipient hint; encrypted recipient; health-derived subject/body/campaign linkage encrypted, consent-gated and audited; paginated default 100/max 500) | `GET /api/crm/outbox?limit=&offset=` |
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
| Liability report (VAULT = liability, LAB = contingent, redeemed, expiry breakage, reversed, explicit `writtenOffCents`, expiring in 30 days, self-balancing check) | `GET /api/bank/liability` |
| Disputes (simulated Stripe disputes): opening holds the Bag's scheduled transfer + payout job; evidence packet built from shipments; `won` restores the payout when nothing else blocks it; `lost` keeps the hold and raises an alert | `/api/admin/disputes…`, `GET /v1/disputes`, MCP `list_disputes` |
| Holds (with open refund/dispute counts; release refused while blocked) | `GET /api/admin/holds`, `POST /api/admin/holds/:id/release` |
| Admin recovery: immutable lost-dispute recovery evidence or whole-Bag noncash payable waiver, separately audited hold release, pending canonical/Beauty Bank credit release/writeoff, encrypted operator reasons and resolution history. Lost outcomes stay lost; releases cannot bypass delivery, current/prior return holds, refunds, other unresolved disputes, brand availability or provider-bound workflow boundaries. | `GET /api/admin/recovery`, `/credits`, `/history`; `POST …/disputes/:id/resolve`, `…/holds/:id/release`, `…/credits/:id/resolve`; [runbook](admin-recovery.md) |
| Stuck transfers (scheduled > 1 day past due or failed payout job) + requeue | `GET /api/admin/stuck-transfers`, `POST …/:id/retry` |
| Reconciliation alerts (unbalanced ledger, Bag/transfer mismatch, stuck transfers, dispute deadlines), deduped + acknowledgeable | `GET /api/admin/alerts`, `POST /api/admin/alerts/scan`, `POST /api/admin/alerts/:id/ack`, `GET /api/admin/console` |
| Checkout risk score (amount, billing/ship/IP country mismatch, velocity, new account, bulk qty, disposable email, returning-customer credit) → `allow`/`review`/`block` | `POST /api/risk/checkout`, `GET /api/risk/assessments` |
| Pre-payout brand checks (payouts enabled, paused/disconnected, refund rate, open/lost disputes, late shipments); `enforce:true` holds failing brands' scheduled sandbox transfers | `POST /api/admin/payout-checks`, `GET /api/brands/:id/payout-check` |
| Sales-tax report by ship-to state (gross, shipping, tax collected/refunded, net), JSON or `?format=csv` | `GET /api/reports/sales-tax?from=&to=` |
| Brand annual payout report (1099-K style: gross volume, transaction count, monthly gross, refunds, commission, net transfers paid), JSON/CSV, brand-scoped | `GET /api/reports/brand-payouts?year=`, `GET /v1/reports/payouts`, MCP `get_annual_payout_report` |

Notes: risk scoring is an endpoint the checkout calls; it is not yet wired to block the existing
unified/test checkout flows (deliberately, to keep their behaviour and tests intact). The tax
and 1099-K outputs are data exports for an accountant, not filings.

Recovery decisions require a reason and stable operation ID. A payable writeoff cancels
an unpaid sandbox obligation using `sandbox_payable_writeoff_adjustment`, voids pending
canonical credits and forfeits pending LAB lots. It does not refund the shopper or
recover cash; no provider payment/payout is created. A subsequent sandbox refund uses
the recorded adjustment without double-debiting the brand payable. These tools reject
provider-bound, paid/reversed and unreconciled cases instead of inventing recovery.

Tests: `tests/platform-money.test.mjs`, `tests/platform-money-failures.test.mjs`,
`tests/platform-financial-resolutions.test.mjs`, `tests/platform-admin-recovery-routes.test.mjs`.

## Phase 3 — Brand side

| Capability | Where |
|---|---|
| Signup endpoint (local implementation, not a deployed public signup claim): rate limited 5/min, creates an `invited` brand, encrypted contact and signed 48 h invite; explicit acceptance establishes only a brand session | `POST /api/portal/signup`, `POST /api/invites/:token/accept` |
| Two-step onboarding: signed preview → explicit accept/resume → advisory URL detection/verified store + complete catalog → optional payout setup or deferral. A clean connected brand may activate independently of product approvals. Brand/session-scoped mutations require CSRF; public preview does not bootstrap owner access. | `/onboard/:token`, `GET /api/onboarding/invites/:token`, `GET /api/onboarding/session`, `/api/onboarding/:brandId…`, `web/BrandOnboarding.jsx` |
| Owner invitations: create, replace/re-send (revokes old link), revoke and safe status UI; stable operations, encrypted replay responses, no automatic resend after pending/uncertain delivery. Private local path copy is not an admin navigation link. | `/api/admin/onboarding/:brandId/invites…`, `web/AdminInvitesPanel.jsx` |
| Invitation email: separate fixed-endpoint Resend adapter, server secret/public HTTPS base and explicit opt-in required; default unconfigured. Provider accepted is not delivered; tests use injected transports, not actual emails. | `server/platform/invite-delivery.mjs`, `AVAFEM_ENABLE_INVITE_EMAIL` (default off) |
| Advisory store discovery: exact hostname hints and optional bounded/public-DNS-pinned JSON probes; default no probes. Unknown/custom domains can choose masked manual Woo/BC credentials or CSV, without claiming verified ownership. | `server/platform/store-discovery.mjs`, `POST …/detect`, `AVAFEM_ENABLE_STORE_DISCOVERY` (default off) |
| New payout step: defer without a bank account while all payables remain held; actual hosted setup is blocked without an injected configured test adapter. No real embedded Express acceptance was verified. Legacy simulated portal link/return routes reject the new two-step flow. | `POST /api/onboarding/:brandId/payouts/skip`, `…/payouts/start` |
| Store connection: WooCommerce (masked consumer key/secret), BigCommerce (masked token + store hash), CSV, or configuration-gated Shopify OAuth. Woo/BC one-click approval is not implemented. Verified credentials are AES‑GCM encrypted; disconnect wipes them. Native certification is still required. | `POST /api/onboarding/:brandId/connect`, `/shopify/authorize`, existing `/api/portal/:brandId/connectors…` |
| Verified display-profile suggestions remain editable and cannot set commercial/approval authority. Native Shopify reads name/contact only under the unchanged fifteen-scope ceiling; logo/refund-policy autofill is unavailable (`read_legal_policies` is not approved). Nothing missing is fabricated. | `GET /api/onboarding/:brandId`, `PATCH …/profile`, `getStoreProfile`, `sanitizeStoreProfile` |
| Connector adapters behind one interface (`verify`, `listProducts`, `createOrder`); default HTTPS transport pins public DNS, rejects redirects and bounds request time/response size; tests inject fake transports and DNS | `server/platform/connectors.mjs` |
| Catalog sync from Woo/BigCommerce and CSV fallback (Avafem columns or Shopify product export) into the core catalog (products land in draft/in_review with validation issues) | `POST …/connectors/:platform/sync`, `POST /api/portal/:brandId/catalog/csv`, `POST /v1/catalog/csv`, MCP `upload_catalog_csv` |
| Independent product curation queue: brand/ID/collection/type/tag/new/changed filters; exact-fingerprint atomic bulk approve/reject, stable operation and reason. Warning/block approvals require a separate exact-content override; changed listings invalidate prior approval/override. | `GET /api/admin/curation`, `POST …/bulk`, `web/CurationPanel.jsx`; individual `POST /api/products/:id/review` shares the gate |
| Trusted-brand initial auto-approval: off by default, audited owner opt-in, one initial import only, clean/valid/non-deleted products only, never flags. Later enabling does not retroactively approve the queue; new re-sync products always need curation. | `PUT /api/admin/curation/brands/:brandId/auto-approve`, `server/platform/curation.mjs` |
| Catalog source reconciliation: immutable source mappings, complete bounded product/variant/image reads for native Shopify callback refresh, delist missing mapped rows only after an error-free complete snapshot. Partial/error snapshots do not infer deletion; unrelated user-managed products are preserved. Price/stock updates can retain review; descriptive/evidence changes re-enter review. | `POST /api/onboarding/:brandId/refresh`, `…/sync`, `importConnectedSnapshot`, core product review fingerprints |
| Brand activation and product approval are separate. Clean connected two-step brands can activate with deferred payouts/unlisted drafts; flagged catalog blocks activation. Legacy operator activation still refuses while its core requirements remain. | `activateConnectedBrand`, `POST /api/portal/:brandId/activate` |
| Push an unowned Bag to the brand's selected Woo/BigCommerce store: durable cross-workflow reservation before one create, replay of verified receipts, no resend after uncertain results; provider-bound/already-mapped Bags are rejected | `POST /api/connectors/orders/:bagId/push` |
| Connector recovery: fresh authoritative readback can confirm an existing matching order or prove an already-cancelled/unfulfilled order. Only verified void authorizes one separate, revalidated retry; leases, frozen snapshots and per-attempt markers fence stale reviewers. | `GET /api/admin/recovery/connectors`, `POST …/connectors/:bagId/resolve`, `POST …/connectors/:bagId/retry` |
| Brand analytics: sales (gross, net, AOV, commission), returns (rate), conversion (swipes, likes, liked→purchased rate, placement impressions/clicks/CTR), top products | `GET /api/brands/:id/analytics`, `GET /v1/analytics`, MCP `get_brand_analytics` |
| Paid placements: `featured_spot` ($25/day), `sponsored_swipe` ($10 per 1,000 impressions), `sampling_box` ($1.50/unit); approved product only; operator approval creates an `invoiced` billing record (`invoice` or `payout_offset`); cancel before start voids it; shopper feed caps sponsored swipes at purchased impressions | `/api/placements…`, `/api/billing…`, `/v1/placements`, `/v1/billing`, MCP `list_placements`, `request_placement` |

Local regressions: `tests/platform-brands.test.mjs`, `platform-onboarding.test.mjs`,
`platform-curation.test.mjs`, `platform-invite-lifecycle.test.mjs`,
`platform-invite-delivery.test.mjs`, `platform-store-discovery.test.mjs`,
`shopify-connections.test.mjs`, plus onboarding/curation UI utilities.
WooCommerce/BigCommerce HTTP and onboarding/email providers are injected mocks;
passing these is not native/public/email acceptance.
Native connector certification is still outstanding. Woo creation lacks product/variation
ID mapping and full shipping/tax authoring; Woo/BC lifecycle readback needs real-store
validation. Woo void recovery requires an authoritative fulfillment endpoint and fails
closed when it is unavailable. A cancellation status alone never authorizes a resend.

## Phase 4 — Commerce + compliance

| Capability | Where |
|---|---|
| Cross-brand subscriptions / auto-replenish: a durable per-cycle attempt claims the work, obtains a canonical read-only quote, and runs a **mocked** charge (`pi_sim_…`). Only confirmed success creates a paid sandbox order, split into per-brand Bags. Known declines create no orders, retry daily, and go `past_due` after 3 failures. Unknown/crashed charge attempts or post-charge persistence failures require operator review and cannot automatically re-charge. Optional cycle alignment requires health consent; ship-to is encrypted. Not integrated with real Stripe subscriptions or hosted unified checkout. | `server/platform/commerce.mjs`, `POST /api/crm/shoppers/:id/subscriptions`, `GET /api/subscriptions`, `POST /api/subscriptions/:id/status`, `GET …/runs`, `POST /api/subscriptions/run`, background worker |
| Simulated renewal recovery: reconcile exact persisted paid evidence without charging again, or explicitly attest an exact simulated declined/voided attempt; guarded future resume/cancel, encrypted original review inputs and server-side continuation after reload. Cancelling future renewals does not resolve uncertain money. | `GET /api/admin/recovery/subscriptions`, `POST …/subscriptions/:id/reconcile`, `/continue`, `/resume`, `/cancel` |
| Shipping-policy simulation: threshold quotes and idempotent per-order subsidy plans show the proposed commission funding/absorbed cost. **No real charge discount or general-ledger subsidy is applied.** Responses explicitly report `appliedToCharge:false` / `ledgerBooked:false`; provider checkout integration is still required. | `GET/PUT /api/shipping/rules`, `POST /api/shipping/quote`, `POST /api/shipping/orders/:orderId/apply`, `GET /api/shipping/subsidies` |
| Health data separation: intake/cycle and health-derived outbox content/campaign linkage use separate purpose-bound encryption; dedupe keys are HMACs. Explicit segment/template/flow field classifications reject unknown fields and health downgrades. Reads require purpose/current consent (except explicit DSAR export) and are audited. Versioned legacy protection runs in bounded startup/background/admin batches using the original key; pre-v2 rows remain redacted, not migrated on the read path. | `server/platform/health.mjs`, `health-classification.mjs`, `GET /api/admin/recovery/health-outbox`, `POST …/health-outbox/migrate`, `GET /api/privacy/shoppers/:id/health-access-log` |
| DSAR export (profile, orders, health, access log, reviews, tickets, messages, Beauty Bank, subscriptions) and erasure (`confirm: "DELETE"`): deletes health and swipes, wipes PII/consent, redacts tickets/outbox, hides reviews and removes them from the brand feed, cancels subscriptions, forfeits open credits (journaled), keeps de-identified orders/Bags for tax and accounting | `POST /api/privacy/shoppers/:id/export`, `POST /api/privacy/shoppers/:id/delete`, `GET /api/privacy/requests` |
| Listing compliance check: rule-based flags for disease claims (verb + condition, e.g. "treats bacterial vaginosis"), drug/regulatory claims ("antibiotic", "FDA approved"), risky claims (warn), supplements missing the DSHEA disclaimer or contraindications, banned/restricted ingredients. **Approval gate:** `POST /api/products/:id/review` with `approved` returns `409 COMPLIANCE_BLOCKED` while blocking flags remain, unless an operator records an override (reason ≥ 10 chars) that is bound to the exact listing content (any edit invalidates it) | `server/platform/compliance.mjs`, `POST /api/compliance/check`, `GET /api/products/:id/compliance`, `POST …/compliance/override`, `GET /api/compliance/brands/:id`, `GET /v1/compliance`, MCP `check_product_compliance`, `get_compliance_report` |

The rule lists are a screening aid, not legal advice; keep a human reviewer and counsel in the loop.

Tests: `tests/platform-commerce.test.mjs`.
Additional coverage: `tests/platform-subscription-recovery.test.mjs`,
`tests/platform-connector-recovery.test.mjs`, `tests/platform-health-production.test.mjs`,
`tests/platform-health-outbox-regressions.test.mjs`, and `web/lib/admin-recovery.test.mjs`.
DSAR message export is unpaginated, but refuses to mark an incomplete legacy-message
export completed; migrate the shopper's pending rows first.

## PR review hardening

Regression coverage includes internal-network/redirect/DNS-rebinding rejection, durable
connector dispatch uncertainty, decline-then-success and concurrent renewal claims,
encrypted/consent-gated health outbox reads, historical erasure cleanup, atomic credit
expiry/reversal, extended return holds, lost-dispute holds and exact partial-refund
allocations. Approved refunds now persist merchandise/shipping/tax/commission components.
Historical partial refunds lacking that evidence return reconciliation flags and null net
figures rather than fabricated allocations. The migration does not contact providers.

Unknown connector/renewal outcomes deliberately remain blocked until guarded admin
reconciliation; there is no blind automatic reset/recharge/resend. Saved renewal
operations can be continued using their original server-side request. Beauty Bank redemption, checkout risk enforcement,
shipping discounts and subscriptions still need explicit provider-backed checkout wiring.
Passing isolated tests does not certify those integrations or production readiness.

## Running locally

```bash
node --version       # Node 24 or newer required
npm ci
npm test && npm run check && npm run build
npm start            # http://127.0.0.1:4317 → "Backend & CRM" in the nav
```

All platform jobs (bounded health-outbox migration, subscription renewals, Beauty Bank maturity/expiry/reversal, restock reminders,
alert scan) run in the existing 5 s background worker and on demand via `POST /api/crm/jobs/run`.

## Real PostgreSQL concurrency job

The workflow defines a separate PostgreSQL 17 service job running
`npm run test:postgres` against independent connection pools and real row locks.
Without `AVAFEM_TEST_POSTGRES_URL`, those tests are skipped; with
`AVAFEM_REQUIRE_POSTGRES=1`, missing configuration is an error. The URL is restricted
to a loopback host, the exact `/avafem_concurrency` test database and no input query
overrides/fragments. Each test creates and removes only its random schema.

At code commit `5e1f2ce`, [the PostgreSQL CI job](https://github.com/thejuw/avafem-brand-connect/actions/runs/39325993741/job/118311870152)
passed **5/5 with zero skips**, including two-worker void→retry authorization
consumption. Providers remain mocked. Docker was unavailable locally; the real-server
result comes from CI, not a PGlite run or skipped file. See [the runbook](admin-recovery.md#validation-and-real-postgresql-ci)
for the dedicated test command and restrictions.

## Needs live credentials / production work (not done here)

* New two-step onboarding: public HTTPS/app configuration and real native installation/invite acceptance verification; real embedded Express (currently unavailable without an adapter). Shopify logo/policy metadata is not available under the approved scopes; do not expand scopes or invent it.
* Stripe: real Express AccountLinks + `account.updated`, real subscription/PaymentIntent charges
  (off-session, SCA), real dispute webhooks (`charge.dispute.*`) feeding `openDispute`, discount
  application of free shipping on the PaymentIntent, 1099-K reconciliation with Stripe's own filings.
* Invitation email: explicitly configure the server-only opt-in/public origin and validate real provider acceptance/delivery separately. Default setup performs no email sends or store probes. CRM email/SMS outbox remains simulated; production messaging needs unsubscribe/STOP handling.
* WooCommerce/BigCommerce: real store credentials, webhooks for order/fulfillment sync back.
* A shopper-facing auth layer (shopper endpoints are operator-only here).
* Legal/tax review of the compliance rule lists, sales-tax nexus/filing, credit (Beauty Bank) escheat rules, and HIPAA/state health-privacy (e.g. WA MHMDA) obligations.

## Brand portal (sandbox)

Open `/brand/login`. Everything below is browser-session + CSRF only; API/OAuth bearer keys are rejected on these routes.

- **Login:** email magic link (single-use, 15 minutes, SHA-256 hashed at rest, newest link supersedes older ones, max 3 per member per 15 minutes, generic responses, IP rate limits) or an optional scrypt password (N=16384, 5 failures lock for 15 minutes). Login destroys any previous session on the browser; logout destroys the server session. Links arrive in the **simulated, AES-GCM encrypted** `brand_auth_outbox`; the owner workspace can read it at `GET /api/admin/brand-auth/outbox` (audit-logged). Tokens travel in the URL fragment (`/brand/login#token=…`), which the page strips immediately. Signed invite links (`/onboard/…`) still work and act as the brand owner.
- **Team roles:** `owner` (all brand scopes + `members:manage`, `credentials:manage`, `reports:read`), `staff` (catalog, orders, fulfilment, refund proposals), `finance` (`payouts:read`, `reports:read`). Role and status are read live on every request; demotion or removal takes effect immediately, removal deletes the member's sessions and links, and the last owner can't be demoted or removed. All changes go to `audit_log` as `member:<id>`.
- **Product status:** `GET /api/brand-portal/products` gives each product's status with validation issues, compliance flags (with the matched phrase and field), reviewer notes and `canResubmit`. `POST …/products/:id/resubmit` moves a draft or *edited* rejected product back to `in_review`. It never approves anything.
- **Statements/reports:** `GET /api/brand-portal/statements?month=YYYY-MM[&format=csv]` and `GET /api/brand-portal/reports/annual?year=YYYY[&format=csv]`, own brand only, finance/owner only. CSV cells are formula-escaped; the connected account ID is not exposed; each download is audit-logged.
- **Dashboard:** `GET /api/brand-portal/dashboard` gives sales vs prior 30 days, swipe→purchase, returns, upcoming payout, top products, listed/in-review counts and placement pricing, with each section included only when the role has its scope.
- **MCP:** `get_product_review_status` (catalog:read), `get_payout_statement` (payouts:read).
