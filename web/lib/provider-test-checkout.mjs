export const PROVIDER_TEST_SHOP = 'i4vd1u-s8.myshopify.com';

export function providerVariantLabel(variant) {
  const product =
    typeof variant?.productTitle === "string"
      ? variant.productTitle.trim()
      : "";
  const title = typeof variant?.title === "string" ? variant.title.trim() : "";
  if (product && title && title !== "Default Title" && title !== product)
    return `${product} · ${title}`;
  return (
    product ||
    title ||
    (typeof variant?.sku === "string" ? variant.sku : "Shopify variant")
  );
}

export function canPayProviderTestCheckout(
  run,
  {
    enabled = false,
    stripeVerified = false,
    confirmed = false,
    now = Date.now(),
  } = {},
) {
  const amounts = run?.amounts;
  const validMoney =
    amounts &&
    ["subtotalCents", "shippingCents", "taxCents", "totalCents"].every(
      (key) => Number.isSafeInteger(amounts[key]) && amounts[key] >= 0,
    );
  return Boolean(
    enabled &&
    stripeVerified &&
    confirmed &&
    run?.test === true &&
      run?.shop === PROVIDER_TEST_SHOP &&
    run?.currency === "USD" &&
    run?.state === "quoted" &&
    run?.canPay === true &&
    typeof run.id === "string" &&
    run.id.length > 0 &&
    run.variant?.quantity === 1 &&
    validMoney &&
    amounts.totalCents > 0 &&
    amounts.totalCents <= 10000 &&
    amounts.totalCents ===
      amounts.subtotalCents + amounts.shippingCents + amounts.taxCents &&
    Number.isSafeInteger(run.variant.priceCents) &&
    amounts.subtotalCents === run.variant.priceCents &&
    typeof run.quoteExpiresAt === "string" &&
    Number.isFinite(Date.parse(run.quoteExpiresAt)) &&
    Date.parse(run.quoteExpiresAt) > now,
  );
}

export function safeCheckoutMessage(
  value,
  fallback = "The provider test could not be completed. Review the run state before retrying.",
) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .slice(0, 1500)
    .replace(
      /\b(?:(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|shpat_[A-Za-z0-9_]+|shpss_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9_.-]+)/g,
      "[redacted credential]",
    );
}

export function providerCheckoutErrorDetails(error) {
  const taxInactive = error?.providerCode === "stripe_tax_inactive";
  return {
    code: safeCheckoutMessage(error?.code, "Provider check needs attention"),
    providerCode: safeCheckoutMessage(error?.providerCode, ""),
    providerRequestId: safeCheckoutMessage(error?.providerRequestId, ""),
    message: taxInactive
      ? "Enable Stripe Tax in this account’s test environment; no payment or Shopify order was created."
      : safeCheckoutMessage(error?.message),
    helpUrl: taxInactive ? "https://docs.stripe.com/tax/set-up" : null,
  };
}

export function providerCheckoutRuns(value) {
  const runs = Array.isArray(value)
    ? value
    : Array.isArray(value?.runs)
      ? value.runs
      : [];
  return runs.filter(
    (run) => run && typeof run === "object" && typeof run.id === "string",
  );
}
