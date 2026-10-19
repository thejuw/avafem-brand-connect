import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { displayLabel } from "./lib/display-label.mjs";
import { CASH_RECONCILIATION_NOTICE } from './lib/unified-checkout.mjs';
import {
  PROVIDER_TEST_SHOP,
  canPayProviderTestCheckout,
  providerCheckoutErrorDetails,
  providerCheckoutRuns,
  providerVariantLabel,
  safeCheckoutMessage,
} from "./lib/provider-test-checkout.mjs";

const money = (value) =>
  Number.isSafeInteger(value)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value / 100)
    : "—";
const date = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
const label = (value) =>
  displayLabel(value, "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

function RunState({ state }) {
  const tone =
    state === "complete"
      ? "green"
      : /failed|mismatch|blocked|expired|needs_review|uncertain/.test(
            state || "",
          )
        ? "red"
        : "amber";
  return (
    <span className={`badge ${tone}`}>
      <span className="badge-dot" />
      {label(state)}
    </span>
  );
}

export default function TestCheckoutPanel({
  request,
  enabled,
  stripeVerified,
}) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const actionLock = useRef(false);
  const [options, setOptions] = useState(null);
  const [variantId, setVariantId] = useState("");
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState("");
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const loadRuns = useCallback(async () => {
    if (!enabled) return;
    setLoadingRuns(true);
    setError("");
    try {
      setRuns(
        providerCheckoutRuns(await requestRef.current("/api/test-checkout")),
      );
    } catch (err) {
      setError(
        safeCheckoutMessage(
          err.message,
          "Provider test runs could not be loaded.",
        ),
      );
    } finally {
      setLoadingRuns(false);
    }
  }, [enabled]);
  useEffect(() => {
    loadRuns();
  }, [loadRuns]);
  async function perform(kind, task) {
    if (!enabled || actionLock.current) return;
    actionLock.current = true;
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (err) {
      setError(safeCheckoutMessage(err.message));
    } finally {
      actionLock.current = false;
      setBusy("");
    }
  }
  function loadOptions() {
    perform("options", async () => {
      const result = await requestRef.current("/api/test-checkout/options");
      if (
        result?.test !== true ||
        result?.shop !== PROVIDER_TEST_SHOP ||
        result?.currency !== "USD" ||
        !Array.isArray(result.variants)
      )
        throw new Error(
          "The server did not return valid test-only variant options.",
        );
      setOptions(result);
      setVariantId((previous) =>
        result.variants.some((item) => item.id === previous) ? previous : "",
      );
      setMessage(
        `Loaded ${result.variants.length} actual Shopify test-store variants. No order or payment was created.`,
      );
    });
  }
  function quote() {
    if (!variantId || !stripeVerified) return;
    perform("quote", async () => {
      const result = await requestRef.current("/api/test-checkout/quote", {
        method: "POST",
        body: { variantId },
      });
      setRun(result);
      setConfirmed(false);
      await loadRuns();
      setMessage(
        result?.state === "quoted"
          ? "Stripe Tax quote ready. Review the frozen total before confirming a test payment."
          : "The quote returned the provider state shown below. No payment was automatically attempted.",
      );
    });
  }
  function pay() {
    if (
      !canPayProviderTestCheckout(run, { enabled, stripeVerified, confirmed })
    ) {
      setError(
        "A fresh, valid test quote and explicit confirmation are required. Quote again if the existing quote expired.",
      );
      return;
    }
    perform("pay", async () => {
      const result = await requestRef.current(
        `/api/test-checkout/${encodeURIComponent(run.id)}/pay`,
        {
          method: "POST",
          body: { confirmTest: true },
          headers: { "Idempotency-Key": `provider-test-pay:${run.id}` },
        },
      );
      setRun(result);
      setConfirmed(false);
      await loadRuns();
      setMessage(
        result?.state === "complete"
          ? "Stripe TEST payment and Shopify TEST order read-back completed for this run. This is a limited single-store exercise."
          : "The payment attempt returned the durable state shown below. Use reconciliation for an uncertain outcome; do not create a replacement payment.",
      );
    });
  }
  function reconcile() {
    if (!run?.id || run.test !== true || run.canReconcile !== true) return;
    perform("reconcile", async () => {
      const result = await requestRef.current(
        `/api/test-checkout/${encodeURIComponent(run.id)}/reconcile`,
        { method: "POST", body: {} },
      );
      setRun(result);
      setConfirmed(false);
      await loadRuns();
      setMessage(
        "Run reconciled. Review its current provider IDs and state below.",
      );
    });
  }
  function openRun(id) {
    perform("open", async () => {
      setRun(
        await requestRef.current(
          `/api/test-checkout/${encodeURIComponent(id)}`,
        ),
      );
      setConfirmed(false);
    });
  }
  const variants = options?.variants || [];
  const payable = canPayProviderTestCheckout(run, {
    enabled,
    stripeVerified,
    confirmed,
  });
  const amounts = run?.amounts || {};
  const runError = run?.lastError
    ? providerCheckoutErrorDetails(run.lastError)
    : null;
  return (
    <section
      className="card provider-checkout-card"
      aria-labelledby="provider-checkout-title"
    >
      <div className="card-heading">
        <div>
          <h2 id="provider-checkout-title">Real provider test checkout</h2>
          <p>
            Stripe TEST payment{" "}
            <ArrowRight size={11} className="inline-arrow" /> My Store 2 Shopify
            TEST order
          </p>
        </div>
        <span className="context-pill">
          <FlaskConical size={14} />
          Not the local simulator
        </span>
      </div>
      <div className="provider-checkout-body">
        <div className="inline-banner compact">
          <FlaskConical size={17} />
          <div>
            <strong>A limited, single-store provider exercise</strong>
            <span>
              This creates real provider records in test mode only, capped at
              $100. It does not fulfill orders, send customer emails, decrement
              inventory, transfer funds, or issue refunds. It does not complete
              the three-store acceptance gate.
            </span>
          </div>
        </div>
        {!stripeVerified && (
          <div className="setup-note">
            <ShieldCheck size={17} />
            <span>
              Verify Stripe test credentials above before requesting a tax quote
              or payment. Loading variants and saved runs is read-only.
            </span>
          </div>
        )}
        {error && (
          <div className="error-banner checkout-feedback" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
          </div>
        )}
        {message && (
          <p className="checkout-message" role="status">
            <CheckCircle2 size={15} />
            {message}
          </p>
        )}
        <div className="checkout-controls">
          <div>
            <button
              className="button"
              onClick={loadOptions}
              disabled={!enabled || !!busy}
            >
              {busy === "options" ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {options ? "Reload actual variants" : "Load actual variants"}
            </button>
            {options && (
              <small>
                {displayLabel(options.shop, "My Store 2")} · {variants.length}{" "}
                variants
              </small>
            )}
          </div>
          <label className="field">
            <span>Actual Shopify variant · quantity 1</span>
            <select
              aria-label="Actual Shopify test variant"
              value={variantId}
              onChange={(event) => setVariantId(event.target.value)}
              disabled={!enabled || !variants.length || !!busy}
            >
              <option value="">Select a test-store variant</option>
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {providerVariantLabel(variant)}
                  {variant.sku ? ` · ${variant.sku}` : ""} ·{" "}
                  {money(variant.priceCents)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            onClick={quote}
            disabled={!enabled || !stripeVerified || !variantId || !!busy}
          >
            {busy === "quote" ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <CreditCard size={14} />
            )}
            Quote test checkout
          </button>
        </div>
        <p className="checkout-fixture-note">
          Fixture: Alex Test, US address · quantity 1 · $0 shipping ·
          physical-goods tax code txcd_99999999 for this test. Tax is calculated
          by Stripe; this fixture is not a production tax classification.
        </p>
        {run && (
          <div className="checkout-run">
            <div className="checkout-run-heading">
              <div>
                <span className="eyebrow">DURABLE PROVIDER RUN</span>
                <h3>
                  {providerVariantLabel(run.variant)}
                </h3>
                <code>{displayLabel(run.id)}</code>
              </div>
              <RunState state={run.state} />
            </div>
            <p className="checkout-fixture-note" role="note">{CASH_RECONCILIATION_NOTICE}</p>
            {run.test !== true && (
              <div className="error-banner">
                <AlertCircle size={17} />
                <span>
                  This run is not explicitly marked test-only. Payment and
                  reconciliation controls are unavailable.
                </span>
              </div>
            )}
            <div className="checkout-amounts">
              <div>
                <span>Merchandise</span>
                <strong>{money(amounts.subtotalCents)}</strong>
              </div>
              <div>
                <span>Shipping fixture</span>
                <strong>{money(amounts.shippingCents)}</strong>
              </div>
              <div>
                <span>Stripe Tax</span>
                <strong>{money(amounts.taxCents)}</strong>
              </div>
              <div className="checkout-total">
                <span>Frozen test total</span>
                <strong>{money(amounts.totalCents)}</strong>
              </div>
            </div>
            <div className="checkout-run-meta">
              <span>Quote expires {date(run.quoteExpiresAt)}</span>
              <span>Updated {date(run.updatedAt)}</span>
              <span>
                {displayLabel(run.shop, "My Store 2")} ·{" "}
                {displayLabel(run.currency, "USD")}
              </span>
            </div>
            <dl className="checkout-provider-ids">
              {[
                ["PaymentIntent", run.stripe?.paymentIntentId],
                ["Charge", run.stripe?.chargeId],
                ["Stripe Tax calculation", run.stripe?.taxCalculationId],
                ["Stripe Tax transaction", run.stripe?.taxTransactionId],
                ["Shopify test order", run.shopify?.orderId],
              ].map(([name, id]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>
                    <code>{displayLabel(id, "Not created")}</code>
                  </dd>
                </div>
              ))}
            </dl>
            {run.shopify?.verified === true && (
              <p className="checkout-message">
                <ShieldCheck size={15} />
                Shopify order read-back verified for this run.
              </p>
            )}
            {runError && (
              <div className="error-banner" role="alert">
                <AlertCircle size={17} />
                <span>
                  <strong>
                    {runError.code}
                  </strong>
                  <br />
                  {runError.message}
                  {runError.providerCode && (
                    <small className="below">
                      Provider code: <code>{runError.providerCode}</code>
                    </small>
                  )}
                  {runError.providerRequestId && (
                    <small className="below">
                      Provider request ID: <code>{runError.providerRequestId}</code>
                    </small>
                  )}
                  {runError.helpUrl && (
                    <a className="below" href={runError.helpUrl} target="_blank" rel="noopener noreferrer">
                      Stripe Tax setup documentation
                    </a>
                  )}
                </span>
              </div>
            )}
            {Array.isArray(run.warnings) && run.warnings.length > 0 && (
              <details className="checkout-warnings">
                <summary>Test limitations & assumptions</summary>
                <ul>
                  {run.warnings.map((warning, index) => (
                    <li key={index}>
                      {safeCheckoutMessage(
                        warning,
                        "Review the test limitations before continuing.",
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {run.state === "quoted" && (
              <div className="checkout-payment-confirm">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    disabled={!enabled || !!busy}
                  />
                  <span>
                    I confirm a real Stripe TEST Visa payment of{" "}
                    {money(amounts.totalCents)} and one My Store 2 Shopify TEST
                    order. No fulfillment or customer email.
                  </span>
                </label>
                <button
                  className="button primary"
                  onClick={pay}
                  disabled={!payable || !!busy}
                >
                  {busy === "pay" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <CreditCard size={15} />
                  )}
                  Pay with Stripe test Visa
                </button>
              </div>
            )}
            {run.canReconcile === true && run.test === true && (
              <div className="checkout-reconcile">
                <button
                  className="button"
                  onClick={reconcile}
                  disabled={!enabled || !!busy}
                >
                  {busy === "reconcile" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Reconcile provider records
                </button>
                <small>
                  Inspect and recover this existing run; do not start a
                  replacement payment for an uncertain result.
                </small>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="card-heading checkout-history-heading">
        <div>
          <h3>Saved provider runs</h3>
          <p>
            Persisted on the server; available again after reloading this page.
          </p>
        </div>
        <button
          className="button small"
          onClick={loadRuns}
          disabled={!enabled || loadingRuns || !!busy}
        >
          {loadingRuns ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <RefreshCw size={13} />
          )}
          Refresh runs
        </button>
      </div>
      {runs.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run / variant</th>
                <th>Frozen total</th>
                <th>State</th>
                <th>Updated</th>
                <th>View</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 20).map((saved) => (
                <tr key={saved.id}>
                  <td>
                    <strong>
                      {providerVariantLabel(saved.variant)}
                    </strong>
                    <small className="below">{displayLabel(saved.id)}</small>
                  </td>
                  <td>{money(saved.amounts?.totalCents)}</td>
                  <td>
                    <RunState state={saved.state} />
                  </td>
                  <td className="muted">{date(saved.updatedAt)}</td>
                  <td>
                    <button
                      className="button small"
                      onClick={() => openRun(saved.id)}
                      disabled={!!busy}
                    >
                      Open run
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="checkout-no-runs">
          {loadingRuns
            ? "Loading saved provider runs…"
            : "No saved provider runs yet. Load a variant and request a quote to begin."}
        </p>
      )}
    </section>
  );
}
