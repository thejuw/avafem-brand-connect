import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createStripeAdapter, STRIPE_API_VERSION, STRIPE_TAX_VALIDATION_FIELDS } from '../server/integrations/stripe.mjs';

const TAX = 'tax_fixtureOriginal123';
const REVERSED = 'tax_fixtureReversal123';
const taxLineId = number => `tax_li_fixtureLine${number.toString().padStart(8, '0')}`;
const line = (number = 1, overrides = {}) => ({ id: taxLineId(number), object: 'tax.transaction_line_item', amount: 800, amount_tax: 66,
  livemode: false, quantity: 4, reference: 'li_fixtureCheckout123', metadata: { private_note: 'PRIVATE_HEALTH' },
  product: 'prod_fixtureProduct123', tax_behavior: 'exclusive', tax_code: 'txcd_99999999', type: 'transaction', reversal: null, ...overrides });
const page = (data = [line()], overrides = {}) => ({ object: 'list', url: `/v1/tax/transactions/${TAX}/line_items`, has_more: false, data, ...overrides });
const transaction = (overrides = {}) => ({ id: TAX, object: 'tax.transaction', created: 1792411200, posted_at: 1792411200, tax_date: 1792411200,
  currency: 'usd', livemode: false, reference: 'cs_test_fixtureCheckout123', type: 'transaction', reversal: null,
  customer_details: { address: { line1: 'PRIVATE_ADDRESS' } }, metadata: { private_note: 'PRIVATE_HEALTH' },
  shipping_cost: { amount: 150, amount_tax: 12, tax_behavior: 'exclusive', tax_code: 'txcd_92010001' }, line_items: page(), ...overrides });
function fixture({ record = transaction(), pages = [page()], config = {}, failure } = {}) {
  const calls = []; let next = 0;
  const client = { tax: { transactions: {
    retrieve: async (...args) => { calls.push({ method: 'retrieve', args }); if (failure) throw failure; return structuredClone(record); },
    listLineItems: async (...args) => { calls.push({ method: 'listLineItems', args }); return structuredClone(pages[next++] ?? pages.at(-1)); },
    createReversal: () => assert.fail('A read must never create a tax reversal'),
    createFromCalculation: () => assert.fail('A read must never create a tax transaction'),
  } } };
  const adapter = createStripeAdapter({ env: {}, secretKey: 'sk_test_fixtureOnly1234567890', client, ...config });
  return { adapter, calls };
}

test('tax reads use pinned Endive retrieve SDK shape and return raw internal evidence without inventing payment linkage', async () => {
  const f = fixture(); const result = await f.adapter.getTaxTransaction(TAX);
  assert.equal(STRIPE_API_VERSION, '2026-09-30.endive');
  assert.deepEqual(f.calls, [{ method: 'retrieve', args: [TAX, { expand: ['line_items'] }] }]);
  assert.deepEqual(result, transaction());
  assert.equal(result.customer_details.address.line1, 'PRIVATE_ADDRESS', 'Raw data must stay internal/encrypted at the service boundary');
  assert.equal(result.payment_intent, undefined); assert.equal(result.refund, undefined);
  assert.equal(result.line_items.data[0].amount_tax, 66);
});

test('the real pinned Endive SDK serializes only GET tax retrieval and bounded line-pagination requests offline', async () => {
  const requests = [];
  const client = new Stripe('sk_test_fixtureOnly1234567890', { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (url, options) => {
      const parsed = new URL(url); requests.push({ url: parsed, method: options.method, version: new Headers(options.headers).get('stripe-version') });
      assert.equal(options.method, 'GET');
      const result = parsed.pathname.endsWith('/line_items') ? page() : transaction();
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_offlineTaxFixture123' } });
    }),
  });
  const adapter = createStripeAdapter({ env: {}, secretKey: 'sk_test_fixtureOnly1234567890', client });
  assert.equal((await adapter.listTaxTransactionLineItems(TAX)).data.length, 1);
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.version === STRIPE_API_VERSION));
  assert.equal(requests[0].url.pathname, `/v1/tax/transactions/${TAX}`);
  assert.equal(requests[0].url.searchParams.get('expand[0]'), 'line_items');
  assert.equal(requests[1].url.pathname, `/v1/tax/transactions/${TAX}/line_items`);
  assert.equal(requests[1].url.searchParams.get('limit'), '100');
  assert.equal(requests[1].url.searchParams.get('starting_after'), null);
});

test('tax reversal reads preserve native signed amounts and explicit tax-object provenance', async () => {
  const reversalLine = line(2, { amount: -200, amount_tax: -16, quantity: 1, type: 'reversal', reversal: { original_line_item: taxLineId(1) } });
  const record = transaction({ id: REVERSED, type: 'reversal', reversal: { original_transaction: TAX }, reference: 're_fixtureRefund123',
    line_items: page([reversalLine], { url: `/v1/tax/transactions/${REVERSED}/line_items` }),
    shipping_cost: { amount: -10, amount_tax: -1, tax_behavior: 'exclusive', tax_code: 'txcd_92010001' } });
  const f = fixture({ record }); const result = await f.adapter.getTaxTransaction(REVERSED);
  assert.equal(result.reversal.original_transaction, TAX); assert.equal(result.line_items.data[0].reversal.original_line_item, taxLineId(1));
  assert.equal(result.line_items.data[0].amount_tax, -16); assert.equal(result.shipping_cost.amount_tax, -1);
  assert.equal(f.calls.length, 1);
});

test('complete tax lines reverify parent mode and finish bounded SDK cursor pagination without mutation', async () => {
  const first = page([line(1)], { has_more: true }); const second = page([line(2)]);
  const f = fixture({ record: transaction({ line_items: first }), pages: [first, second] });
  const result = await f.adapter.listTaxTransactionLineItems(TAX);
  assert.deepEqual(result, page([line(1), line(2)]));
  assert.deepEqual(f.calls, [
    { method: 'retrieve', args: [TAX, { expand: ['line_items'] }] },
    { method: 'listLineItems', args: [TAX, { limit: 100 }] },
    { method: 'listLineItems', args: [TAX, { limit: 100, starting_after: taxLineId(1) }] },
  ]);
  assert.equal(result.has_more, false);
});

test('invalid and unbounded Tax IDs never call Stripe', async () => {
  for (const id of [null, '', 'tax_fake', 'tax_li_fixtureOriginal123', 'pi_fixtureOriginal123', 'tax_fixture/path123', `tax_${'a'.repeat(129)}`]) {
    const f = fixture();
    await assert.rejects(f.adapter.getTaxTransaction(id), { code: 'INVALID_INTEGRATION_INPUT' });
    await assert.rejects(f.adapter.listTaxTransactionLineItems(id), { code: 'INVALID_INTEGRATION_INPUT' });
    assert.equal(f.calls.length, 0);
  }
});

test('Tax helpers forbid live configuration and missing credentials even when other adapter operations opt into live', async () => {
  for (const config of [{ secretKey: 'sk_live_fixtureOnly1234567890', allowLive: true }, { allowLive: true }]) {
    const f = fixture({ config });
    await assert.rejects(f.adapter.getTaxTransaction(TAX), { code: 'INVALID_INTEGRATION_INPUT' });
    await assert.rejects(f.adapter.listTaxTransactionLineItems(TAX), { code: 'INVALID_INTEGRATION_INPUT' });
    assert.equal(f.calls.length, 0);
  }
  const unavailable = createStripeAdapter({ env: {} });
  await assert.rejects(unavailable.getTaxTransaction(TAX), { code: 'INTEGRATION_UNAVAILABLE' });
});

test('Tax transaction identity, exact TEST mode, currency, typed timestamps and reversal parent fail closed', async () => {
  for (const change of [
    value => { value.id = 'tax_otherOriginal123'; }, value => { value.object = 'payment_intent'; },
    value => { value.livemode = true; }, value => { delete value.livemode; }, value => { value.currency = 'eur'; },
    value => { value.created = '1792411200'; }, value => { value.posted_at = NaN; }, value => { value.tax_date = -1; },
    value => { value.type = 'unknown'; }, value => { value.reference = null; }, value => { value.reference = 'x'.repeat(501); },
    value => { value.reversal = { original_transaction: 'tax_otherOriginal123' }; },
    value => { value.type = 'reversal'; },
    value => { value.type = 'reversal'; value.reversal = { original_transaction: TAX }; },
    value => { value.type = 'reversal'; value.reversal = { original_transaction: 'pi_fixtureOriginal123' }; },
    value => { value.shipping_cost.amount_tax = Infinity; }, value => { value.shipping_cost.tax_behavior = 'unknown'; },
  ]) {
    const record = transaction(); change(record); const f = fixture({ record });
    await assert.rejects(f.adapter.getTaxTransaction(TAX)); assert.equal(f.calls.length, 1);
  }
});

test('Tax page validation rejects wrong parents, malformed/list modes, duplicate IDs and incomplete stalling pages', async () => {
  for (const change of [
    value => { value.url = '/v1/tax/transactions/tax_otherOriginal123/line_items'; },
    value => { value.id = 'tax_otherOriginal123'; }, value => { value.object = 'not_a_list'; },
    value => { delete value.has_more; }, value => { value.data = null; }, value => { value.has_more = true; value.data = []; },
    value => { value.data.push(line()); }, value => { value.data[0].id = 'tax_li_short'; },
    value => { value.data[0].object = 'line_item'; }, value => { value.data[0].livemode = true; },
    value => { delete value.data[0].livemode; }, value => { value.data[0].amount = 0.5; },
    value => { value.data[0].amount_tax = Number.MAX_SAFE_INTEGER + 1; }, value => { value.data[0].quantity = 0; },
    value => { value.data[0].tax_behavior = 'unknown'; }, value => { value.data[0].tax_code = 'private_tax_code'; },
    value => { value.data[0].type = 'reversal'; }, value => { value.data[0].reversal = { original_line_item: taxLineId(2) }; },
    value => { value.data = Array.from({ length: 101 }, (_, index) => line(index)); },
  ]) {
    const invalid = page(); change(invalid);
    const inline = fixture({ record: transaction({ line_items: invalid }) }); await assert.rejects(inline.adapter.getTaxTransaction(TAX));
    const listed = fixture({ pages: [invalid] }); await assert.rejects(listed.adapter.listTaxTransactionLineItems(TAX));
    assert.equal(listed.calls.filter(call => call.method === 'listLineItems').length, 1);
  }
});

test('repeated cross-page IDs and a provider that never completes cannot return a partial tax list', async () => {
  const duplicate = fixture({ pages: [page([line(1)], { has_more: true }), page([line(1)])] });
  await assert.rejects(duplicate.adapter.listTaxTransactionLineItems(TAX), { code: 'STRIPE_TAX_READBACK_MISMATCH' });
  assert.equal(duplicate.calls.length, 3);
  const unbounded = fixture({ pages: Array.from({ length: 10 }, (_, index) => page([line(index)], { has_more: true })) });
  await assert.rejects(unbounded.adapter.listTaxTransactionLineItems(TAX), { code: 'STRIPE_TAX_PAGINATION_REQUIRED' });
  assert.equal(unbounded.calls.length, 11);
});

test('Tax retrieval may omit inline expansion but the complete line helper still reads and verifies every line', async () => {
  const record = transaction(); delete record.line_items;
  const f = fixture({ record, pages: [page([])] });
  assert.equal((await f.adapter.getTaxTransaction(TAX)).line_items, undefined);
  assert.deepEqual(await f.adapter.listTaxTransactionLineItems(TAX), page([]));
  assert.equal(f.calls.length, 3);
});

test('Tax read errors expose only bounded diagnostic identifiers, never raw PII/error bodies or causes', async () => {
  const failure = Object.assign(new Error('PRIVATE_ADDRESS PRIVATE_HEALTH sk_test_PRIVATE_KEY'), {
    code: 'resource_missing', type: 'StripeInvalidRequestError', requestId: 'req_fixtureRequest123',
    raw: { message: 'PRIVATE_ADDRESS', customer: { email: 'PRIVATE_EMAIL' } }, param: 'PRIVATE_HEALTH', statusCode: 400,
  });
  const f = fixture({ failure });
  await assert.rejects(f.adapter.getTaxTransaction(TAX), error => {
    assert.equal(error.code, 'STRIPE_REQUEST_FAILED'); assert.equal(error.cause, undefined);
    assert.deepEqual(error.details, { stripeCode: 'resource_missing', type: 'StripeInvalidRequestError', requestId: 'req_fixtureRequest123' });
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /PRIVATE_|sk_test_|raw|param|cause/); return true;
  });
  const malicious = fixture({ failure: Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'sk_test_PRIVATE_KEY', type: 'PRIVATE HEALTH', requestId: 'req_bad PRIVATE_EMAIL' }) });
  await assert.rejects(malicious.adapter.getTaxTransaction(TAX), error => {
    assert.equal(error.details, undefined); assert.equal(error.cause, undefined); assert.doesNotMatch(JSON.stringify(error), /PRIVATE|sk_test/); return true;
  });
});

test('tax validation diagnostics expose only static failing field names and never rejected values or raw data', async () => {
  const record = transaction({ posted_at: 'PRIVATE_TIMESTAMP', reference: null,
    shipping_cost: { amount: 150, amount_tax: 'PRIVATE_TAX_AMOUNT', tax_behavior: 'exclusive', tax_code: 'txcd_92010001' } });
  const f = fixture({ record });
  await assert.rejects(f.adapter.getTaxTransaction(TAX), error => {
    assert.equal(error.code, 'STRIPE_TAX_READBACK_MISMATCH');
    assert.deepEqual(error.details, { validationFields: ['transaction.reference', 'transaction.posted_at', 'transaction.shipping_cost.amount_tax'] });
    assert.equal(error.cause, undefined); assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|customer|metadata|sk_test/); return true;
  });
  for (const [invalidPage, expected] of [
    [page([], { url: 'PRIVATE_URL' }), ['line_items.url']],
    [page([line(1, { amount_tax: 'PRIVATE_AMOUNT', reference: null })]), ['line_item.amount_tax', 'line_item.reference']],
    [page([], { has_more: true }), ['line_items.nonempty_cursor']],
    [page([line(), line()]), ['line_items.duplicate_id']],
  ]) {
    const candidate = fixture({ pages: [invalidPage] });
    await assert.rejects(candidate.adapter.listTaxTransactionLineItems(TAX), error => {
      assert.deepEqual(error.details.validationFields, expected);
      assert.ok(error.details.validationFields.every(field => STRIPE_TAX_VALIDATION_FIELDS.includes(field)));
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|customer|metadata|cause/); return true;
    });
  }
  const live = fixture({ record: transaction({ livemode: true }) });
  await assert.rejects(live.adapter.getTaxTransaction(TAX), error => {
    assert.equal(error.code, 'STRIPE_MODE_MISMATCH'); assert.deepEqual(error.details.validationFields, ['test_mode']); return true;
  });
});

test('only the exact SDK managed-transaction 404 for the requested Tax ID gets the static fallback classification', async () => {
  const managed = overrides => Object.assign(new Error(`The transaction you are trying to fetch is managed by Stripe: '${TAX}'. Provide the ID of a transaction you created.`), {
    type: 'StripeInvalidRequestError', statusCode: 404, requestId: 'req_managedFixture123',
    raw: { type: 'invalid_request_error', customer: 'PRIVATE_ADDRESS' }, ...overrides,
  });
  for (const method of ['getTaxTransaction', 'listTaxTransactionLineItems']) {
    const f = fixture({ failure: managed() });
    await assert.rejects(f.adapter[method](TAX), error => {
      assert.equal(error.code, 'STRIPE_MANAGED_TAX_READ_UNAVAILABLE'); assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, { type: 'StripeInvalidRequestError', requestId: 'req_managedFixture123' });
      assert.equal(error.cause, undefined); assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /tax_fixture|PRIVATE_|trying to fetch|Provide the ID|raw|cause/); return true;
    });
    assert.equal(f.calls.length, 1, 'Managed parent failure must stop before listing lines');
  }
  for (const failure of [
    managed({ statusCode: 400 }), managed({ statusCode: 403 }), managed({ type: 'StripeAPIError' }),
    managed({ message: `The transaction you are trying to fetch is managed by Stripe: '${REVERSED}'. Provide the ID of a transaction you created.` }),
    managed({ message: 'No such tax transaction: PRIVATE_ADDRESS' }),
    managed({ message: `The transaction you are trying to fetch is managed by Stripe: '${TAX}'. Provide the ID of a transaction you created. EXTRA` }),
  ]) {
    const f = fixture({ failure });
    await assert.rejects(f.adapter.getTaxTransaction(TAX), error => {
      assert.equal(error.code, 'STRIPE_REQUEST_FAILED'); assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|trying to fetch|EXTRA|raw|cause/); return true;
    });
  }
  for (const [record, code] of [[transaction({ livemode: true }), 'STRIPE_MODE_MISMATCH'],
    [transaction({ id: REVERSED }), 'STRIPE_TAX_READBACK_MISMATCH'], [transaction({ posted_at: 'bad' }), 'STRIPE_TAX_READBACK_MISMATCH']]) {
    const f = fixture({ record }); await assert.rejects(f.adapter.getTaxTransaction(TAX), { code });
  }
});

test('the exact managed-record classification also survives a line-endpoint SDK failure without relaxing validation', async () => {
  const client = { tax: { transactions: {
    retrieve: async () => transaction(), listLineItems: async () => { throw Object.assign(new Error(
      `The transaction you are trying to fetch is managed by Stripe: '${TAX}'. Provide the ID of a transaction you created.`),
    { type: 'StripeInvalidRequestError', statusCode: 404, requestId: 'req_managedLines123' }); },
  } } };
  const adapter = createStripeAdapter({ env: {}, secretKey: 'sk_test_fixtureOnly1234567890', client });
  await assert.rejects(adapter.listTaxTransactionLineItems(TAX), error => {
    assert.equal(error.code, 'STRIPE_MANAGED_TAX_READ_UNAVAILABLE'); assert.equal(error.cause, undefined);
    assert.equal(error.details.requestId, 'req_managedLines123'); assert.doesNotMatch(JSON.stringify(error), /trying to fetch|tax_fixture/); return true;
  });
});
