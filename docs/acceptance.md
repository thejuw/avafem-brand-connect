# Avafem provider acceptance gate

The current acceptance target is **the exact three Shopify stores My Store 2, My Store 4, and My Store 6, in test mode**. The user explicitly authorized these stores after My Store 4 and My Store 6 were observed on trial plans. This supersedes both the earlier four-store target and the development-store-only condition. A store may be `development` or `trial`, but every manifest store must explicitly declare `testMode:true`. Each needs its own verified connection and a distinct catalog. Do not substitute other domains or three local brand fixtures.

The commission policy to exercise is **15% of merchandise**, excluding shipping and tax. Use integer cents and the agreed rounding/allocation policy. New brands default to a **30-day return window**. Transfers and Beauty Bank credits remain held through the configured return window after confirmed delivery, subject to risk/refund holds and a minimum seven-day release delay. Release must honor the longer of the Bag’s snapshotted window and the brand’s current window; a later policy change must not shorten an existing hold. Verify authoritative eligibility timestamps before exercising transfers.

## Current status: acceptance incomplete

All three exact stores now have actual installed apps, separately verified owner-controlled client-credentials authentication, exactly fifteen approved scopes, and complete distinct catalog imports. Re-sync preserved canonical IDs and product counts. These owner-controlled installs do not certify public OAuth, reinstall/uninstall behavior or the payment-to-payout acceptance matrix. Automated test counts are regression coverage, not provider acceptance.

The store identities currently in scope are:

| Store | Domain | Evidence status |
| --- | --- | --- |
| My Store 2 | `i4vd1u-s8.myshopify.com` | Installation `1071819129019`, exact scopes verified; 17 products, 45 variants, 40 images imported; repeat-sync IDs/count stable. |
| My Store 4 | `qpsd02-jz.myshopify.com` | Connector 4 installed (`1071856779451`); encrypted app credentials; exact scopes; 9 products, 97 variants, 23 images; repeat-sync IDs/count stable. |
| My Store 6 | `ir7112-v1.myshopify.com` | Connector 6 installed (`1072153133274`); encrypted app credentials; exact scopes; 9 products, 9 variants, 21 images; repeat-sync IDs/count stable. |

Actual setup/catalog evidence is saved in `../../avafem-three-store-test-status.json`. Store 4/6 physical tracked fixtures were created at $2/$3 with ten units each and deny-overselling policy. Shopify admin independently showed zero sales-channel publications on both. The local-scope actual TEST cash lifecycle is complete, with the milestones below. The approved separate platform rounding memo is now recorded; the raw native difference remains visible. The full acceptance matrix and live automated native Tax audit remain incomplete. The schema-only acceptance harness still does not execute or authenticate provider workflows.

The current approved target is **The Swarme Co sandbox `acct_1U74iQGgawRtH2qe`**. Main unified run **`uco_33e3eed7612b443d82655b1a4e07bb55`** is **`completed`** for its actual TEST cash lifecycle. It captured **2,760 USD cents: 2,400 merchandise + 150 shipping + 210 tax**. Its single actual hosted Session is **`cs_test_b1PyFuaCcFk2R7we8h20eOUrH2KT06JlpBb0pE2CpNgMi42pQQtYTxc3r8`**, linked to one PaymentIntent and one charge, with exactly three PAID Shopify test orders and verified stock decrement. All three actual Accounts v2 Express recipients exist. This is not full acceptance or production certification. The old platform's rejected request and retired unpaid run remain preserved/archived; explicit operator-reviewed revisions are not automatic recovery of unknown results. The earlier $1.08 payment remains untouched in its original account.

Final main lifecycle evidence: all three stores completed partial shipments and synthetic Shopify test-delivery observations. Store 4 shipped its non-refunded three units as **2 + 1** after its pre-transfer **216-cent refund**. Store 2 and Store 6 then completed post-transfer partial refunds of **108 / 324 cents**, with verified brand-share reversals. Total main refunds are **648 cents**. Six simulated inbox receipts were recorded; they are not external email delivery or independent carrier confirmation.

At **07:53:57Z**, the actual worker reported **`return_window_or_delivery_hold`** with **zero transfers and zero payouts**. The authorized isolated logical clock was **`2026-11-19T07:53:14.811Z`**; Stripe/Shopify/provider-calendar time was not advanced. Once eligibility and the immutable refund gates passed, the worker automatically created **three transfers and three bank TEST payouts**, all read back as **`paid`**. **No manual settle or payout calls were used.** Commission remained 15% of merchandise, excluding shipping and tax.

| Store | Actual transfer / original cents | Actual brand-share reversal / cents | Actual bank TEST payout / paid cents |
| --- | --- | --- | --- |
| My Store 2 | `tr_3USAv7GgawRtH2qe16tIRXO9` / 365 | `trr_1USBQ3GgawRtH2qeyTJmtamG` / 85 | `po_1USBQjGgawz0MSE0GxfcIYYZ` / 280 |
| My Store 4 | `tr_3USAv7GgawRtH2qe1T49pHaG` / 560 | None: its 170-cent brand share was removed before transfer | `po_1USBPeGgawwUsJW3bAwipcRa` / 560 |
| My Store 6 | `tr_3USAv7GgawRtH2qe1vR5GhsS` / 1,095 | `trr_1USBQAGgawRtH2qekethPMBY` / 255 | `po_1USBQtGgawlTKRdHWbX7RhRU` / 840 |

Opt-in policy **`autopol_7f2fac4f30adf9eed9e7c70ce0393d7c`** completed at **07:56:36.173Z** and disabled itself. Main cash/provider/ledger reconciliation **`recon_64aae944ed0d9366bcb17193c9239f7b`** matched **143 checks**, `lifecycleComplete:true`, **0 mismatches / 0 pending gaps**, including a fresh readback after the platform memo. Those zero-gap cash/ledger checks do **not** certify native Stripe Tax allocation; the independent two-cent difference below is preserved and separately recognized.

Separate actual cancellation/full-refund run **`uco_240916a4109e44c38252610a5df298e9`** captured **812 cents** and is now **cancelled**. All three `cancellationVerified` values are true and cancellation operations are complete; actual full refunds **135 + 271 + 406 = 812 cents** completed. Cash/provider/ledger reconciliation **`recon_8b56cad2df82417b6f00954f3b551d50`** matched **121 checks**, `lifecycleComplete:true`, **0 mismatches / 0 pending gaps**. Those checks establish the observed cancellation/refund cash lifecycle; they do not certify the original full matrix or independent native Tax-report allocation.

### Explicit native Tax variance and separate platform rounding

Stripe Dashboard's actual main-run original Tax transaction is **`tax_1USAj4GgawRtH2qeH9YkSEiB`**, gross **2,760 cents**, tax **210 cents**. Its final actual refund auto-reversals show:

| Store / actual refund | Native Stripe Tax reversal | Refund cash cents | Stripe reversed tax cents | Shopify/local refund tax cents |
| --- | --- | --- | --- | --- |
| Store 2: `re_3USAv7GgawRtH2qe1owmCQTe` | `tax_1USBQAGgawRtH2qeKycbJDVG` | 108 | 8 | 8 |
| Store 4: `re_3USAv7GgawRtH2qe1A8pH2lb` | `tax_1USBAwGgawRtH2qeXgeFonTn` | 216 | 17 | 16 |
| Store 6: `re_3USAv7GgawRtH2qe12pXL48s` | `tax_1USBQHGgawRtH2qe8W58X6FM` | 324 | 25 | 24 |
| Total | Actual native reversals, not custom transactions | 648 | **50** | **48** |

The refund cash difference is zero; the raw refund-tax magnitude difference remains **+2 cents**. With explicit approval, **`taxrecon_4cf6901d08ce41dd98b3286f291aaab9`** recorded exactly two 1-cent balanced platform memo/control entries under `shopify_native_platform_rounding_test_v1`. Recorded variance is **+2 cents** and remaining unexplained variance is **0 cents**. Exact replay **`taxrecon_0e04808055954faf94218a6cca07b80b`** created **zero** additional entries. The secondary full-refund report **`taxrecon_b28d68d80cd34eaab13992efb80fa483`** matched **62 / 62 cents** with no rounding entry.

This is **not a native Tax correction or a live Tax API audit**. Actual API request **`req_gMJ6t3iRmPV37p`** returned HTTP 404 because the original Checkout Tax transaction is Stripe-managed; the API accepts only caller-created Tax transactions for this operation. The authenticated Tax dashboard was freshly observed at **2026-10-19T08:27:23Z**. Its exact transaction links, payment/refund references and integer amounts are frozen in `evidence/stripe-managed-tax-observation-20261019.json`, SHA256 **`9744e5a86466ba174409d1b4ab43c20a519cde7c84466091e64f7e7ecca86b90`**. The app accepts that single source-reviewed artifact for these two existing runs only, retains honest unavailable API checks, and verifies current charge/refund and native Shopify evidence. It does not fabricate Tax line items or native reversal-parent proof; the parent chain is established through the exact refund → charge/PaymentIntent → dashboard Tax reference. Snapshot age over 24 hours requires review and fresh observation, not an automatic pass.

No core cash, tax-payable, commission, shopper refund, brand recovery, transfer or payout amount changed. No new payment, refund or custom Tax reversal was created. **`fullAcceptancePassed:false` remains**, including dashboard-only Tax evidence, public OAuth/webhook gaps and the original local-only exclusions. Detailed current proof is in `../../avafem-tax-rounding-reconciliation.json`.

### Scope and implementation boundaries

TEST settlement/payout automation is implemented but **manual by default**. Enabling it requires a per-run immutable owner-approved policy bound to the exact platform/recipients and named post-transfer refund gates. Eligibility, hold and policy checks execute inside the money lease; payout gates require actual matching Stripe refund, Shopify refund bookkeeping and verified brand-share reversal evidence. It never automatically ships, initiates new refunds, advances the app clock or sends email. Unknown outcomes remain held. Provider payout credit-release markers have zero value; they do not demonstrate earned Beauty Bank credit or spending.

**Actual setup progress, October 18, 2026 (America/Chicago):** Bogus Gateway was activated and the provider page's **Active** state was verified in Chrome on all three exact stores. My Store 2 was subsequently updated to version `avafem-test-v2-exact-scopes` and reauthorized through the install/update-access flow. Fresh API preflight verified exactly the 15 approved scopes, no missing or extra grants, and removal of `read_locations`. Existing test-order address/email read access also passed without printing those fields. Screenshots and a redacted permission-verification record are saved in the task outputs. These settings/access checks are not evidence of a Stripe-paid order or a passed checkout scenario.

The user explicitly chose **local-only testing** and declined a public webhook tunnel. No tunnel was started or tunnel software installed. Local polling can reconcile provider records; real webhook delivery and public OAuth callbacks remain untested by that choice. Shipping notices use the approved simulated inbox, not actual email delivery. Return-window testing may use an isolated app clock; it does not advance Stripe/Shopify time. Stripe keys remain server-memory-only and clear on restart. The earlier single-store path is documented in [test-checkout.md](test-checkout.md); it does not substitute for this matrix.

**Historical one-store checkpoint: `ONE_STORE_PROVIDER_CHECKOUT_PASSED`; full three-store acceptance remains false despite the completed local-scope cash lifecycle.** The API remains `2026-09-30.endive`, with `allowed_payment_method_types:['card']` and no `automatic_payment_methods`. The unified path uses one hosted Checkout Session, native Checkout tax, manual capture after fresh stock validation, and inventory-decrementing Shopify orders. Native Checkout tax is not duplicated with a second custom Tax transaction. Final current-source verification including separate platform memo reconciliation and dashboard-source limitations passed **524/524 tests, 0 failures, in 283.764 seconds**; `npm run check` passed and the production build passed in **554 ms**. Previous 358/463/469/514-test runs and focused reruns are historical, not counts to add to 524. Real-SDK/offline-HTTP coverage includes the exact colon-delimited frozen cart reference format; mocked tests alone had not exposed that integration validation bug. Local transport/serialization tests are not provider acceptance.

Historical one-store tax evidence belongs to **old account `acct_1U74iIK2dD4gO5zD`**, not the current three-store target. Stripe Tax was active in its test environment (`livemode:false`). Its synthetic US/TX/78701 head-office fixture, `txcd_99999999` exclusive tax, and TX sandbox `state_sales_tax` registration `taxreg_1US8sdK2dD4gO5zDO3BrYpRD` were configured through the authenticated Stripe sandbox shell. No KYC, real tax registration, filing or purchase was performed; Managed Payments was unchanged. API proof is `../../avafem-stripe-test-tax-active.jpg`; Dashboard proof `../../avafem-stripe-test-tax-settings.jpg` shows the Sandbox banner, United States (Texas) head office, General Tangible Goods and No tax included. Current-target tax evidence must be captured separately rather than inferred from these artifacts.

Actual successful run **`tco_725f77553b6040bfb574755284e6d97a`**, created **2026-10-19T05:22:27.311Z**, completed **05:22:31.202Z**, paid **100 cents merchandise + 0 shipping + 8 tax = 108 USD cents**. Its actual PaymentIntent is `pi_3US91kK2dD4gO5zD1qtVMhX1`, charge `ch_3US91kK2dD4gO5zD1cjHIqFP`, calculation `taxcalc_1US91jK2dD4gO5zDksIaITL8`, and Tax transaction `tax_1US91jK2dD4gO5zDFfpf6cht`. Shopify order **#1002**, `gid://shopify/Order/18956082643131`, independently read back as test and PAID, with one exact fixture variant, quantity 1, matching subtotal/tax/shipping/total, synthetic shipping address present, `TEST_DO_NOT_SHIP`, exact run source identifier, and test `SALE` / `SUCCESS` transaction. Replaying the completed pay endpoint returned the same provider IDs without a duplicate payment or order.

Earlier runs remain preserved, not automatically recovered: `tco_f0349eb0f84d44a7bfd9cdcc8bed548a` / `req_zyduGtewo2vPDw` failed at Tax activation; `tco_790b4515f4884f8da5af67d45916ca5e` / `req_XWyNjGnluwwrsr` returned unsupported-parameter HTTP 400, then `req_qyinsGVqKsm1fn` returned HTTP 400 `idempotency_error` for differing parameters; fresh reviewed run `tco_f94ebaf06126420cbb73809bfd291687` / `req_CSS1dfWVoGUAVl` returned HTTP 400 for mutually exclusive allowed/automatic method parameters. None created a payment or order. The operator reviewed provider failures and the empty Stripe test Payments list before the final explicit fresh run; no blind retry or automatic failed-run recovery is claimed. Review proof is `../../avafem-stripe-no-payment-before-retry.jpg`.

The successful $0-shipping, `BYPASS`-inventory test demonstrates limited one-store transport, not full shopper checkout or A03's three-store split. No actual fulfillment, refund, transfer, payout or signed webhook exercise was performed. Saved proof is `../../avafem-test-checkout-success.jpg`, `../../avafem-shopify-test-order-1002.jpg` and `../../avafem-stripe-test-payment-success.jpg`. Independent Stripe test Payments UI showed **1–1 of 1 results**, the single $1.08 USD Succeeded Visa 4242 payment with the same PaymentIntent after replay. Shopify UI showed Paid / Test order #1002, $1.08 total and $0.08 tax, DO_NOT_SHIP, deliberately left unfulfilled. Final full regression after the parameter correction passed **180/180, 0 failures, 88.1 seconds**, and `npm run check` passed; the earlier production build passed with unchanged UI. The earlier 29 UI utility tests are a separate rerun, not additional acceptance. No full matrix scenario is promoted to PASS by this one-store result or by local checks. See [the detailed provider evidence and recovery notes](test-checkout.md).

The following are prerequisites or evidence gaps, not completed acceptance results:

- The exact three authorized store identities with explicit test mode, installations, and isolated brand mappings; verified OAuth/token rotation, reinstall, and uninstall behavior for each. Trial plans are permitted by the user’s clarified scope; live payment mode is not.
- The native Tax allocation variance remains **two cents**, with an approved separate two-cent platform memo and zero unexplained cents. The frozen dashboard snapshot is not live automated Tax API verification or filing/accounting certification. Local `acct_sandbox_…` records or balanced synthetic ledger entries never substitute for provider records. Real signed webhook delivery is an original-matrix requirement deferred by the user's local-only choice, not silently passed by polling.
- Product-specific authoritative tax lines, address validation, three catalog captures, and stock/variant mappings. Imported products missing evidence or tax codes remain drafts. Untracked inventory must not be invented.
- The original matrix's external shopper-notice delivery, real webhook-driven bidirectional convergence and carrier evidence remain outside the approved local test. The actual partial shipments, refunds, cancellations, reversals, payouts and cash reports above are bounded local-scope evidence; simulated inbox receipts and controlled delivery observations do not certify the external delivery requirements or every failure subcase.
- Demonstrated encrypted OAuth credentials and shopper PII at rest, restricted backup access, tenant boundaries, and redacted logs. One secret stored in a local Keychain is not evidence for every persisted field or brand token.
- Confirmed commission, shipping, tax, return, credit-clawback, and hold policies. A local clock advance or a fabricated provider response does not prove a real delayed transfer.

## Read-only preflight

From the project directory:

```sh
node scripts/acceptance-preflight.mjs --check
node scripts/acceptance-preflight.mjs --schema
node --test tests/acceptance-preflight.test.mjs
```

Only two environment variables are read:

| Variable | Required value |
| --- | --- |
| `AVAFEM_ACCEPTANCE_STORES` | Exactly `i4vd1u-s8.myshopify.com,qpsd02-jz.myshopify.com,ir7112-v1.myshopify.com` (order may vary). URLs, duplicates, other domains, and four-store configurations are rejected. |
| `AVAFEM_ACCEPTANCE_EVIDENCE` | Path to the declared evidence JSON manifest. Artifact paths are relative to that manifest’s directory. |

No credential environment variables are read. The tool opens the explicitly supplied manifest and checks artifact-file existence and metadata. It does **not** open artifact contents, compute their hashes, authenticate signatures, fetch catalogs, retrieve provider IDs, verify declared observations, or execute any provider scenario. Artifact hashes, capture provenance, store kind/test-mode declarations, and provider identity remain unverified by this tool. UI confirmation and test-mode authorization do not turn these declarations into acceptance results.

| Result / exit | Meaning |
| --- | --- |
| `BLOCKED` / `2` | Required configuration, scenario declarations, provider-reference formats, or artifact files are missing/invalid. No provider execution occurred. |
| `NOT_RUN` / `3` | Declared evidence is structurally complete. No provider execution or independent evidence verification occurred. This is deliberately not a successful acceptance exit. |
| `--schema`, `--help` / `0` | Prints documentation only. This is not an acceptance result. |

Every check report states `acceptancePassed:false`, `liveProviderScenariosExecuted:0`, `externalRequests:0`, and `externalMutations:0`. The CLI has no `--run` option and never reports `PASS`. A future live runner must be a separately authorized workflow; do not change this validator to award acceptance from manifest booleans or matching ID prefixes.

## Acceptance matrix

Execute the real provider workflow across all three stores and preserve redacted provider responses, signed webhook records, application audit traces, ledger exports, and scenario timestamps. Each category must link actual provider record IDs to its captured artifacts and store domains. The validator checks declared completeness only; a reviewer must still authenticate the captures against the providers.

This original full matrix is retained rather than weakened to match the local run. A separate local-scope result must explicitly identify polling instead of real webhook delivery, owner client-credentials installs instead of public OAuth certification, simulated inbox notices instead of external email, and the isolated app return-window clock instead of elapsed provider/calendar time. Those substitutions are user-authorized test boundaries, not evidence that the corresponding original matrix conditions passed.

| ID | Required exercise and acceptance condition | Minimum evidence categories |
| --- | --- | --- |
| A01 | Install on all three stores. Obtain the correct offline authorization; show encrypted token storage without exposing a token. Reinstall rotates credentials/mappings safely. Uninstall pauses listings and new checkouts, leaves open Bags fulfillable through one fallback channel, and preserves eligible delivered-order release. | Actual app-installation IDs per store; installation/reinstall/uninstall responses and signed webhook captures; encryption/access review. |
| A02 | Fetch genuinely distinct catalogs from all three stores. Match every variant, price, currency, tracked quantity, and stock policy. Exercise create/update/delete and inventory changes. Product deletion stops new sales. Claim edits require review. A full resync repairs a deliberately missed webhook without duplicating products. | Real product IDs and webhook delivery IDs per store; canonical catalog captures/fingerprints; resync comparison. |
| A03 | Complete a real Stripe **test-mode paid checkout** containing products from all three stores. Verify the signed payment event. Create exactly one Shopify order per Bag with the correct allow-listed address, line quantities/prices, brand flat shipping, authoritative tax, and order/Bag references. Shopper/Bag/provider totals must agree to the cent; no health/cycle data travels to a brand. | `cs_test_…`, `pi_…`, `ch_…`, `evt_…`, and actual Shopify order IDs for all stores; payment webhook; order responses; ledger. |
| A04 | Allocate 15% merchandise commission using the chosen rounding policy; do not commission tax or shipping. Tie each charge and brand transfer through the correct `transfer_group` and `source_transaction`. Show no transfer before confirmed delivery plus the configured return window and no release while held. After eligibility, verify actual Stripe test transfers and credit release. Distinguish transfers into a connected balance from bank payouts. | Charge and Shopify order IDs, `tr_…`, `txn_…`, provider timestamps, configuration snapshot, ledger and reconciliation. |
| A05 | Partially ship individual items through the brand’s real workflow. Keep remaining quantities open. Sync each tracking update and complete the Bag only when quantities reconcile. Deliver the actual shopper notice through the chosen provider; duplicate webhooks must not create duplicate notices. | Shopify fulfillment IDs and delivery IDs; fulfillment payloads; actual email-provider delivery receipt. A local inbox row is not a delivered email. |
| A06 | Exercise full **and partial** refunds and cancellation initiated from either Avafem or the brand store. Match the selected item/tax/shipping/commission rounding policy. Verify actual Stripe refunds and transfer reversals, including negative-balance/reversal failure handling. Credits adjust according to policy, and a replay cannot double-refund or double-fulfill. | Shopify order/refund IDs; `re_…`, `trr_…`, `evt_…`; bidirectional webhook traces; refund/reversal responses; ledger and reconciliation. |
| A07 | Reject bad HMACs, accept valid raw-body HMACs, and converge under duplicates and out-of-order delivery. Reusing an idempotency key replays one result; a different body with the same key is rejected. Transfer retry must never send money twice. Exercise throttling/backoff and ambiguous Shopify order-creation outcomes without a second fulfillment instruction. | Actual Shopify webhook delivery IDs, Stripe events and transfer IDs; raw-body signature verification records with secrets removed; request/attempt traces and provider responses. |
| A08 | Run the real nightly reconciliation worker across all three stores. Compare catalog, open orders, tracking, Stripe charges/fees/refunds/transfers, and ledger journals. Recover a lost event without duplicate writes or money movement. Every journal balances and the external net difference is **zero cents**; unexplained residuals block release. | Actual Shopify order and Stripe balance-transaction IDs; provider captures; ledger export; timestamped reconciliation report and job logs. |
| A09 | Deny cross-brand access through browser sessions, direct API, MCP, and links. A handoff is restricted to one Bag, expires, can be consumed once, and never bootstraps operations access. Verify the minimal PII allow-list; encrypted PII/tokens and backups; restricted access and log redaction; no health data in brand/agent payloads. | Provider-linked order/charge samples; cross-tenant request results; storage/key/access review; redacted application and backup audit evidence. Never include actual credentials or shopper records in this manifest. |
| A10 | Exercise out-of-stock, malformed address, unsupported currency, absent/invalid tax, paused/disconnected brands, and the applicable order/API limits of each actual store type. The development-store five-orders-per-minute constraint applies only where relevant; do not present it as a verified trial-store limit. Stop invalid new orders before charge/push, preserve safe handling of existing Bags, honor conservative throttling/backoff, and keep untracked inventory conservative. | Actual store/order/webhook references; prevented-operation traces; provider throttling responses where applicable; reconciliation proving no unintended extra order/charge. |

For each row, the exact observation-key list is exported in `ACCEPTANCE_SCENARIOS` in the preflight script. Recording every key as `true` is a declaration to review, not proof. Keep individual subcases and provider IDs in the referenced captures; for example, A06 needs separate full-refund, partial-refund, and cancellation traces in both directions, not one refund ID reused as evidence for all subcases.

## Declared evidence manifest

`--schema` emits the machine-readable JSON Schema exported as `ACCEPTANCE_MANIFEST_SCHEMA`. The validator additionally checks distinct store domains/catalog fingerprints, all ten scenario IDs, every required observation, per-provider ID formats/source labels, three-store coverage, artifact references, file confinement, and credential-field rejection.

Top-level structure:

```json
{
  "schemaVersion": 1,
  "run": {
    "id": "ACTUAL-RUN-REFERENCE",
    "environment": "test",
    "actualProviders": true,
    "redacted": true,
    "startedAt": "ACTUAL-ISO-TIMESTAMP",
    "completedAt": "ACTUAL-ISO-TIMESTAMP"
  },
  "stores": [],
  "stripe": { "mode": "test", "accountId": "ACTUAL-STRIPE-ACCOUNT-ID" },
  "artifacts": [],
  "scenarios": []
}
```

This deliberately incomplete shape example is not a runnable fixture or evidence. Populate it from the actual exercise; never manufacture IDs, timestamps, fingerprints, or observations to satisfy validation.

- Each of the **three** `stores` records has an exact authorized `domain`, `kind:"development"` or `kind:"trial"`, required `testMode:true`, actual `shopId` and `appInstallationId`, and `catalog:{source:"shopify-admin-graphql",capturedAt,fingerprint,productCount,artifactId}`. `testMode:false`, an omitted value, a string in place of the boolean, other store kinds, and Stripe live mode block readiness. Capture the complete paginated catalog first. Compute its fingerprint from a documented, consistently sorted canonical representation that includes product/variant identities and relevant commercial fields. The three fingerprints must differ. The preflight never generates fingerprints or pretends catalogs were fetched.
- Each `artifacts` record has `id`, a relative `path`, `kind`, `source`, `capturedAt`, `redacted:true`, and a declared `sha256`. Source is `shopify`, `stripe`, `avafem`, or `email_provider`. Files must exist, be nonempty regular files, remain inside the evidence directory even after resolving symlinks, and be at most 25 MiB. Accepted formats are JSON/JSONL, CSV, text/log, common image captures, or PDF. The manifest itself is limited to 2 MiB. Hashes are not checked by this metadata-only tool.
- Each `scenarios` record has `id` (`A01`–`A10`), declared `status` (`executed`, `not_run`, or `blocked`), actual `startedAt`/`completedAt`, all three `storeDomains`, `observations`, `providers`, and `artifactIds`. `not_run` or `blocked` remains incomplete. An `executed` declaration still results in `NOT_RUN` from this validator because it did not execute or authenticate the exercise.
- Each provider reference has `kind`, actual provider `id`, `artifactIds`, and `storeDomain` for Shopify records. Use the provider-kind enum from `--schema`. Link to an artifact with the corresponding provider source. All three stores need provider references within every scenario; a shared Stripe checkout does not replace individual Shopify order evidence.

Keep captures outside the source repository when they contain operational data. Redact secret headers, cookies, tokens, webhook secrets, customer contact fields, and shipping details before sharing evidence. The manifest contains references and booleans, not customer addresses or credentials. An allow-listed synthetic address may remain in an access-controlled test capture when needed to verify A03; it must not be copied into the manifest or application logs.

## Promoting the gate

The local suite tests that the preflight refuses missing configuration, rejects unsafe file references, requires all evidence categories, and never awards acceptance to complete **synthetic** declarations. It is not a live acceptance runner.

A future authorized live run must retrieve the actual provider records and signed events, verify artifact hashes/provenance and test-mode identity, exercise the matrix, and compare every monetary allocation and reconciliation result. Record a separate reviewed acceptance report with the exact code revision and policy versions. Until that exists, the release gate remains **NOT RUN / BLOCKED**, regardless of local test counts or manifest completeness.
