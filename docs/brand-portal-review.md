# Brand portal review checklist

This records the follow-up to PR #1's [brand-portal review comment](https://github.com/thejuw/avafem-brand-connect/pull/1#issuecomment-6279209623). It is implementation evidence, not production acceptance. The test environment remains local-only and sandbox. No real email, DNS changes, provider money movement, public tunnel or deployment is authorized by this checklist.

## Access decisions

- An onboarding invitation is a limited catalog/onboarding capability, **not an identified owner**. It cannot read orders, payouts, statements or API keys, or manage members. An operator provisions the first owner member through the trusted owner workspace. That person must verify their own emailed link before managing the team or credentials. Existing operator brand previews retain operator authority.
- Owner members manage their own brand. Staff can use catalog, order, fulfilment and refund-proposal functions, not store secrets, onboarding settings, team, credentials or financial reports. Finance sees payouts, statements, annual reports and billing, plus their own profile/password. Finance does **not** receive customer/order data, catalog access or aggregate sales/conversion analytics. The portal dashboard omits sections outside the session's scopes.
- Role and membership status are checked live. Membership mutations and credential issuance recheck the actor inside the transaction. The last **active** owner cannot be removed or demoted, even when a second owner is merely invited.
- Public auth and onboarding pages never bootstrap an operator session. Browser routes reject API bearer credentials; API key scopes remain the existing six integration scopes, never team/credential/report administration.

## Security and concurrency

- Magic links contain 32 random bytes, are hashed at rest and expire after 15 minutes. Encrypted mailbox bodies remain sensitive capabilities. Issuance, supersession, consumption and removal use a consistent brand → member → token lock order; each link is single-use. A member generation fence prevents stale login results minting sessions after removal/reinvite or password change.
- Password hashing uses fixed scrypt parameters, not arbitrary persisted cost values. Unknown, ambiguous, locked and known-account attempts perform one KDF. Duplicate-email memberships require an explicit brand ID or an email link; errors remain generic. Fresh transactional checks prevent a delayed hash result clearing a newer lockout or password. This is not a claim of constant network/SQL timing or protection from every enumeration side channel.
- Session rotation deletes the previous browser session, logout deletes server state, cookies are HttpOnly/SameSite=Strict and Secure for a configured HTTPS public origin. Proxy headers are not trusted to infer an origin. Sessions remain fixed at 12 hours; idle timeouts, device controls and CAPTCHA are still future hardening.
- Independent-pool PostgreSQL tests cover member/link races and last-owner invariants. Local embedded tests do not certify real PostgreSQL concurrency; the required hosted PostgreSQL job must pass at the resulting commit.

## Owner API keys

Identified owners can create/revoke their own API keys. The initial response is the only time the secret is returned; storage, audit and idempotency records contain no reusable plaintext key. A repeated operation returns metadata with `secretAvailable:false`, not a cached secret. If the first response is lost, revoke the key and create a replacement with a new operation ID. Other-brand keys are invisible. OAuth-client creation stays operator-only. Keys belong to the brand integration, not their creator: member demotion/removal revokes personal sessions/links but does not silently disable existing integration keys. An owner must revoke those separately when appropriate.

## Email transport: implemented, disabled by default

The encrypted local mailbox remains the default. Its raw-link HTTP route is disabled unless `AVAFEM_ENABLE_AUTH_OUTBOX=true` on a sandbox loopback listener with no public origin; it additionally requires an owner-operations session and loopback request. Do not use this convenience route in production.

The optional portal adapter runs outside the login HTTP request in the platform worker. Server configuration only:

| Variable | Purpose |
| --- | --- |
| `AVAFEM_ENABLE_AUTH_EMAIL=true` | Explicit opt-in to external portal email; leave unset for local-only tests. |
| `PUBLIC_BASE_URL` | Exact HTTPS origin for login links; no paths, credentials, IPs or local/reserved hosts. Public origins disable local owner bootstrap and require existing explicit server secrets. |
| `RESEND_API_KEY` | Server-only provider key; never sent to the browser or saved in the repository. |
| `AVAFEM_AUTH_EMAIL_FROM` | Bare verified sender email address. |
| `AVAFEM_AUTH_EMAIL_DOMAIN_ID` | Provider domain ID matching the sender domain. The key needs read access to domain verification as well as sending access. |

Before dispatch, the adapter reads the provider's domain status and fails closed unless the exact domain has sending enabled, verified SPF and DKIM records, and click tracking disabled. It does not create a domain, set DNS or accept any terms. Every embedded login URL must match the configured origin and exact login path. Requests use fixed HTTPS provider endpoints, no redirects, timeouts and stable provider idempotency keys. See [Resend's domain response](https://resend.com/docs/api-reference/domains/get-domain), [send API](https://resend.com/docs/api-reference/emails/send-email) and [idempotency contract](https://resend.com/docs/dashboard/emails/idempotency-keys).

Expired, superseded and removed-member links are not dispatched. A durable dispatch claim prevents concurrent workers resending. Response loss or a worker crash after claiming requires operator review; it is not automatically retried. Provider acceptance is **not inbox delivery**. Actual domain verification, inbox delivery, bounce handling, retention policy and operational recovery still require configured provider acceptance tests. No real email was sent during this work.

## UI and truthful labels

The portal includes scoped empty/loading/error states, a campaign request flow (not payment or approval), statement preview, owner key controls, focus/label/mobile improvements and bundled fonts. Sandbox transfers/statements are explicitly labelled; annual summaries are not filed tax forms. Outbox copy must not imply an email was delivered.

Inter and Fraunces assets are bundled unmodified from [google/fonts commit 47d54ca1](https://github.com/google/fonts/tree/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl), with their SIL Open Font License files in `web/assets/fonts/`. Portal rendering makes no external font requests.

## Still before production

Run the complete current-head tests/build and required real-PostgreSQL CI job; complete actual email/DNS/delivery acceptance when a domain/provider is authorized; add broader production auth/abuse/retention controls. This work does not close earlier real-checkout subsidy/renewal/risk wiring, signed public webhook/native OAuth acceptance, production Stripe/Shopify approvals, legal/tax review or live money-movement gates.
