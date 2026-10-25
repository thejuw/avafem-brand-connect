# Native inventory and mixed commerce — local sandbox

This module adds an explicit Avafem-owned product path beside partner products. It reuses the canonical catalog, compliance review, orders, Bags and ledger rather than treating Avafem as a partner that owes itself a transfer.

**The new `/api/admin/commerce` flow is a local, owner-operated simulation.** Its payment, tax, delivery, refund and settlement actions are synthetic. `simulate-payment` does not charge a card. Tax is a fixed 8.25% fixture on each discounted merchandise line and charged shipping, not Stripe Tax. A simulated delivery is not carrier evidence. A configured tax reference is not a registration or provider-verification result.

The existing three-store actual-provider TEST checkout and its historical evidence are separate and unchanged. Those results do not certify this new mixed first-party/partner engine. No production or actual-provider mixed-commerce acceptance is claimed here.

## Commercial identity and defaults

Branding, inventory authority, inventory ownership, fulfilment and settlement are separate concepts. An external-looking product is not automatically partner-owned, and a product with missing source metadata is not automatically Avafem-owned.

Every unconfigured brand remains:

```json
{
  "version": 0,
  "model": "partner",
  "inventoryAuthority": "external",
  "inventoryOwner": "partner",
  "fulfiller": "partner",
  "settlementModel": "commission",
  "partnerPromotionAgreement": ""
}
```

Its default commission comes from the existing brand record; its default shipping charge comes from that brand's US shipping table, or zero if there is no US entry. This derivation does not import stock, alter existing terms, grant approval, or create a partner agreement.

An owner must explicitly choose the complete first-party combination: `model:first_party`, `inventoryAuthority:native`, `inventoryOwner:avafem`, `fulfiller:avafem`, `settlementModel:retail`, and `commissionBps:0`. Partner/native and partially changed combinations are rejected. Existing brands and products are not automatically reclassified or backfilled as first-party.

Both paths still require approved, available catalog products. Native inventory is not a shortcut around product curation or claim/compliance review.

An owned brand must be ready/live before checkout. Its readiness requires a warehouse ship-from line/address postal code, support email, an approved product and a native variant. It does not require fictitious Stripe onboarding or a fake external-store connection. Configure the warehouse/support profile, explicitly select the owned model, approve the product and create its native variant before activating the brand.

The catalog projection uses native variant prices and available stock for owned products; parent product counters and old variant JSON are not another purchasable inventory pool. Public/scoped catalog responses expose stable native variant selectors without revealing unit costs. Cost and stock-adjustment controls remain owner operations data.

## Platform settings

`createCommercePolicies` stores append-only policy versions and an actor/reason audit. Version `0` means the effective default, not a saved version. Saves are partial updates with mandatory `expectedVersion` and a nonempty `reason`. A concurrent stale save returns `COMMERCE_POLICY_VERSION_CONFLICT`; reload before submitting a deliberate replacement.

| Setting | Default | Supported values |
|---|---|---|
| `merchantOfRecord` | `avafem` | `avafem` only |
| `currency` | `USD` | `USD` only |
| `discountBps` | `0` | Integer 0–10000 |
| `discountFunding` | `avafem` | `avafem` or `partner` |
| `loyaltyBps` | `500` | Integer 0–10000; new canonical credits, not the separate BeautyBank rate |
| `freeShippingThresholdCents` | `null` | `null` disables; otherwise integer 0–100000000 |
| `freeShippingFunding` | `avafem` | `avafem` or `partner` |
| `returnShippingFunding` | `avafem` | `avafem` or `partner` |
| `ownedShippingCents` | `0` | Integer 0–100000000 |
| `returnWindowDays` | `30` | Integer 0–365; checkout snapshots preserve promised terms |
| `reservationMinutes` | `15` | Integer 1–60 |
| `taxProvider` | `stripe_tax` | Configuration designation only; no native provider call in this simulation |
| `taxLiableParty` | `avafem` | Configuration designation, not a legal determination |
| `taxConfigurationRef` | empty | Bounded reference, never a secret or proof of registration |
| `enabled` | `true` | Boolean; does not enable live mode |

Selecting partner funding does not itself authorize a deduction. Every affected partner must have an explicit, nonempty `partnerPromotionAgreement` in its snapshotted brand terms. A missing agreement blocks the quote. First-party costs remain Avafem's own allocation regardless of the partner-funding selection.

Supported brand settings are `model`, `inventoryAuthority`, `inventoryOwner`, `fulfiller`, `settlementModel`, `commissionBps`, `shippingCents`, and `partnerPromotionAgreement`. No provider credential or live-mode field is accepted.

Structural settings lock once the brand is referenced by a native variant, a durable checkout snapshot, or a Bag allocation—even if the checkout has not been paid. Changing a shipping rate, commission or agreement appends future terms; it does not rewrite existing checkout/order snapshots. A used commercial identity is not reset by cancelling a checkout.

The three actual-provider test-store bindings are immutable partner identities and cannot be repurposed as first-party brands. Create a separate Avafem-owned brand so old provider events and acceptance evidence retain their original authority.

## Native stock and cost

Native variants have stable IDs and explicit price/cost cents. Creating one starts with zero stock; the editable legacy product quantity is not adopted as a second stock pool. Stock changes require a reason, actor and stable operation ID. Variant updates use `expectedVersion`; stock cannot be adjusted below existing reservations.

`available = onHand − reserved`. Checkout reserves exact native variants and freezes their unit price/cost. Payment simulation commits that reservation, reducing both on-hand and reserved quantities. Cancellation before payment or expiry releases uncommitted reservations. Replaying the same operation must not reserve or consume stock again.

Partner inventory is different: the simulation makes local shadow holds against imported catalog quantities. It does not reserve stock in the partner's store, submit a remote order or guarantee that remote stock remains available. Actual external reservation/order/failure reconciliation is future provider work.

Shipment records are quantity-based and must not decrement committed inventory a second time. Cost of goods sold uses the frozen unit cost of the shipped quantities, not a later edited cost or the retail price.

Stock receipts and adjustments are movement records only: they do not certify an opening inventory valuation, purchase/acquisition journal or supplier payable. The shipment/return cost entries demonstrate local cost attribution, not an audited inventory-valuation or procurement system.

A refund never automatically restocks goods. Return inspection records an explicit quantity and `restock` or `quarantine` disposition. `origin` may be `shipped` or `unshipped`; it is mandatory when both returned shipped units and cancelled unshipped units remain uninspected. The service tracks the exact unit group so an unshipped cancellation cannot reverse shipment COGS. Only a valid inspected restock restores sellable stock and, for previously shipped units, the associated cost allocation; quarantined goods do not become available. Return-shipping funding does not itself purchase a label or prove an actual carrier cost.

## Frozen money allocations

All amounts are integer USD cents. The quote freezes complete platform settings, each brand's commercial terms, stable item references, prices/costs, shipping and allocation results. Later policy changes affect new quotes, not prior snapshots.

Delivery starts the lifecycle hold. Release cannot precede the longest snapshotted/current platform or brand return window, the seven-day minimum, or an already promised later date. A later policy increase can extend eligibility without rewriting the frozen quote; a reduction cannot shorten an existing promise. Partner payouts retain their onboarding/dispute/refund gates. First-party credit release does not require a connected account. New canonical credit accrual uses discounted merchandise and the snapshotted `loyaltyBps`; the separate existing BeautyBank program is not reconfigured here.

Discounts are computed for the cart and allocated to lines using deterministic largest-remainder splits. The free-shipping threshold uses discounted merchandise, excluding shipping and tax. `ownedShippingCents` is one cart-level owned-product shipping charge, allocated across first-party groups by gross merchandise weight; it is not charged once per owned brand.

For one Bag, let:

- `G` = original merchandise subtotal; `D` = shopper merchandise discount.
- `Dp` = partner-funded share of that discount; `Da = D − Dp` = Avafem-funded share.
- `S0` = nominal shipping; `S` = shopper shipping, zero when free shipping applies.
- `H` = Avafem's partner shipping subsidy: `S0` only for Avafem-funded free shipping on a partner Bag, otherwise zero.
- `T` = tax amount recorded by this synthetic checkout; this is not a live tax calculation.

Shopper total is `G − D + S + T`.

For partner Bags:

```text
commission C = round((G − Dp) × commissionBps / 10000)
partner payable P = G − Dp − C + S + H
platform amount before tax/other costs = C − Da − H
```

Avafem-funded discounts do not reduce the partner's merchandise base or payable. Avafem-funded free shipping preserves the agreed partner shipping share through `H`. Partner-funded discounts reduce the agreed commission base; partner-funded free shipping removes the shipping share. These deductions require the recorded agreement. Existing partners retain their existing commission rate unless an owner explicitly versions new terms.

For first-party Bags, `C = 0` and `P = 0`. Avafem retains the retail/shipping allocation; there is **no partner payable, Connect account requirement, partner transfer or partner bank payout**. Its costs, discounts, rewards and tax remain separately visible. The platform remainder is not a profit calculation: inventory cost and other expenses still matter.

Refunds use frozen line quantities and allocations, with cumulative/residual checks so repeated partial refunds cannot exceed the original amounts. A partner refund reverses the appropriate payable/commission allocation; a first-party refund reverses its retail allocation without inventing a partner recovery. Cash/provider tax rounding is a separate concern and must not be hidden by a balanced synthetic journal.

Customer-facing merchant responsibility, tax liability, funding of a promotion and settlement allocation are separate decisions. These configuration fields and operational equations are not legal/tax advice or a conclusion on revenue recognition.

## Owner API workflow

These are admin simulation routes, not a public shopper checkout or a brand self-service settlement API. Use the authenticated owner browser session and its current `x-csrf-token` for mutations. Identifiers below are placeholders; use IDs and item references returned by the application. No provider key, card data or caller-supplied money total belongs in these requests.

| Route under `/api/admin/commerce` | Purpose |
|---|---|
| `GET /` | Aggregate configuration, catalog/stock and simulation status |
| `PUT /settings` | Versioned platform policy update |
| `PUT /brands/:brandId` | Explicit versioned commercial terms |
| `POST /variants`, `PATCH /variants/:id` | Stable native variant creation/commercial update |
| `POST /inventory/adjust` | Audited stock adjustment |
| `POST /checkouts`, `GET /checkouts` | Create reserved quote; list simulation checkouts |
| `GET /checkouts/:id` | Inspect frozen quote/state |
| `POST /checkouts/:id/simulate-payment` | Synthetic payment and canonical allocation only |
| `POST /checkouts/:id/cancel` | Cancel unpaid quote/release reservations |
| `GET /fulfillment` | Quantity-based work orders |
| `POST /fulfillment/:id/ship`, `POST /fulfillment/:id/deliver` | Synthetic shipment/delivery recording |
| `POST /bags/:id/refunds` | Item-quantity/optional shipping refund simulation |
| `POST /returns/inspect` | Audited restock or quarantine decision |
| `POST /run` | Run local lifecycle processing |
| `GET /reconciliation` | Inspect local allocation/ledger checks |

Examples are JSON request bodies. First read the current settings/brand version rather than assuming `0` on an existing installation.

`PUT /settings`:

```json
{"expectedVersion":0,"reason":"Avafem-funded local promotion fixture.","discountBps":500,"discountFunding":"avafem","freeShippingThresholdCents":5000,"freeShippingFunding":"avafem","ownedShippingCents":450,"loyaltyBps":500}
```

`PUT /brands/OWNED_BRAND_ID`, before stock or checkout use:

```json
{"expectedVersion":0,"reason":"Explicit Avafem-owned native catalog.","model":"first_party","inventoryAuthority":"native","inventoryOwner":"avafem","fulfiller":"avafem","settlementModel":"retail","commissionBps":0}
```

`POST /variants`, followed by `POST /inventory/adjust`:

```json
{"productId":"APPROVED_OWNED_PRODUCT_ID","sku":"AVF-NATIVE-001","label":"Default","unitPriceCents":2000,"unitCostCents":700}
```

```json
{"operationId":"stock_receipt_fixture_001","variantId":"RETURNED_NATIVE_VARIANT_ID","delta":10,"reason":"Explicit local stock receipt fixture."}
```

`POST /checkouts` mixes native variant IDs with approved partner product selectors. A native product uses its stable `variantId`, not the partner selector:

```json
{"operationId":"mixed_quote_fixture_001","items":[{"variantId":"RETURNED_NATIVE_VARIANT_ID","qty":2},{"productId":"APPROVED_PARTNER_PRODUCT_ID","variantSku":"PARTNER-VARIANT-SKU","qty":1}],"shipTo":{"name":"Local Test Shopper","line1":"123 Test Street","city":"Austin","region":"TX","postal":"78701","country":"US"}}
```

`POST /checkouts/CHECKOUT_ID/simulate-payment` is a synthetic action; it is never evidence of a Stripe payment. `POST /checkouts/CHECKOUT_ID/cancel` is for the unpaid path. After payment, use the explicit refund/fulfilment lifecycle instead of releasing a committed reservation.

`POST /fulfillment/WORK_ORDER_ID/ship`, then `POST /fulfillment/WORK_ORDER_ID/deliver` after all active quantities are shipped:

```json
{"operationId":"shipment_fixture_001","carrier":"LOCAL_SIMULATION","trackingNumber":"SYNTHETIC-001","items":[{"reference":"RETURNED_LINE_REFERENCE","qty":1}]}
```

```json
{"operationId":"delivery_fixture_001"}
```

`POST /bags/BAG_ID/refunds`, followed separately by `POST /returns/inspect` if goods are inspected:

```json
{"operationId":"refund_fixture_001","reason":"Local partial-return fixture.","items":[{"reference":"RETURNED_LINE_REFERENCE","qty":1}],"refundShipping":false}
```

```json
{"operationId":"inspection_fixture_001","bagId":"BAG_ID","reference":"RETURNED_LINE_REFERENCE","qty":1,"origin":"shipped","disposition":"restock","reason":"Synthetic inspection: sellable returned unit."}
```

`POST /run` takes `{}`. Read the returned state/reconciliation rather than treating an HTTP success or a balanced journal as evidence of external money movement.

## Acceptance and remaining provider work

Local verification on 2026-10-25 used Node.js 24: the full regression run passed 898 tests with zero failures and 14 PostgreSQL skips. Follow-up runs passed 21 policy/workflow guard tests and 24 checkout/API tests after final hardening. A separate temporary PostgreSQL 17 server passed all 14 concurrency tests with zero skips, including competing native reservations and duplicate payment booking across independent pools. These run counts overlap. The dashboard build and isolated desktop/mobile browser checks also passed. GitHub Actions jobs could not start because of the account billing/spending-limit restriction; no hosted CI pass is claimed. None of these local results certifies the pending provider acceptance below.

| Area | Scope of this engine | Actual-provider acceptance for the new mixed flow |
|---|---|---|
| Policy, catalog eligibility, stock and snapshots | Local configuration and durable simulation | Does not establish a provider integration |
| Checkout/payment and tax | Explicit synthetic payment/tax | Pending actual Stripe Tax, hosted payment/capture and failure/recovery integration |
| Native/partner fulfilment and delivery | Quantity-based local records | Pending actual warehouse/carrier and applicable partner dispatch acceptance |
| Partial refunds, inspection and COGS | Frozen local allocation/stock/cost evidence | Pending actual payment refund, provider tax effects and recovery acceptance |
| Partner settlement/retail retention | Synthetic split; first-party never transfers | Pending actual Connect settlement/reversals and payout acceptance for this engine |
| Reconciliation | Local snapshots/ledger checks | Not a substitute for provider/cash/tax readbacks |

Do not use existing three-store acceptance counts, a tax configuration reference, a simulated tracking number or an owner-selected `paid`/`delivered` state to mark these pending requirements complete. No live-mode switch is provided by these settings.
