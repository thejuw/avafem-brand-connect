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
