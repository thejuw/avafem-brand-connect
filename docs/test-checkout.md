# Local My Store 2 provider test checkout

This is an explicit integration-test path, separate from the original synthetic Bags and ledger. It can create real **test-mode** Stripe and Shopify records; it never charges live cards, fulfills an order, sends receipts, creates a brand transfer or manufactures a sandbox ledger entry as provider evidence.

## Preconditions and fixture boundaries

- Local owner browser session, loopback listener/Host/IP, allowed origin and CSRF protection. These endpoints are not exposed to brand credentials, remote callers or MCP tools.
- My Store 2 only: `i4vd1u-s8.myshopify.com`, USD, exact approved 15-scope policy with no extra grants.
- A verified Stripe test account. Enter the secret through the masked local form; it stays in process memory and must be entered again after restart.
- One active, in-stock, physical Shopify variant, quantity one; total including tax cannot exceed $100. Variant identity, price and stock are checked before payment and again before first Shopify dispatch.
- Synthetic Alex Test shipping details, zero-dollar fixture shipping, no shopper email. No real shopper information is collected by this test panel.
- Actual Stripe Tax calculation, with no fabricated-rate fallback. `txcd_99999999` is the documented **General - Tangible Goods** test-fixture classification, not a legal determination for an Avafem product. Zero tax may reflect missing registrations and does not certify tax configuration.
- Official `pm_card_visa` fixture accepted only by the Stripe adapter's test mode. No raw card numbers or live keys.

## Local API

All responses use `{data: ...}`; summaries never return addresses, provider raw objects, client secrets or API keys.

| Method/path | Action |
| --- | --- |
| `GET /api/test-checkout/options` | Read eligible Shopify variants; no payment or order. |
| `POST /api/test-checkout/quote` with `{variantId}` | Persist an encrypted immutable run, then request an actual Stripe Tax quote. No payment or order. |
| `POST /api/test-checkout/:id/pay` with `{confirmTest:true}` | Revalidate, confirm the frozen amount with test Visa, retrieve and verify payment, then dispatch one Shopify test order. |
| `GET /api/test-checkout` or `GET /api/test-checkout/:id` | Read durable, redacted run status and provider identifiers. |
| `POST /api/test-checkout/:id/reconcile` with `{}` | Continue/reconcile the same run; never mint a replacement payment reference or blindly repeat Shopify creation. |

The payment must match the frozen USD amount, run metadata, transfer group, test mode, successful captured amount and shipping details. The Shopify readback must match the test flags on both order and transaction, paid status, variant/quantity, unit/subtotal/tax/shipping/total, minimal shipping address and stable marker. A failed or ambiguous stage remains visible for review; it is not represented as a successful full checkout.

## Recovery

Run input and private provider mappings are encrypted at rest. Provider writes use stable identifiers; SQL leases and a persistent Shopify dispatch reservation protect concurrent calls. Stripe's idempotency retention is not assumed forever: expired or uncertain runs require reconciliation/review instead of a fresh payment key. After any Shopify creation attempt, reconciliation searches the original marker rather than creating a second order. A payment that succeeded before a later failure remains a partial success and must not be charged again.

The original local dashboard's tax, orders and settlement examples remain synthetic. This provider path does not complete the three-store acceptance matrix, multi-brand splitting, actual shopper checkout, stock decrement, signed webhook delivery, partial fulfillment/refunds, connected-account settlement or nightly ledger reconciliation.

## Actual provider evidence: one-store checkout passed

Historical one-store checkpoint: **`ONE_STORE_PROVIDER_CHECKOUT_PASSED`**. Full three-store acceptance remains **false**; this section preserves the earlier one-store result rather than summarizing the later three-store run. It used account `acct_1U74iIK2dD4gO5zD`, not the current three-store sandbox. At that checkpoint the loaded adapter used API pin `2026-09-30.endive` and **only** `allowed_payment_method_types:['card']`; `automatic_payment_methods` was absent, not enabled alongside it. Stable idempotency references remain fixed within each run. The user supplied the old account's process-memory key through the masked local form.

The current separate three-store target is **The Swarme Co sandbox `acct_1U74iQGgawRtH2qe`**. Its main **2,760-cent** run is **completed** for the local-scope cash lifecycle: one Session/PaymentIntent/charge, three PAID inventory-decrementing Shopify test orders, partial shipments/synthetic test delivery, 648 cents of refunds, verified reversals and three automatically created bank TEST payouts read back as `paid` for **280 / 560 / 840 cents**. Cash/provider/ledger reports matched **143 checks** for the main run and **121 checks** for the separate **812-cent** full-refund/cancellation run. The native Stripe Tax difference remains **50 minus 48 = 2 cents**; the approved separate platform memo now records **2 cents**, leaving **zero unexplained cents**, without changing native Tax, cash, commission or brand payouts. Same-operation replay created no additional memo entries; the full-refund Tax comparison matched 62/62 cents without an entry. Stripe-managed Checkout Tax records cannot be retrieved through the tested Tax API, so the report explicitly uses the source-reviewed, hash-locked dashboard observation plus fresh charge/refund and native Shopify checks—not live Tax API line-item certification. Full acceptance remains false. The isolated app clock, simulated inbox, untested real webhooks/public OAuth and historical one-store boundaries remain explicit in [the current acceptance evidence](acceptance.md). None of these later exercises changes or repeats the historical $1.08 payment documented here.

Stripe Tax was configured through the authenticated Stripe sandbox shell in the exact account `acct_1U74iIK2dD4gO5zD`. Its retrieved settings are `livemode:false`, `status:active`, a **synthetic US/TX/78701 test-fixture head office**, default product tax code `txcd_99999999`, and exclusive tax behavior. Its TX sandbox `state_sales_tax` registration `taxreg_1US8sdK2dD4gO5zDO3BrYpRD` is active. These are test-environment settings only: no KYC, real tax registration, filing service or purchase was performed, and Managed Payments was unchanged. API proof: `../../avafem-stripe-test-tax-active.jpg`. Dashboard proof: `../../avafem-stripe-test-tax-settings.jpg`, showing the Sandbox banner, United States (Texas) head office, General Tangible Goods and No tax included.

### Completed run

Run **`tco_725f77553b6040bfb574755284e6d97a`** was created **2026-10-19T05:22:27.311Z** and completed **2026-10-19T05:22:31.202Z**. Its frozen amount was **100 cents merchandise + 0 shipping + 8 tax = 108 USD cents**.

| Provider record | Actual identifier / observation |
| --- | --- |
| Stripe PaymentIntent | `pi_3US91kK2dD4gO5zD1qtVMhX1` |
| Stripe charge | `ch_3US91kK2dD4gO5zD1cjHIqFP` |
| Stripe Tax calculation | `taxcalc_1US91jK2dD4gO5zDksIaITL8` |
| Stripe Tax transaction | `tax_1US91jK2dD4gO5zDFfpf6cht` |
| Shopify order | `gid://shopify/Order/18956082643131`, **#1002**, test `true`, PAID |
| Independent Shopify readback | Subtotal $1.00, shipping $0, tax $0.08, total $1.08 USD; fixture variant `67745339506875`, quantity 1; synthetic shipping address present; `TEST_DO_NOT_SHIP`; source identifier exactly this run; transaction test `true`, `SALE` / `SUCCESS`. |
| Completed-pay replay | Returned the same PaymentIntent, charge, Tax transaction and Shopify order IDs; no duplicate payment or order created. |

The Shopify order was independently retrieved through `getOrderDetails`, not inferred from local mock data. The original dashboard's synthetic order/ledger was not used as payment evidence. This is limited transport validation with $0 fixture shipping and `BYPASS` inventory, not full shopper checkout. No actual fulfillment, refund, transfer, payout or signed webhook exercise was performed. Do not ship this fixture or submit another payment for the completed run.

Saved screenshots: `../../avafem-test-checkout-success.jpg`, `../../avafem-shopify-test-order-1002.jpg`, and `../../avafem-stripe-test-payment-success.jpg`. Independent Stripe test Payments UI showed **1–1 of 1 results**: one **$1.08 USD Succeeded** Visa ending 4242 payment with PaymentIntent `pi_3US91kK2dD4gO5zD1qtVMhX1` after replay. Shopify UI independently showed #1002 Paid / Test order, $1.08 total, $0.08 tax and DO_NOT_SHIP. The order was deliberately left unfulfilled.

### Preserved earlier attempts and explicit review

| Run / request | Actual result before the successful run |
| --- | --- |
| `tco_f0349eb0f84d44a7bfd9cdcc8bed548a`, `2026-10-19T04:59:13.962Z`, request `req_zyduGtewo2vPDw` | `quote_failed`, `stripe_tax_inactive`; no invented tax, payment or Shopify order. |
| `tco_790b4515f4884f8da5af67d45916ca5e`, `2026-10-19T05:13:09.450Z` | Actual calculation `taxcalc_1US8sjK2dD4gO5zDhgQ0vHF3`, 100 + 0 + 8 = 108 USD cents. Payment request `req_XWyNjGnluwwrsr` returned HTTP 400 because `payment_method_types` is unsupported on Endive. Same-key reconciliation request `req_qyinsGVqKsm1fn` then returned HTTP 400 `idempotency_error` because the corrected parameters differed. No PaymentIntent, charge or Shopify order; the run was not automatically recovered. |
| `tco_f94ebaf06126420cbb73809bfd291687`, `2026-10-19T05:19:27.841Z` | Actual calculation `taxcalc_1US8ypK2dD4gO5zDgoRadg3c`, 100 + 0 + 8 = 108 USD cents. Payment request `req_CSS1dfWVoGUAVl` returned HTTP 400: only one of `allowed_payment_method_types` and `automatic_payment_methods` may be specified. No PaymentIntent, charge or Shopify order; this failed run remains history. |

The operator manually reviewed the actual HTTP 400 results and the empty Stripe test Payments list before explicitly creating the corrected fresh run. The saved no-payment review proof is `../../avafem-stripe-no-payment-before-retry.jpg`. Those reviewed fresh attempts are not an automatic retry/fallback, a changed key for the same failed payment, or permission to ignore an uncertain result. All failed-run records remain preserved. Future ambiguous outcomes still require the same-run reconciliation/review rules above; never blindly replace a payment key.

The final full local suite after removing `automatic_payment_methods` passed **180/180 tests, 0 failures, 88.1 seconds**; `npm run check` passed. The production frontend build passed earlier and the UI was unchanged by this correction. The earlier **29 UI utility tests** were a separate rerun, not a count to add to 180 or real-provider acceptance. Actual provider records establish this one-store result; local test counts do not prove the three-store matrix, refunds, fulfillment, settlement or signed webhooks. Never use live-mode settings or treat a sandbox registration as a real tax registration.

The $1 fixture is product `15426777776315`, variant `67745339506875`, SKU `AVF-CONNECT-TEST-001`, tracked quantity 10. Its zero-channel publication state was confirmed in Shopify admin, not through an extra `read_publications` grant. The helper's publication-verification-required result is intentional under the approved scope ceiling; it must not invent an API publication check or silently broaden access.

Primary references: [Stripe test PaymentMethods](https://docs.stripe.com/testing?testing-method=payment-methods), [Stripe tax codes](https://docs.stripe.com/tax/tax-codes), [Tax Calculation object](https://docs.stripe.com/api/tax/calculations/object), [Shopify orderCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate).
