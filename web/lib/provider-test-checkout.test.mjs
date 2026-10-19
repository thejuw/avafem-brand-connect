import test from "node:test";
import assert from "node:assert/strict";
import {
  canPayProviderTestCheckout,
  providerCheckoutErrorDetails,
  providerCheckoutRuns,
  providerVariantLabel,
  safeCheckoutMessage,
} from "./provider-test-checkout.mjs";

const now = Date.parse("2026-10-18T12:00:00Z");
const quote = () => ({
  id: "test_checkout_fixture",
  test: true,
  shop: 'i4vd1u-s8.myshopify.com',
  currency: "USD",
  state: "quoted",
  canPay: true,
  variant: { quantity: 1, priceCents: 2400 },
  amounts: {
    subtotalCents: 2400,
    shippingCents: 0,
    taxCents: 198,
    totalCents: 2598,
  },
  quoteExpiresAt: "2026-10-18T12:15:00Z",
});
const options = { enabled: true, stripeVerified: true, confirmed: true, now };
test("A frozen actual-provider test quote requires explicit confirmation before payment", () => {
  assert.equal(canPayProviderTestCheckout(quote(), options), true);
  assert.equal(
    canPayProviderTestCheckout(quote(), { ...options, confirmed: false }),
    false,
  );
  assert.equal(
    canPayProviderTestCheckout(quote(), { ...options, enabled: false }),
    false,
  );
  assert.equal(
    canPayProviderTestCheckout(quote(), { ...options, stripeVerified: false }),
    false,
  );
});
test("Expired, non-test, paid, or provider-blocked quotes cannot be paid from the UI", () => {
  for (const changes of [
    { test: false },
    { shop: 'qpsd02-jz.myshopify.com' },
    { currency: "EUR" },
    { state: "complete" },
    { canPay: false },
    { quoteExpiresAt: "2026-10-18T11:59:00Z" },
    { quoteExpiresAt: null },
  ]) {
    assert.equal(
      canPayProviderTestCheckout({ ...quote(), ...changes }, options),
      false,
    );
  }
});
test("The $100 cap, quantity one, and frozen cent totals are enforced without inventing amounts", () => {
  const over = quote();
  over.variant.priceCents = 10001;
  over.amounts = {
    subtotalCents: 10001,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 10001,
  };
  assert.equal(canPayProviderTestCheckout(over, options), false);
  const mismatch = quote();
  mismatch.amounts.totalCents++;
  assert.equal(canPayProviderTestCheckout(mismatch, options), false);
  const missing = quote();
  delete missing.amounts.taxCents;
  assert.equal(canPayProviderTestCheckout(missing, options), false);
  const quantity = quote();
  quantity.variant.quantity = 2;
  assert.equal(canPayProviderTestCheckout(quantity, options), false);
});
test("Durable run parsing supports the direct list and rejects malformed entries", () => {
  assert.deepEqual(providerCheckoutRuns([null, {}, quote()]), [quote()]);
  assert.deepEqual(providerCheckoutRuns({ runs: [quote()] }), [quote()]);
});
test("Provider error messages cannot expose credential strings", () => {
  const text = safeCheckoutMessage(
    "Failure sk_test_SYNTHETIC_UNIT_TEST and whsec_SYNTHETIC_UNIT_TEST",
  );
  assert.ok(!text.includes("sk_test_"));
  assert.ok(!text.includes("whsec_"));
  assert.ok(text.includes("[redacted credential]"));
});
test("Inactive Stripe Tax has actionable test-only guidance and safe provider diagnostics", () => {
  const details = providerCheckoutErrorDetails({
    code: "STRIPE_QUOTE_FAILED",
    providerCode: "stripe_tax_inactive",
    providerRequestId: "req_SYNTHETIC_TEST",
    message: "Generic provider error",
  });
  assert.equal(details.providerCode, "stripe_tax_inactive");
  assert.equal(details.providerRequestId, "req_SYNTHETIC_TEST");
  assert.equal(details.message, "Enable Stripe Tax in this account’s test environment; no payment or Shopify order was created.");
  assert.equal(details.helpUrl, "https://docs.stripe.com/tax/set-up");
});
test("Other provider errors retain safe text without inventing Tax setup guidance", () => {
  const details = providerCheckoutErrorDetails({
    code: "QUOTE_FAILED",
    providerCode: "sk_test_SYNTHETIC_UNIT_TEST",
    providerRequestId: "whsec_SYNTHETIC_UNIT_TEST",
    message: "Request failed shpat_SYNTHETIC_UNIT_TEST",
  });
  assert.equal(details.helpUrl, null);
  assert.equal(details.code, "QUOTE_FAILED");
  assert.doesNotMatch(JSON.stringify(details), /sk_test_|whsec_|shpat_/);
  assert.equal(providerCheckoutErrorDetails({}).providerRequestId, "");
});
test("Variant choices distinguish different sizes under the same product", () => {
  assert.equal(
    providerVariantLabel({ productTitle: "Care essentials", title: "Small" }),
    "Care essentials · Small",
  );
  assert.equal(
    providerVariantLabel({
      productTitle: "Care essentials",
      title: "Default Title",
    }),
    "Care essentials",
  );
});
