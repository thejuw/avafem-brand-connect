/** Local provider worker. It polls only frozen TEST runs, never sandbox fixture
 * money or replacement operations. New settlement/payout remains manual by
 * default; only the separately configured per-run automation service may advance
 * it, including its immutable post-transfer-refund evidence gates. */
export function createProviderJobs(db, { unifiedCheckout, providerEvents, providerFulfillment, providerMoney,
  catalog, reconciliation, taxReconciliation, automation, clock = () => Date.now() } = {}) {
  let running = false;
  let lastLifecyclePoll = -Infinity;
  let lastCatalogPoll = -Infinity;
  async function run() {
    if (running) return { processing: true };
    running = true;
    try {
      const events = await providerEvents.processPending();
      const rows = (await db.query(`SELECT * FROM unified_checkout_runs WHERE checkout_dispatch_complete=false AND state IN
        ('checkout_creating','checkout_open','checkout_needs_review','authorized','capture_pending','paid','dispatching','needs_review')
        ORDER BY updated_at,created_at LIMIT 5`)).rows;
      const checkouts = [];
      for (const row of rows) {
        try {
          const result = await unifiedCheckout.reconcile(row.id);
          checkouts.push({ id: row.id, state: result.state, processing: result.processing === true });
        } catch { checkouts.push({ id: row.id, state: 'checkout_reconciliation_pending' }); }
      }
      const lifecycle = [];
      if (clock() - lastLifecyclePoll >= 60_000) {
        lastLifecyclePoll = clock();
        const paid = (await db.query(`SELECT * FROM unified_checkout_runs WHERE charge_id IS NOT NULL ORDER BY created_at DESC LIMIT 20`)).rows;
        for (const row of paid) {
          let decoded;
          try { decoded = unifiedCheckout.runtime.decode(row); }
          catch { lifecycle.push({ id: row.id, state: 'run_decode_review' }); continue; }
          const { snapshot, details } = decoded;
          if (!details.canonicalCommitted) continue;
          for (const bag of snapshot.bags) if (details.bags?.[bag.id]?.verified) {
            try { await providerFulfillment.sync({ runId: row.id, bagId: bag.id }); }
            catch { lifecycle.push({ id: row.id, bagId: bag.id, state: 'provider_sync_pending' }); }
          }
          try {
            const result = await providerMoney.reconcile({ runId: row.id });
            lifecycle.push({ id: row.id, state: result.state });
          } catch { lifecycle.push({ id: row.id, state: 'provider_money_pending' }); }
        }
        if (catalog && clock() - lastCatalogPoll >= 900_000) {
          lastCatalogPoll = clock();
          try { await catalog.syncAll(); } catch { lifecycle.push({ state: 'catalog_sync_pending' }); }
        }
        if (reconciliation) {
          try { await reconciliation.runNightly(); } catch { lifecycle.push({ state: 'nightly_reconciliation_pending' }); }
        }
        if (taxReconciliation) {
          try { await taxReconciliation.runNightly(); } catch { lifecycle.push({ state: 'nightly_tax_reconciliation_pending' }); }
        }
      }
      let automaticMoney;
      if (automation) {
        try { automaticMoney = await automation.runDue({ limit: 5 }); }
        catch { automaticMoney = { test: true, outcome: 'automation_review_hold', checked: 0 }; }
      }
      return { events, checkouts, lifecycle, ...(automaticMoney ? { automaticMoney } : {}) };
    } finally { running = false; }
  }
  return { run };
}
