# Bounded TEST failure workflow

This document describes the implemented source mechanics and a **bounded verified checkpoint**, not a completed failure-acceptance certificate. Local HTTP guards, existing-readback injected guards, three disposable-fixture publication observations, nine catalog scenarios, and seven hosted Checkout failure cases have evidence below. Final disposable-fixture cleanup and GitHub CI remain pending. Do not infer broader provider failure coverage from unit tests, a successful main cash lifecycle, or a shadow fault-injection report. `fullAcceptancePassed` remains false.

Only these existing stores are in scope: My Store 2 (`i4vd1u-s8.myshopify.com`), My Store 4 (`qpsd02-jz.myshopify.com`), and My Store 6 (`ir7112-v1.myshopify.com`), in the fixed approved Stripe TEST sandbox. Every provider-test endpoint requires the local owner browser session; POST requests also require CSRF and their strict confirmation fields. No public dashboard, live charges, new account creation, extra permissions, or external email delivery is authorized by this workflow.

## Four different evidence layers

| Layer | Implemented exercise | What it can demonstrate | What it cannot demonstrate |
| --- | --- | --- | --- |
| Isolated source tests | Mock adapters and separate local test databases | Guard behavior, serialization, replay handling, redaction, and local invariants | An actual provider decline, provider outage, or delivered webhook |
| Actual local HTTP guards | `scripts/local-failure-http-guards.mjs` against fixed loopback port 4317 | Actual running-server authentication, CSRF, Host/Origin, three-brand read isolation, and invalid-signature rejection | Successful provider authentication, a valid signed delivery, or financial failure handling |
| Disposable provider fixtures and hosted failures | Explicit native fixture mutations and seven isolated manual-authorization Checkout cases | Actual provider observations for the exact authorized scenario, once independently recorded | General failure acceptance or permission to capture money, create orders, or modify ordinary catalog products |
| Existing-provider snapshot with injected local faults | `provider-failure-readbacks.mjs` reads existing TEST records, then runs the real money service in an in-memory shadow | Money guards applied to locally corrupted copies of actual readbacks | A real provider returning the injected corruption, a failed real refund/transfer/payout, or a new money lifecycle |

## Local HTTP guard probe

Run explicitly while the owner application is already running:

```sh
node scripts/local-failure-http-guards.mjs
```

The optional URL accepts only `http://127.0.0.1:4317` (with an optional trailing slash). There is no credential or environment-file input. Requests have bounded timeouts, no redirect following, and no proxy/DNS destination selection. Native HTTP deliberately preserves the test Host header.

The script obtains an independent owner session and CSRF token in RAM. It reads only the existing completed three-store run's safe summary to bind the known Bags and brands. It checks unauthenticated requests, absent CSRF on refund/fulfillment/reconciliation routes, rejected Host and Origin, all three tenant-to-owner boundaries, six cross-brand Bag reads, and a synthetic invalid Shopify signature for each exact store. Financial-route denial payloads are intentionally invalid even if an authentication guard regresses, so they cannot authorize a writer. It changes only its own session's selected brand and restores that session to admin in `finally`.

The JSON output is labeled `actual_local_HTTP_not_provider_acceptance`. Case output contains only fixed case IDs, HTTP status, expected status, pass/fail, and allowlisted error codes. Cookies, CSRF values, raw response bodies, shopper data, and provider objects are not printed or saved. A nonzero exit is a failed or incomplete probe, not permission to weaken a guard. Do not run this script in ordinary GitHub CI; CI has no running authenticated provider workspace.

## Dedicated native catalog fixtures

`server/provider-failure-fixtures.mjs` owns a separate disposable product per store, with `AVF-CONNECT-TEST-FAIL-002/004/006` SKUs, fixed $1/$2/$3 prices, physical tracked stock, and DO_NOT_SHIP/disposable ownership tags. It snapshots the actual native baseline, discovers its inventory location through allowed inventory reads, and never adopts an unrelated same-handle product. The existing main checkout products are not mutation targets.

Local-owner routes under `/api/provider-test/failure-fixtures` provide inspect, `prepare`, `mutate`, `restore`, and `cleanup`. Mutations require `confirmTest:true`. Supported catalog scenarios are `price_changed`, `out_of_stock`, and `archived`; checkout-phase mutations are price or stock only. Each scenario must use the saved phase and be verified/restored before another one. An unrelated native change or an uncertain response holds for review; it is not overwritten or blindly retried.

Cleanup is an explicit **native deletion** of the original owned disposable product. It requires every saved phase restored, the exact baseline reverified, and fresh server-side proof that all seven isolated authorizations are closed with no captures or orders. Deletion uncertainty is reconciled by the original product ID, not another delete or replacement creation. A source or unit-test pass is not proof that native restoration, deletion, or channel visibility was verified.

## Seven isolated hosted Checkout failures

`server/provider-failure-checkouts.mjs` has a separate durable database beneath the ignored `.runtime/provider-failure-tests` directory and no timer/main worker. The seven fixed cases are:

- `declined_payment`
- `stock_changed_002`, `stock_changed_004`, `stock_changed_006`
- `price_changed_002`, `price_changed_004`, `price_changed_006`

An explicit owner creates one stable operation per case through `POST /api/provider-test/failure-checkouts` with `{caseId,operationId,confirmTest:true}`. The fixed cart has one dedicated fixture per brand, $6 merchandise plus $1.50 brand shipping and authoritative provider tax, capped at $10 total. Checkout uses manual authorization. The service blocks capture and Shopify order creation even if a race guard fails. A browser test authorization is a real TEST provider action, not a local simulation or a captured payment.

For a price/stock race, establish the original authorization, explicitly mutate only the matching disposable fixture, then request the isolated case's reconciliation. Source logic verifies the native mutation before pre-capture revalidation and cancellation. For a decline, retain the actual declined observation. Safe `get`/`observe` results must prove test identity, zero captured cents, and no captured charge; the isolated local order/Bag/ledger/transfer/refund counts must remain zero. The existing completed main checkout is never a replacement failure-test cart.

Cleanup uses the original Session/PaymentIntent only: an open Session may be explicitly expired; a known uncaptured authorization may be cancelled once. Unknown expiry/cancellation outcomes are read back, not repeated with a fresh identity. An unexpected capture stops the exercise for review; this service does not issue a compensating refund or fabricate cleanup success. Restore the exact fixture baseline before the next case, and retain all seven case histories.

Hosted payment URLs and one-use onboarding/invitation links are private capabilities. Do not put them in documentation, source control, logs, or evidence artifacts. Use nonsecret provider IDs and redacted observations for the final checkpoint.

## Readback fault injection without new funds

An explicit `POST /api/provider-test/failure-readbacks` body `{confirmTest:true}` reads only the existing fixed completed main run. It freshly verifies the approved TEST platform and charge, exact three store bindings/scopes, three successful refunds, three source-bound transfers, three paid connected-account payouts, and native order/refund identities and gross cents. Incomplete, foreign, live, or inconsistent baseline records hold before injection.

The minimum implemented matrix is **21 local cases**: refund amount/currency/live/metadata mismatch, parent-charge live/amount mismatch, and unknown refund-ID hold, for each of the three Bags. The real money service runs against a fresh in-memory PGlite and private cloned runtime. Provider records are cached in RAM; no further actual provider call is needed for an injected case. Undeclared provider methods throw and increment a forbidden-writer counter. The main runtime's `withRun` is never invoked.

Refund mismatches must produce `STRIPE_REFUND_MISMATCH`; a previously started refund without its ID must remain `refund_uncertain` without a new create. Main decoded-run and canonical financial-row hashes are compared before/after. Only a minimal encrypted result report is added to the main database. It is retrievable through `GET /api/provider-test/failure-readbacks/:reportId`.

The source label is `real_provider_snapshot_with_local_injected_fault`, with `realProviderFailureExecuted:false`. Transfer and payout fault injection are explicitly unsupported by this minimum matrix; reading their successful baseline records does not test their failure behavior. A passing report proves neither a real failed refund nor comprehensive negative-balance/provider-outage behavior. No raw provider objects, notes, addresses, credentials, or customer data belong in the public report.

## Source checks and publication boundaries

Run isolated tests using bounded concurrency, then syntax/build checks:

```sh
node --test --test-concurrency=2 tests/*.test.mjs web/lib/*.test.mjs
npm run check
npm run build
```

GitHub CI runs only locked dependency installation, these isolated tests, checks, and build on Node 24. It must not start the provider runtime, load provider keys, prepare/mutate/delete fixtures, open Checkout, run the actual HTTP guard probe, or deploy. The destination is the private [thejuw/avafem-brand-connect](https://github.com/thejuw/avafem-brand-connect) repository. Inspect [Actions](https://github.com/thejuw/avafem-brand-connect/actions/workflows/test.yml) for the independent result of the source revision being reviewed; a local pass is not a CI run.

Publish only reviewed source/configuration/examples/tests/docs, the lockfile, and the immutable redacted Tax observation required by its SHA-bound source/tests. Exclude `.runtime/` (including the failure-test database), private environment overrides, credentials, screenshots, database exports, logs, reports with raw payloads, and parent-directory archives. The Tax snapshot's frozen-observation limits remain separate from cash reconciliation and this failure workflow.

## Actual-result checkpoint — partially verified

Only the confirmed evidence below is marked complete. Pending scenarios must not be replaced with a source-test count or the earlier main cash-lifecycle result. Publication observations are Shopify admin UI evidence, not a publication API audit or proof of catalog restoration/deletion.

| Exercise | Actual final status | Safe evidence / remaining requirement |
| --- | --- | --- |
| Current local HTTP guard run | PASS — 30/30 | [Actual local HTTP report](evidence/local-http-failures-20261019.json): denied authentication/CSRF/Host/Origin/tenant/signature requests, six cross-brand Bag denials without response data, and independent-session admin restoration. Not provider acceptance. |
| Disposable-fixture publication | OBSERVED — all three unpublished before testing | [Shopify admin UI observations](evidence/disposable-fixture-publications-20261019.json) for the exact three dedicated fixtures. Final deletion is recorded separately below. |
| Three-store catalog failure scenarios | PASS — 9/9 | [Actual native catalog report](evidence/provider-catalog-failures-20261019.json): three stores exercised price, stock, and archive scenarios; all three native baselines restored. This does not certify final fixture deletion. |
| Declined hosted payment | PASS — 1/1 | [Hosted failure report](evidence/hosted-checkout-failures-20261019.json): actual decline retained, disposable Session expired, PaymentIntent cancelled, zero captured cents and no orders. |
| Six price/stock race cases | PASS — 6/6 | [Hosted failure report](evidence/hosted-checkout-failures-20261019.json): native post-authorization stock/price mutations verified for each store, original authorizations cancelled before capture, and fixture baselines restored. Across all seven cases: zero captured cents, orders, ledger journals, transfers, and refunds. |
| Final disposable-fixture cleanup | PASS — 3/3 | [Native cleanup report](evidence/disposable-fixture-cleanup-20261019.json): one permanent deletion per disposable product, original GIDs absent, cleanup replays zero writes, same canonical IDs unavailable/draft with zero stock, original products and checkout history unchanged. |
| Existing-readback injected guards | PASS — 21/21 local injections | [Readback failure report](evidence/provider-readback-failures-20261019.json): 17 actual baseline reads, zero provider mutations/forbidden writer attempts, unchanged decoded main run and canonical financial rows. Source remains `real_provider_snapshot_with_local_injected_fault`; no real failed refund was induced. |
| Fresh full isolated suite | PASS — 565/565, zero failures | Operator-confirmed current-source run: 267,991.324 ms; syntax checks and production build passed (261 ms; existing lucide directive warning only). Isolated tests are not provider acceptance. |
| GitHub CI | CHECK ACTIONS FOR THE COMMIT | [Independent isolated-tests/build workflow](https://github.com/thejuw/avafem-brand-connect/actions/workflows/test.yml); a local suite/build pass is not a GitHub CI run. No provider credentials or provider exercises run in CI. |

Provider outages, actual provider HTTP 429 responses, negative connected-account balances, and bank payout failures were **not induced** in these bounded exercises. Mock and shadow coverage for such guards must remain labeled separately; the successful decline/race/catalog cases are not evidence of those provider failures.

Even after these bounded checks pass, preserve `fullAcceptancePassed:false` unless the separate acceptance matrix is independently satisfied. Local-only polling, simulated notices, synthetic test-delivery observations, an accelerated app clock, and a frozen Tax dashboard snapshot must not become claims of real webhook delivery, external email, carrier confirmation, elapsed provider time, live Tax API audit, or production readiness.
