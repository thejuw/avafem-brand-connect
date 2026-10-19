# Two-step brand onboarding and product curation

This is an implemented, locally tested foundation—not a public launch or native
provider acceptance result. The new UI is in **Backend & CRM → Brand invites**
(owner), **Connect your brand** (brand session), and **Product curation** (owner).
Signed links open the dedicated `/onboard/:token` screen. The pre-existing
provider-backed three-store checkout is a separate workflow.

## Current checklist status

| Requirement | Current status |
|---|---|
| Expiring signed invitation, explicit acceptance and scoped brand session | Implemented; isolated lifecycle/auth regressions. Preview never bootstraps an owner session. |
| Owner invite create, replace/re-send, revoke and status UI | Implemented; stable operations, safe delivery status and local private-path copy. No actual invitation emails sent in these checks. |
| Step 1: advisory URL detection with CSV fallback | Implemented. Default discovery does no DNS/probe requests; hostname hints are not ownership verification. |
| Native Shopify approval and complete connected-catalog import | Configuration-gated code exists, including callback refresh. Public app/callback installation acceptance remains unverified. |
| WooCommerce/BigCommerce connection | Masked manual store-owned credentials implemented; one-click hosted approval is not implemented. Native-store certification remains outstanding. |
| Verified profile suggestions with later display-field editing | Implemented allowlist. Missing or unavailable metadata stays missing; suggestions are not legal-policy authority. |
| Step 2: defer payout setup without releasing money | Implemented and locally tested. Payouts remain held. |
| Real embedded Stripe Express setup | Unavailable by default. Requires a configured server test adapter; no fabricated AccountLink or success. The UI does not collect bank details or accept provider terms. |
| Separate admin curation, filters, exact-version bulk decisions | Implemented with isolated regressions. Brand activation does not mean its catalog is listed. |
| Default-off trusted-brand initial auto-approval | Implemented, audited opt-in; clean valid initial products only. Never approves flagged products, and never auto-approves new re-sync products. |
| Public native approval, real invitation acceptance/delivery and full production readiness | Still blocked/not certified by local mocks, utility tests or a successful build. |

## 1. Issue and accept an invitation

An authenticated operations owner selects a brand in **Brand invites**. Creating
an invitation can use the saved brand contact or an explicit recipient email.
The result exposes a private **local path**, not an automatic navigation link.
Do not accept it in the operations browser: acceptance replaces that browser's
session with a brand-scoped session. Share only with the intended contact using
a trusted channel. The UI stores no invitation in browser storage and clears
the displayed capability when changing brands, hiding it or leaving the screen.

Owner endpoints:

- `GET /api/admin/onboarding/:brandId/invites` returns safe IDs, expiry/status and delivery capabilities—not saved tokens or message bodies.
- `POST /api/admin/onboarding/:brandId/invites` accepts `{operationId,email?}`.
- `POST /api/admin/onboarding/:brandId/invites/:inviteId/resend` uses the same shape, creates a replacement and revokes the old unaccepted link.
- `POST /api/admin/onboarding/:brandId/invites/:inviteId/revoke` accepts `{}`. Revoking an invite does not terminate an already accepted session.

Keep the same operation ID and identical intent when explicitly retrying an
unconfirmed create/re-send. Replayed/pending/uncertain email operations do not
blindly send again. Changed input requires a different deliberate operation.
Review safe status before replacing an uncertain invitation.

The public preview is `GET /api/onboarding/invites/:token`, returning only brand
identity, expiry and sandbox mode. Explicit sandbox-term acceptance uses
`POST /api/invites/:token/accept`; its returned brand CSRF token is then used for
mutations. A consumed link offers an explicit **Resume an existing brand
session** action through `/api/onboarding/session`. This session-only endpoint
does not create owner access or revive an expired/revoked invite.

## 2. Connect a store and review its profile

The brand enters a public HTTPS **origin**. Detection is advisory. Default local
configuration does not probe the store. An unknown custom domain can explicitly
choose manual WooCommerce/BigCommerce credentials or use CSV; no connector is
inferred from an HTML page or guessed from the brand name.

- Shopify: use the exact `.myshopify.com` host. The explicit approval action can call the fixed same-brand `/shopify/authorize` endpoint. Without server OAuth configuration and a public HTTPS callback, it returns an unavailable blocker. It does not invent a URL, scope grant or connection.
- WooCommerce/BigCommerce: open the manual connection form and enter only credentials for the store you own. Secret fields stay in the form DOM, are not stored in React/browser storage, and are cleared after submission, store/platform change or close. The server verifies and encrypts connector credentials. No one-click approval claim is made.
- CSV: upload/paste up to 3 MB to `/api/onboarding/:brandId/catalog`. The server establishes CSV mode when needed. A complete valid import can finish the store step; it does not bypass product approval.

A connected transport alone is not a completed store step: the UI honors the
server's explicit catalog-completion flag. **Refresh connection status** is a
read-only status GET. **Refresh connected catalog** explicitly calls
`POST /api/onboarding/:brandId/refresh` and may read/import from the configured
provider. Use this bounded refresh to review an incomplete saved OAuth import;
do not reinstall or reset token history just to retry a catalog.

Authenticated metadata is sanitized into editable display fields only: name,
contact, eligible logo and plain-text return policy. It cannot set commission,
return-window promises, shipping charges, account IDs, approval or payout flags.
Human edits survive later profile re-sync. Imported policies remain untrusted
and require human review.

### Shopify permission ceiling and unavailable metadata

The exact existing fifteen-scope allowlist is unchanged:

```text
read_products write_products
read_inventory write_inventory
read_orders write_orders
read_draft_orders write_draft_orders
read_fulfillments write_fulfillments
read_merchant_managed_fulfillment_orders write_merchant_managed_fulfillment_orders
read_shipping read_customers write_customers
```

`getStoreProfile` reads store name/contact and verifies shop identity/USD only.
`read_legal_policies` is **not approved**, so Shopify refund-policy autofill is
unavailable. Logo/branding metadata is also unavailable in this query. Missing
logo/policy fields are not fabricated, scraped or a reason to expand access.
Review and enter supported display fields manually where appropriate.

Native callback refresh exhausts bounded product, variant and image pagination
before calling the complete-snapshot import. Deletion inference is allowed only
after a complete, error-free snapshot, and only for rows mapped to that exact
brand/source/catalog identity. Missing mapped rows are delisted, not physically
deleted. Partial/error snapshots and unrelated user-managed products are not
treated as source deletion.

## 3. Keep brand activation separate from product listing

A clean connected brand may become active while its products remain
`draft`/`in_review`. Missing evidence/tax data is not magically supplied by the
connector. Only approved, current-content, non-deleted products may be purchased
or promoted. The UI's default queue shows draft/in-review rows; choose an explicit
review status to inspect approved/rejected rows.

Owners filter by brand, product IDs, collection, type, tag and new/changed review
state. A bulk decision sends only the displayed selected IDs and their frozen
fingerprints, plus a stable operation ID and a 10–1,000 character reason.
If any fingerprint is stale, the atomic batch fails instead of approving a
different version. Refresh and inspect changed content before a new decision.

Any compliance warning or blocking flag needs its own explicit per-item override
reason of at least ten characters, unless an exact-content override is already
recorded. The shared decision reason alone is not an override. The UI applies
the entered separate override to each flagged selected row. Rule-based screening
is not legal/medical approval, and an override is not provider certification.

**Trusted-brand initial auto-approval** is off by default and owner-only. Its
audited setting can consume one clean initial-import opportunity. It excludes
flags, missing validation and deleted rows; enabling it later does not
retroactively approve the queue. New re-sync products always need curation.
Descriptive/evidence changes withdraw approval; commercial price/quantity updates
can retain an otherwise unchanged reviewed content version.

This initial opportunity is consumed atomically once, even when disabled. It is
bounded to 500 new products from the exact completed import and requires each
persisted product ID **and content fingerprint**. A concurrent/later edit or
missing import proof stays unlisted. Ordinary CSV uploads are partial, never a
deletion snapshot, and the basic parser does not invent ingredient/evidence
fields: passing import validation is not proof that a row can be approved.

## 4. Defer payout setup honestly

**Skip for now** records deferred setup, not successful payout onboarding. The
brand can complete the store step while payouts remain held. Scheduled sandbox
release checks cannot bypass missing verified payout setup. Upcoming held payout
jobs create deduplicated admin/dashboard prompts; they do not claim external
email delivery.

The new flow rejects the legacy portal's simulated Express link/return shortcut.
Without an injected configured test payout adapter, setup remains unavailable.
An eligible future adapter may supply an allowlisted HTTPS hosted provider URL;
the UI refuses simulated results/URLs. Opening a link is not completion, and
`providerVerified:false` is not changed to success by the browser. No real
embedded Express acceptance has been demonstrated by these local checks.

## 5. Email is a separate opt-in capability

Ordinary CRM notifications remain a simulated outbox. Invitation delivery is a
separate server-only Resend transport with a fixed provider endpoint, bounded
response and a stable provider idempotency key. It is disabled by default.

Future external setup requires an operator-approved safe public HTTPS
`PUBLIC_BASE_URL`, server-secret `RESEND_API_KEY`, valid
`AVAFEM_INVITE_EMAIL_FROM`, and explicit `AVAFEM_ENABLE_INVITE_EMAIL=true`.
Do not put any key into a browser, request URL, repository or documentation.
The app refuses public-origin configuration with local owner bootstrap enabled.
`AVAFEM_ENABLE_STORE_DISCOVERY` is an independent, default-off opt-in for bounded
read-only store probes; enabling invitation email does not enable probes.

The UI distinguishes **not configured**, **provider accepted—not delivery
confirmation**, **simulated receipt**, and **uncertain**. Provider acceptance is
not inbox delivery or recipient acceptance. No actual external invitation email,
public branded invite acceptance or native approval was performed by this task.

## Validation boundary

Local regression sources include `tests/platform-onboarding.test.mjs`,
`platform-invite-lifecycle.test.mjs`, `platform-invite-delivery.test.mjs`,
`platform-curation.test.mjs`, `platform-store-discovery.test.mjs`,
`platform-csv-initial-curation.test.mjs`, `platform-shopify-onboarding.test.mjs`,
`shopify-connections.test.mjs`, and the onboarding/curation UI utility tests under
`web/lib/`. Provider fixtures/transports are synthetic; passing them or compiling
the UI does not certify the public/native/email/payout paths above. Keep this
checklist's implemented rows distinct from the blocked acceptance rows.
