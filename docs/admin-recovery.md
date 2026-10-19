# Admin recovery runbook

This is a **sandbox operator runbook, not production or provider certification**.
Open **Backend & CRM → Admin recovery → Recovery desk** in the operations workspace. Brand sessions
and brand bearer/MCP credentials cannot use these recovery tools. Mutations require
the authenticated admin session and CSRF protection; the server supplies the actor.

The desk combines connector orders, simulated renewals, lost disputes, payout holds,
pending credits, financial audit history and health-message migration. Its aggregate
read is `GET /api/admin/recovery`. Refresh before choosing an action. A displayed
record is not permission to bypass a failed server-side gate.

## Common operating rules

1. Use isolated test stores and synthetic shoppers. Do not put credentials, shopper
   details or health information in an operator reason or evidence reference.
2. Record the Bag/subscription, attempt and native order IDs. Determine whether a
   worker or provider request may still be running. Fence the relevant worker before
   investigating an interrupted dispatch; a timeout is not evidence of failure.
3. Supply an operator reason of 10–1,000 characters and keep the stable `operationId`.
   The UI creates one for a new decision and retains it for a same-form retry after
   an error. Changing the decision is a different request, not a retry.
4. After an uncertain response, refresh the case and its recorded history. Do not
   clear reservations, edit statuses in SQL, invent provider evidence or generate
   fresh payment/order IDs to force progress.
5. Review the recorded outcome. HTTP success can contain a blocked or review result;
   it does not certify money recovery, payment, delivery or production readiness.

Recovery reasons and private proof/snapshots are encrypted with purpose-bound keys.
Financial decisions commit their durable resolution record with the accounting/state
transition; HTTP audit entries additionally identify the authenticated caller.
Retrying the same completed decision replays its result. Reusing its ID for different
inputs is rejected.

## Connector order uncertainty

Read `GET /api/admin/recovery/connectors?bagId=…`. A committed dispatch reservation
survives process restarts and local receipt-write failures and excludes a second
Shopify/manual-handoff dispatch. An uncertain create is never automatically resent.

| Action | Meaning |
|---|---|
| Confirm existing order | `POST /api/admin/recovery/connectors/:bagId/resolve` with `action:"confirm"`, the native numeric `externalId`, `operationId` and reason. Performs fresh readback; it does not create another order. |
| Verify already-cancelled order | The same route with `action:"void"`. Verifies prior cancellation and authoritative absence of fulfillment; **does not cancel or refund remotely**. |
| Use authorized retry | A separate explicit `POST /api/admin/recovery/connectors/:bagId/retry`. Allowed only after verified void authorization; it rechecks the old cancellation, consumes that authorization once and reserves a new immutable dispatch attempt before one create. |

Readback must match the original selected store, frozen Bag, dispatch markers, exact
SKU/quantity/line totals, USD currency, address, shipping and tax. Extra discounts,
charges, refunds, changed context or incomplete history block recovery. Concurrent
reviewers use a bounded lease; a lost/expired lease cannot commit a stale proof.
For an interrupted verification, retain the same review ID and original request;
wait for its lease to expire before retrying that verification. A completed blocked
decision is not permission to resend an order.

Provider limitations remain: native Woo creation currently supplies SKU rather than
the required product/variation identity mapping and does not fully author shipping
and tax; BigCommerce authoring and both native lifecycle integrations also require
real-store certification. Woo's authoritative fulfillment endpoint must be available
to verify a void; missing/disabled fulfillment APIs mean **unknown**, not “unfulfilled.”
A real order whose totals or identity do not match must remain blocked. Fake-transport
tests do not establish that native create/recovery succeeds on a real Woo/BC store.
Woo/BC credentials do not themselves prove a store is in test mode: an authorized
retry is a real external order write. The operator must restrict these connections
to isolated test stores; the UI acknowledgement is not a provider live-mode barrier.

## Simulated subscription review

Read `GET /api/admin/recovery/subscriptions?subscriptionId=…`. These are mocked
`sub_sim_…` / `pi_sim_…` renewals, not real Stripe subscriptions or PaymentIntents.
Every attempt is durably claimed before the simulated charger. Unknown/crashed
attempts cannot be recharged automatically.

| Decision | Guarded behavior |
|---|---|
| Reconcile paid | `POST /api/admin/recovery/subscriptions/:id/reconcile`, `resolution:"paid"`. Requires exact persisted, validated simulated-payment evidence and frozen request fingerprint. Repairs/reuses the canonical order without calling the charger. |
| Reconcile declined or voided | The same route with `resolution:"declined"` or `"voided"`. Requires an explicit, fresh `operator_mock_review` attestation bound to the exact attempt, fingerprint and recorded simulated charge reference. This is an operator assertion, **not provider verification**. Known paid evidence cannot be dismissed as declined; a corresponding order must already be fully refunded before void resolution. |
| Resume | `POST /api/admin/recovery/subscriptions/:id/resume`. Only after unresolved attempts/reviews are cleared, with a live shopper/address and non-cancelled subscription. Schedules future work no earlier than one day later; no immediate charge. |
| Cancel | `POST /api/admin/recovery/subscriptions/:id/cancel`. Stops future renewals and interrupts pending review actions. It does **not** settle, refund or resolve an uncertain payment. Review can remain required. |

The UI exposes exact attestation fields, acknowledgements and allowed actions for
each attempt. A `workerFenceRequired` attempt may still be running; do not label it
declined solely because it is old. No “force reset” or unsupported real-charge
resolution is available.

### Continue a saved operation

After reload or interruption, use the case's **Continue saved …** action when a
pending review exists. `POST /api/admin/recovery/subscriptions/:id/continue` accepts
only the saved `operationId`. The server replays its encrypted original request,
reason and proof; the current caller is separately audited. Do not re-enter altered
proof or start a fresh review to replace an in-progress one. Changed eligibility
still fails closed. Continuation does not create a new payment or call the charger.

## Lost disputes, holds and pending credits

These actions are limited to canonical **non-provider-bound sandbox Bags**. They
are not Stripe dispute/refund/transfer APIs. A lost dispute stays `lost`; a recovery
decision is stored separately in `financial_resolutions`.

### Record recovery, then release separately

1. In **Lost disputes**, record `resolution:"operator_verified_recovery"` at
   `POST /api/admin/recovery/disputes/:id/resolve`, with a bounded, non-secret
   `recoveryReference`, reason and operation ID. This records reviewed operator
   evidence only: `cashRecoveredCents:0`, no verified provider recovery and no payout.
2. Refresh **Payout holds**. Release through
   `POST /api/admin/recovery/holds/:id/release` only after all gates pass.
3. Release pending canonical/Beauty Bank credits separately if appropriate through
   `POST /api/admin/recovery/credits/:id/resolve`, `action:"release"`.

Release requires delivery and the latest applicable return hold: at least seven
days, the Bag snapshot, the current brand policy, and any later promised Bag,
transfer, payout-job or LAB-lot maturity timestamp. It cannot shorten those promises.
Proposed/approved refunds or refunded quantities, any other unresolved/open/lost
dispute, unavailable brand/payout configuration, provider-bound data, terminal or
unreconciled payables and payout-job review states block release. Credit release
also respects a still-held payout. A separate `won` dispute cannot silently release
a Bag with lost-dispute history. Row locks and durable idempotency protect concurrent
operators; these routes do not perform a bank payout.

### Writeoff is not a refund or recovered cash

`resolution:"writeoff"` for a lost dispute is an explicit **whole-Bag noncash payable
waiver**, not proof that money was recovered or that the shopper was refunded. It
requires an outstanding unpaid sandbox payable with reconciled accounting; paid,
reversed, partial/refund-review and released/spent-credit cases are rejected.

The transaction cancels the payable and payout job without marking the Bag refunded
or cancelled. It debits `brand_payable` and credits
`sandbox_payable_writeoff_adjustment` under the stable
`admin-payable-writeoff:<bagId>` journal key. No clearing/cash entry or provider refund
is fabricated. Pending canonical credits are voided with a balanced credit journal;
pending purchase LAB lots are forfeited using explicit `written_off` bank events.
The liability report reports `writtenOffCents` separately from expiry breakage.
Later earning cannot recreate LAB credit on that written-off Bag.

A later shopper refund remains a separate reviewed sandbox refund workflow; its
accounting uses the existing writeoff adjustment instead of debiting brand payable
twice. Provider-bound refunds require their separate provider workflow.

For one pending credit only, choose `action:"writeoff"` at the credit-resolution
route. It voids that canonical pending allocation or forfeits that pending LAB lot;
it is not a whole-Bag payable waiver and cannot claw back redeemed/spendable credit.

`GET /api/admin/recovery/credits` shows pending canonical and Beauty Bank entries,
hold reasons and earliest eligibility. `GET /api/admin/recovery/history?bagId=…`
shows decrypted operator reasons to admins only. Keep this history; a resolution
must not be rewritten as a different dispute outcome.

## Health classification and bounded migration

`health-classification.mjs` declares every supported segment rule, template field
and campaign kind as health/non-health with a source. Unknown fields fail closed;
health-derived fields cannot be downgraded. Explicit `health:true` also protects
sensitive static campaigns. Classification is not a substitute for reviewing
freeform text before treating it as non-health.

Health-derived message subject/body/campaign linkage use the health-message key;
dedupe keys are HMACs, not raw cycle dates or segment membership. Current consent
and a declared purpose gate reads, with access logging. Withdrawal redacts ordinary
outbox reads. Normal outbox listing is paginated, default 100 and maximum 500; it
does not run a cleanup migration on the read path.

For legacy data:

1. Stop older writers/workers and preserve the **original application encryption
   key** and a restricted recoverable backup. Do not replace the key to make a
   migration error disappear; that makes historical ciphertext unreadable.
2. Inspect **Health migration** or `GET /api/admin/recovery/health-outbox`.
3. Startup and the background platform job process bounded batches. The admin
   **Protect next batch** action posts `{ "batchSize": 500 }` to
   `/api/admin/recovery/health-outbox/migrate`; permitted batch size is 1–500.
4. Repeat until `pendingRows:0` and `complete:true`. Late rows from old writers are
   detected on subsequent batches. The versioned migration validates its original-key
   verifier and encrypted recipients before rewriting content; wrong-key failures
   leave the batch uncommitted.

Rows below protection version 2 remain redacted until protected. A DSAR export is
not silently paginated, but fails with `HEALTH_MESSAGE_MIGRATION_REQUIRED` while
that shopper still has unmigrated messages instead of recording a partial completed
export. Re-run the export after migration. Erasure also removes encrypted outbox
copies and scrubs ticket/notification subjects and cancelled-subscription addresses.
Encryption migration protects logical rows, not historical WAL, disk images or backups.

## Validation and real PostgreSQL CI

Local regression coverage includes connector reservations/readback/one-use retry,
saved renewal continuation, financial-resolution rollback/idempotency, consent and
migration boundaries, and admin/tenant/CSRF guards. All provider transport in these
tests is mocked. Passing them is not real checkout or provider acceptance.

```bash
node --test --test-concurrency=2 tests/*.test.mjs web/lib/*.test.mjs
npm run check
npm run build
```

At code commit `5e1f2ce`, the complete local suite passed **711 tests, zero failures**
in 278,704.536 ms, with five PostgreSQL cases explicitly skipped locally. Syntax
checks and the frontend build passed. A separate synthetic browser check confirmed
cancellation preserves an unknown-payment review hold and brand sessions cannot see
the admin desk. Focused reruns are not additional tests to add to the full-suite count.

`.github/workflows/test.yml` also defines a PostgreSQL 17 service job, Node 24 and
`npm run test:postgres`. It exercises independent pools and real row locks for
connector dispatch, renewal claims, credit expiry, lost-dispute/release races and
two-worker consumption of a verified void→retry grant. At code commit `5e1f2ce`,
[the real PostgreSQL job](https://github.com/thejuw/avafem-brand-connect/actions/runs/39325993741/job/118311870152)
passed **5/5, zero failures and zero skips**, in 2,169.992 ms. Provider transports
remained mocked; this is database-concurrency evidence, not real-provider acceptance.
Docker was unavailable locally, so this real-server result comes from CI. The normal
suite skips these tests without the dedicated URL; that skip is not a PostgreSQL pass.

For an already provisioned disposable local test database matching the CI service:

```bash
AVAFEM_REQUIRE_POSTGRES=1 \
AVAFEM_TEST_POSTGRES_URL='postgresql://avafem_test:isolated_ci_only@127.0.0.1:5432/avafem_concurrency' \
npm run test:postgres
```

`isolated_ci_only` is the workflow's disposable test password, not an application
credential. The fixture permits only loopback PostgreSQL URLs with the exact
`/avafem_concurrency` database path, no caller-supplied query overrides or fragments.
It creates a randomly named test schema and drops only that exact schema afterward,
closing both worker pools and the control pool. Never point it at an application or
production database. `AVAFEM_REQUIRE_POSTGRES=1` makes missing configuration an error
rather than an unnoticed skip.

Real Stripe subscriptions, risk enforcement in hosted checkout, Beauty Bank redemption
at payment time, actual free-shipping charge/subsidy integration, Woo/BC certification,
external notification delivery and production security/compliance remain separate work.
