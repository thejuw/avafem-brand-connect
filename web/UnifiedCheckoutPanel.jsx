import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, ExternalLink, FlaskConical, LoaderCircle, Plus, RefreshCw, ShieldCheck, ShoppingBag, Trash2, X } from 'lucide-react';
import { displayLabel } from './lib/display-label.mjs';
import { providerVariantLabel, providerCheckoutErrorDetails } from './lib/provider-test-checkout.mjs';
import { refreshTaxReport, acknowledgeTaxRounding, taxReportForRun, taxReportLabel, taxProvenanceNotice } from './lib/tax-reconciliation.mjs';
import {
  UNIFIED_STORES, normalizeUnifiedOptions, evaluateUnifiedCart, unifiedCheckoutLink,
  unifiedRunRecords, safeUnifiedError, configureUnifiedShopifyCredentials, clearUnifiedShopifyForm,
  loadUnifiedReturnedRun,
  CASH_RECONCILIATION_NOTICE, unifiedCompletionLabel,
} from './lib/unified-checkout.mjs';

const money = value => Number.isSafeInteger(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100) : '—';
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
const title = value => displayLabel(value, 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
function Status({ state }) {
  return <span className={`badge ${['complete', 'completed'].includes(state) ? 'green' : /failed|mismatch|blocked|review|uncertain|expired/.test(state || '') ? 'red' : 'amber'}`}><span className="badge-dot" />{unifiedCompletionLabel(state) || title(state)}</span>;
}

function TaxReportPanel({ report, enabled, busy, confirmed, onConfirm, onRefresh, onRecord }) {
  const amount = (value, signed = false) => Number.isSafeInteger(value) ? `${signed && value > 0 ? '+' : ''}${money(value)}` : 'Not verified';
  return <section className="unified-setup" aria-labelledby="separate-tax-title">
    <div className="unified-setup-heading"><div><h3 id="separate-tax-title">Separate Stripe Tax reconciliation</h3><p>Platform-only rounding subledger · not a correction to native Stripe Tax reporting.</p></div><button className="button small" disabled={!enabled || !!busy} onClick={onRefresh}>{busy === 'tax-report' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh Tax report</button></div>
    <p className="checkout-fixture-note">This report does not change shopper refund cents, brand transfers or bank payouts. Cash completion and full acceptance are separate; full acceptance is not certified.</p>
    {report ? <>
      <p role="status"><span className="badge amber">{taxReportLabel(report)}</span></p>
      <div className="inline-banner compact" role="note"><AlertCircle size={18} /><div><strong>Tax evidence source & limits</strong><span>{taxProvenanceNotice(report)}</span>{report.provenance?.observedAt && <small className="below">Snapshot observed <time dateTime={report.provenance.observedAt}>{report.provenance.observedAt}</time>. Refreshing this report does not make the observation a new live Tax API audit.</small>}</div></div>
      <div className="table-wrap"><table><thead><tr><th>Tax reporting comparison · USD</th><th>Amount</th></tr></thead><tbody>
        <tr><td>Shopify / native refund tax</td><td>{amount(report.totals.shopifyRefundTaxCents)}</td></tr>
        <tr><td>Stripe reversed tax</td><td>{amount(report.totals.stripeReversedTaxCents)}</td></tr>
        <tr><td><strong>Raw variance · Stripe − Shopify</strong></td><td><strong>{amount(report.totals.rawVarianceCents, true)}</strong></td></tr>
        <tr><td>Recorded platform variance</td><td>{amount(report.totals.recordedPlatformVarianceCents, true)}</td></tr>
        <tr><td>Remaining unaccounted variance</td><td>{amount(report.totals.unaccountedVarianceCents, true)}</td></tr>
      </tbody></table></div>
      <p className="checkout-fixture-note">A zero unaccounted variance does not make a nonzero raw variance disappear, certify native tax equality, or grant acceptance.</p>
      <small className="below"><code>{report.id}</code>{report.reviewCount !== null ? ` · ${report.reviewCount} checks require review` : ' · Review count not verified'}</small>
      {report.checks.length > 0 && <details className="checkout-warnings"><summary>Tax evidence checks</summary><ul>{report.checks.map((check, index) => <li key={index}>{check.name} — {check.status}{check.code ? ` · ${check.code}` : ''}</li>)}</ul></details>}
      {report.readyToRecord && <><label className="checkbox-field"><input type="checkbox" checked={confirmed} disabled={!!busy || !enabled} onChange={event => onConfirm(event.target.checked)} /><span>I acknowledge a separate platform-only rounding entry. Preserve the raw variance, shopper refunds, brand payouts and acceptance limitations.</span></label><button className="button" disabled={!enabled || !!busy || !confirmed} onClick={onRecord}>{busy === 'tax-record' ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}Record platform-only rounding</button></>}
    </> : <p className="checkout-fixture-note">Tax reporting not verified. Refresh this separate report to inspect authoritative evidence; no rounding entry is recorded automatically.</p>}
  </section>;
}

function StorePicker({ store, loaded, disabled, onAdd }) {
  const [variantId, setVariantId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const variants = store.variants || [];
  const selected = variants.find(item => item.id === variantId);
  useEffect(() => { if (!variants.some(item => item.id === variantId)) setVariantId(''); }, [variants, variantId]);
  return <section className="unified-store" aria-label={`${store.name} cart items`}>
    <div className="unified-store-title"><ShoppingBag size={17} /><h3>{store.name}</h3><span className={`badge ${loaded && store.connected ? 'green' : 'amber'}`}>{!loaded ? 'Not loaded' : store.connected ? 'Connected' : store.configured ? 'Needs verification' : 'Not configured'}</span></div>
    <code className="unified-shop">{store.shop}</code>
    <div className="unified-store-policy"><span>Flat shipping <strong>{loaded ? money(store.shippingCents) : '—'}</strong></span><span>{Number.isSafeInteger(store.returnWindowDays) ? `${store.returnWindowDays}-day return window` : 'Policy not loaded'}</span></div>
    <label className="field"><span>{store.name} · actual variant</span><select aria-label={`${store.name} actual variant`} value={variantId} onChange={event => setVariantId(event.target.value)} disabled={disabled || !store.connected || !variants.length}>
      <option value="">{!loaded ? 'Load catalogs first' : !variants.length ? 'No eligible variants available' : 'Select an item'}</option>
      {variants.map(variant => <option key={variant.id} value={variant.id} disabled={variant.inventoryQty < 1}>{providerVariantLabel(variant)} · {variant.sku || 'No SKU'} · {money(variant.priceCents)}{variant.inventoryQty < 1 ? ' · Out of stock' : ''}</option>)}
    </select></label>
    <div className="unified-add-row"><label className="field"><span>Quantity</span><select aria-label={`${store.name} quantity`} value={quantity} onChange={event => setQuantity(Number(event.target.value))} disabled={disabled || !selected}>
      {[1, 2, 3, 4, 5].map(value => <option key={value} value={value} disabled={selected && value > selected.inventoryQty}>{value}</option>)}
    </select></label><button className="button" disabled={disabled || !selected || !store.configured || quantity > selected.inventoryQty} onClick={() => onAdd(store.shop, variantId, quantity)}><Plus size={14} />Add item</button></div>
    {selected && <small className="muted">{selected.inventoryQty} available · {store.commissionBps === 1500 ? '15% merchandise commission' : 'Commission policy needs verification'}</small>}
  </section>;
}

function ShopifySetup({ stores, enabled, request, onConfigured }) {
  const available = (stores || []).filter(store => store.shop !== UNIFIED_STORES[0].shop && (!store.connected || !store.configured));
  const [open, setOpen] = useState(false);
  const [shop, setShop] = useState(UNIFIED_STORES[1].shop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef(null);
  const close = () => { clearUnifiedShopifyForm(formRef.current); setOpen(false); setError(''); };
  useEffect(() => () => clearUnifiedShopifyForm(formRef.current), []);
  useEffect(() => { if (available.length && !available.some(store => store.shop === shop)) setShop(available[0].shop); }, [stores, shop]);
  if (!enabled || !available.length) return null;
  async function submit(event) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      await configureUnifiedShopifyCredentials({ form: formRef.current, shop, enabled, hostname: window.location.hostname, request });
      close();
      await onConfigured();
    } catch (cause) { setError(safeUnifiedError(cause)); }
    finally { setBusy(false); }
  }
  return <section className="unified-setup" aria-label="Exact-store Shopify test setup">
    <div className="unified-setup-heading"><div><strong>Connect the other test stores</strong><p>Use an app created inside the exact store’s Dev Dashboard organization. Exactly 15 approved scopes; no extra access.</p></div><button className="button small" disabled={busy} onClick={() => open ? close() : setOpen(true)}>{open ? 'Close setup' : 'Configure store credentials'}</button></div>
    {open && <form ref={formRef} onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }} autoComplete="off">
      <div className="unified-setup-grid"><label className="field"><span>Exact authorized store</span><select value={shop} onChange={event => { clearUnifiedShopifyForm(formRef.current); setShop(event.target.value); }} disabled={busy}>{available.map(store => <option key={store.shop} value={store.shop}>{store.name} · {store.shop}</option>)}</select></label>
        <label className="field"><span>Shopify app client ID</span><input name="shopifyClientId" aria-label="Shopify app client ID" required maxLength={128} autoComplete="off" spellCheck={false} /></label>
        <label className="field"><span>Shopify app client secret</span><input type="password" name="shopifyClientSecret" aria-label="Shopify app client secret" required minLength={16} maxLength={500} autoComplete="off" spellCheck={false} placeholder="Paste app secret here" /></label></div>
      <label className="checkbox-field"><input type="checkbox" name="confirmOwnedStore" required /><span>I confirm this app was created inside this exact store’s Dev Dashboard organization, not another store’s organization.</span></label>
      <p className="checkout-fixture-note">The server verifies this exact store and scope policy, then stores the secret encrypted in its private database. The secret is never returned or stored in this browser; this field clears after every submission or close.</p>
      {error && <p className="error-banner" role="alert"><AlertCircle size={15} />{error}</p>}
      <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}Verify & save exact-store connection</button>
    </form>}
  </section>;
}

export default function UnifiedCheckoutPanel({ request, enabled, checkoutReturn = null }) {
  const requestRef = useRef(request); requestRef.current = request;
  const lock = useRef(false);
  const creationRef = useRef(null);
  const runRef = useRef(null);
  const returnFocused = useRef(false);
  const [options, setOptions] = useState(null);
  const [items, setItems] = useState([]);
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState('');
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loadingReturn, setLoadingReturn] = useState(!!checkoutReturn);
  const [taxReport, setTaxReport] = useState(null);
  const [taxConfirmed, setTaxConfirmed] = useState(false);
  const activeRunRef = useRef(null); activeRunRef.current = run?.id;
  const visibleTaxReport = taxReportForRun(taxReport, run?.id);
  useEffect(() => { setTaxReport(null); setTaxConfirmed(false); }, [run?.id]);
  const loadRuns = useCallback(async () => {
    if (!enabled) return;
    setLoadingRuns(true);
    try { setRuns(unifiedRunRecords(await requestRef.current('/api/unified-checkout'))); }
    catch (cause) { setError(safeUnifiedError(cause)); }
    finally { setLoadingRuns(false); }
  }, [enabled]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => {
    if (!checkoutReturn || !enabled) return;
    let current = true;
    setLoadingReturn(true);
    loadUnifiedReturnedRun(checkoutReturn, (...args) => requestRef.current(...args))
      .then(saved => { if (current) setRun(saved); })
      .catch(cause => { if (current) setError(safeUnifiedError(cause)); })
      .finally(() => { if (current) setLoadingReturn(false); });
    return () => { current = false; };
  }, [enabled, checkoutReturn]);
  useEffect(() => {
    if (!checkoutReturn || loadingReturn || returnFocused.current || !runRef.current) return;
    returnFocused.current = true;
    runRef.current.scrollIntoView({ block: 'start', behavior: 'instant' });
    runRef.current.focus({ preventScroll: true });
  }, [checkoutReturn, loadingReturn, run?.id]);
  async function perform(kind, action) {
    if (!enabled || lock.current) return;
    lock.current = true; setBusy(kind); setError(''); setMessage('');
    try { await action(); } catch (cause) { setError(safeUnifiedError(cause)); }
    finally { lock.current = false; setBusy(''); }
  }
  const loadOptions = () => perform('options', async () => {
    const result = normalizeUnifiedOptions(await requestRef.current('/api/unified-checkout/options'));
    setOptions(result);
    setMessage('Read-only catalogs and connection status loaded. No checkout, payment or Shopify order was created.');
  });
  const evaluated = evaluateUnifiedCart(options, items);
  const stores = options?.stores || UNIFIED_STORES;
  const checkoutUrl = unifiedCheckoutLink(run);
  const runError = run?.lastError ? providerCheckoutErrorDetails(run.lastError) : null;
  function addItem(shop, variantId, quantity) {
    const existing = items.find(item => item.shop === shop && item.variantId === variantId);
    const nextQuantity = quantity + (existing?.quantity || 0);
    const variant = options?.stores.find(store => store.shop === shop)?.variants.find(item => item.id === variantId);
    if (!variant || nextQuantity > 5 || nextQuantity > variant.inventoryQty) { setError('Each variant is limited to quantity 1–5 within actual available stock.'); return; }
    setError('');
    setItems(previous => existing ? previous.map(item => item.shop === shop && item.variantId === variantId ? { ...item, quantity: nextQuantity } : item) : [...previous, { shop, variantId, quantity }]);
  }
  const createSession = () => perform('create', async () => {
    if (!evaluated.valid) throw new Error('Resolve cart and provider setup issues before hosted checkout.');
    const body = { items: evaluated.items };
    const fingerprint = JSON.stringify(body);
    if (creationRef.current?.fingerprint !== fingerprint) creationRef.current = { fingerprint, key: crypto.randomUUID() };
    const result = await requestRef.current('/api/unified-checkout/sessions', { method: 'POST', body, headers: { 'Idempotency-Key': creationRef.current.key } });
    if (result?.test !== true || typeof result.id !== 'string') throw new Error('The server did not return a valid test-only unified run. Refresh saved runs before retrying.');
    setRun(result); await loadRuns();
    if (result.state === 'checkout_open' && !unifiedCheckoutLink(result)) throw new Error('The hosted checkout URL was not a valid Stripe test session. No external link was opened; inspect this saved run.');
    setMessage('Test session saved. Continue with Stripe below to enter one shipping address and review the final tax and total. Nothing opens or pays automatically.');
  });
  const openRun = id => perform('open', async () => { setRun(await requestRef.current(`/api/unified-checkout/${encodeURIComponent(id)}`)); });
  const refreshRun = () => run?.id && perform('refresh', async () => { setRun(await requestRef.current(`/api/unified-checkout/${encodeURIComponent(run.id)}`)); setMessage('Saved run refreshed read-only. No provider dispatch was requested.'); });
  const reconcile = () => run?.id && run.test === true && perform('reconcile', async () => {
    setRun(await requestRef.current(`/api/unified-checkout/${encodeURIComponent(run.id)}/reconcile`, { method: 'POST', body: {} }));
    await loadRuns(); setMessage('Explicit reconciliation requested. Inspect every store’s order and state below; do not submit a replacement payment for an uncertain result.');
  });
  const loadTaxReport = () => perform('tax-report', async () => {
    const selectedId = run?.id;
    setTaxConfirmed(false);
    const result = await refreshTaxReport({ run, enabled, request: (...args) => requestRef.current(...args) });
    if (activeRunRef.current === selectedId) setTaxReport(result);
  });
  const recordTaxRounding = () => perform('tax-record', async () => {
    const selectedId = run?.id;
    const result = await acknowledgeTaxRounding({ run, report: visibleTaxReport, confirmed: taxConfirmed,
      enabled, request: (...args) => requestRef.current(...args) });
    setTaxConfirmed(false);
    if (activeRunRef.current === selectedId) setTaxReport(result);
    setMessage('Separate platform Tax rounding acknowledgement returned. Raw variance and cash/acceptance status remain separate.');
  });
  return <section className="card provider-checkout-card unified-checkout-card" aria-labelledby="unified-checkout-title">
    <div className="card-heading"><div><h2 id="unified-checkout-title">One cart. Three brands. One checkout.</h2><p>Owner-operated, real-provider test · My Store 2, My Store 4 & My Store 6</p></div><span className="context-pill"><ShoppingBag size={14} />Unified three-store test</span></div>
    <div className="provider-checkout-body">
      <div className="inline-banner compact"><FlaskConical size={18} /><div><strong>One Stripe test payment → three brand Bags</strong><span>This is an owner-only integration exercise, not a public shopper checkout or completed acceptance certification. An isolated accelerated return-window clock and a simulated notification inbox, when used, are test simulations—not elapsed real time or external email delivery.</span></div></div>
      {checkoutReturn && <div className="inline-banner compact" role="status">{loadingReturn ? <LoaderCircle size={18} className="spin" /> : <ShieldCheck size={18} />}<div><strong>{loadingReturn ? 'Opening your saved checkout…' : checkoutReturn.kind === 'cancelled' ? 'Returned from Stripe without confirmation' : 'Returned from Stripe · saved run inspection'}</strong><span>The return URL is not proof of payment. Only the saved provider state below confirms payment and each store’s order. This page has not submitted a payment, created an order, or requested reconciliation automatically. Refresh the run read-only to see backend progress.</span></div></div>}
      {error && <div className="error-banner checkout-feedback" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
      {message && <p className="checkout-message" role="status"><CheckCircle2 size={15} />{message}</p>}
      {!checkoutReturn && <>
      <div className="unified-load-row"><button className="button" disabled={!enabled || !!busy} onClick={loadOptions}>{busy === 'options' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{options ? 'Reload three-store catalogs' : 'Load three-store catalogs'}</button><small>Read-only · exact stores and approved permissions only</small></div>
      {options?.blockers.length > 0 && <div className="unified-blockers" role="status"><strong>Provider setup still needed</strong><ul>{options.blockers.map((blocker, index) => <li key={index}><code>{blocker.code}</code> — {blocker.message}{blocker.shop && <small className="below">{blocker.shop}</small>}</li>)}</ul></div>}
      {options && <ShopifySetup stores={options.stores} enabled={enabled} request={request} onConfigured={loadOptions} />}
      <div className="unified-store-grid">{stores.map(store => <StorePicker key={store.shop} store={store} loaded={!!options} disabled={!enabled || !!busy} onAdd={addItem} />)}</div>
      <div className="unified-cart-heading"><h3>Your unified test cart</h3><span>{items.reduce((sum, item) => sum + item.quantity, 0)} items · {new Set(items.map(item => item.shop)).size} of 3 brands</span></div>
      {items.length ? <div className="table-wrap unified-cart-table"><table><thead><tr><th>Brand / item</th><th>Unit</th><th>Quantity</th><th>Line total</th><th>Remove</th></tr></thead><tbody>{items.map(item => {
        const store = options?.stores.find(store => store.shop === item.shop);
        const variant = store?.variants.find(variant => variant.id === item.variantId);
        return <tr key={`${item.shop}:${item.variantId}`}><td><strong>{variant ? providerVariantLabel(variant) : 'Variant no longer available'}</strong><small className="below">{store?.name || item.shop} · {variant?.sku || 'Review catalog'}</small></td><td>{money(variant?.priceCents)}</td><td><select aria-label={`Quantity for ${variant?.sku || item.variantId}`} value={item.quantity} disabled={!!busy} onChange={event => setItems(previous => previous.map(line => line === item ? { ...line, quantity: Number(event.target.value) } : line))}>{[1, 2, 3, 4, 5].map(quantity => <option key={quantity} value={quantity} disabled={variant && quantity > variant.inventoryQty}>{quantity}</option>)}</select></td><td>{variant ? money(variant.priceCents * item.quantity) : '—'}</td><td><button className="icon-button" aria-label={`Remove ${variant?.sku || 'cart item'}`} disabled={!!busy} onClick={() => setItems(previous => previous.filter(line => line !== item))}><Trash2 size={15} /></button></td></tr>;
      })}</tbody></table></div> : <p className="unified-cart-empty">Add at least one in-stock item from each exact store. You can add multiple variants and quantities up to five.</p>}
      <div className="checkout-amounts unified-amounts"><div><span>Merchandise</span><strong>{money(evaluated.subtotalCents)}</strong></div><div><span>Brand shipping · once each</span><strong>{money(evaluated.shippingCents)}</strong></div><div><span>Authoritative tax</span><strong className="unified-pending">In Stripe Checkout</strong></div><div className="checkout-total"><span>Final payable total</span><strong className="unified-pending">Not quoted yet</strong></div></div>
      <p className="checkout-fixture-note">One address is collected in Stripe’s hosted test checkout. The total is finalized there using actual tax; no local rate is substituted. Shipping is each participating brand’s configured flat rate once per brand. No card or address fields are stored in this cart.</p>
      {items.length > 0 && !evaluated.valid && <ul className="unified-cart-issues">{evaluated.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
      <button className="button primary" disabled={!enabled || !!busy || !evaluated.valid || run?.state === 'checkout_open'} onClick={createSession}>{busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <ShoppingBag size={15} />}Create unified hosted test session<ArrowRight size={14} /></button>
      {run?.state === 'checkout_open' && <p className="checkout-fixture-note">An open session is saved below. Continue or refresh that session instead of creating a duplicate checkout.</p>}
      {options?.warnings.length > 0 && <details className="checkout-warnings"><summary>Test policies & provider notes</summary><ul>{options.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      </>}
      {run && <div className="checkout-run" ref={runRef} tabIndex={-1} aria-label="Saved unified checkout result"><div className="checkout-run-heading"><div><span className="eyebrow">ONE DURABLE UNIFIED RUN</span><h3>Three-store provider checkout</h3><code>{displayLabel(run.id)}</code></div><Status state={run.state} /></div>
        {checkoutReturn && <p className="checkout-fixture-note">{run.state === 'completed' ? 'The saved run reports its cash lifecycle completed. This is not full acceptance certification.' : run.state === 'orders_created' ? 'The saved run reports payment verification and all three Shopify orders. Shipping, refunds and payouts are separate lifecycle steps.' : 'Checkout processing is not yet confirmed complete. Inspect the current state and refresh; do not submit a replacement payment.'}</p>}
        <p className="checkout-fixture-note" role="note">{CASH_RECONCILIATION_NOTICE}</p>
        <TaxReportPanel report={visibleTaxReport} enabled={enabled && run.test === true} busy={busy} confirmed={taxConfirmed} onConfirm={setTaxConfirmed} onRefresh={loadTaxReport} onRecord={recordTaxRounding} />
        {run.test !== true && <div className="error-banner" role="alert"><AlertCircle size={16} />This run is not explicitly test-only. External continuation and reconciliation are disabled.</div>}
        <div className="checkout-amounts"><div><span>Merchandise</span><strong>{money(run.amounts?.subtotalCents)}</strong></div><div><span>Brand shipping</span><strong>{money(run.amounts?.shippingCents)}</strong></div><div><span>Stripe tax</span><strong>{money(run.amounts?.taxCents)}</strong></div><div className="checkout-total"><span>Provider total</span><strong>{money(run.amounts?.totalCents)}</strong></div></div>
        <div className="checkout-run-meta"><span>Created {date(run.createdAt)}</span><span>Updated {date(run.updatedAt)}</span><span>TEST mode · USD</span></div>
        {checkoutUrl && <div className="unified-continue"><a className="button primary" href={checkoutUrl} target="_blank" rel="noopener noreferrer">Continue with Stripe<ExternalLink size={14} /></a><small>Opens only checkout.stripe.com in a new tab. Review the address, tax and final test amount before confirming payment.</small></div>}
        <dl className="checkout-provider-ids">{[['Checkout Session', run.stripe?.checkoutSessionId], ['PaymentIntent', run.stripe?.paymentIntentId], ['Charge', run.stripe?.chargeId]].map(([name, id]) => <div key={name}><dt>{name}</dt><dd><code>{displayLabel(id, 'Not created')}</code></dd></div>)}</dl>
        <div className="table-wrap"><table><thead><tr><th>Brand Bag</th><th>State / shipping</th><th>Shopify order</th><th>Refunded</th><th>Transfer / payout</th></tr></thead><tbody>{(Array.isArray(run.bags) ? run.bags : []).map((bag, index) => <tr key={bag.id || bag.shop || index}><td><strong>{displayLabel(bag.name, UNIFIED_STORES.find(store => store.shop === bag.shop)?.name || 'Brand Bag')}</strong><small className="below">{displayLabel(bag.shop)}</small><code>{displayLabel(bag.id, 'Bag pending')}</code></td><td>{title(bag.state)}<small className="below">{title(bag.shippingStatus || 'not_shipped')}</small></td><td><code>{displayLabel(bag.orderId, 'Not created')}</code></td><td>{money(bag.refundCents ?? 0)}</td><td><code>{displayLabel(bag.transferId, 'No transfer')}</code><small className="below">{displayLabel(bag.payoutId, 'No bank payout')}</small></td></tr>)}</tbody></table></div>
        {runError && <div className="error-banner" role="alert"><AlertCircle size={16} /><span><strong>{runError.code}</strong><br />{runError.message}{runError.providerCode && <small className="below">Provider code: {runError.providerCode}</small>}{runError.providerRequestId && <small className="below">Request ID: {runError.providerRequestId}</small>}</span></div>}
        {Array.isArray(run.warnings) && run.warnings.length > 0 && <details className="checkout-warnings"><summary>Run limitations & test receipts</summary><ul>{run.warnings.map((warning, index) => <li key={index}>{safeUnifiedError(warning)}</li>)}</ul></details>}
        <div className="checkout-reconcile"><button className="button" disabled={!enabled || !!busy} onClick={refreshRun}><RefreshCw size={14} />Refresh run · read-only</button><button className="button" disabled={!enabled || !!busy || run.test !== true} onClick={reconcile}>{busy === 'reconcile' ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}Reconcile paid checkout</button></div><p className="checkout-fixture-note">Reconciliation is explicit and may dispatch missing Shopify test orders for an already-paid checkout. It does not authorize a replacement payment. Inspect uncertain results before retrying.</p>
      </div>}
      {checkoutReturn && <p className="checkout-fixture-note"><a href="/">Back to the normal checkout workspace</a> · Saved runs remain available below. Closing Stripe’s page does not itself cancel or refund a payment.</p>}
    </div>
    <div className="card-heading checkout-history-heading"><div><h3>Saved unified checkouts</h3><p>One payment reference and three store-specific Bags per run.</p></div><button className="button small" disabled={!enabled || !!busy || loadingRuns} onClick={loadRuns}>{loadingRuns ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Refresh runs</button></div>
    {runs.length ? <div className="table-wrap"><table><thead><tr><th>Run</th><th>Provider total</th><th>State</th><th>Updated</th><th>Inspect</th></tr></thead><tbody>{runs.slice(0, 20).map(saved => <tr key={saved.id}><td><code>{displayLabel(saved.id)}</code><small className="below">{Array.isArray(saved.bags) ? saved.bags.length : 0} brand Bags</small></td><td>{money(saved.amounts?.totalCents)}</td><td><Status state={saved.state} /></td><td>{date(saved.updatedAt)}</td><td><button className="button small" disabled={!!busy} onClick={() => openRun(saved.id)}>Open run</button></td></tr>)}</tbody></table></div> : <p className="checkout-no-runs">{loadingRuns ? 'Loading unified provider runs…' : 'No unified runs yet. Load the exact-store catalogs to begin.'}</p>}
  </section>;
}
