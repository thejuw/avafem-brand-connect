import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyAdapter } from '../server/integrations/shopify.mjs';

function fixture(errors) {
  const calls = [];
  const adapter = createShopifyAdapter({ env: {}, accessToken: 'shpat_privateFixtureToken', fetch: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ errors }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  return { adapter, calls };
}
const orderId = 'gid://shopify/Order/1';

test('Shopify read errors expose only four bounded schema identifiers, including camelCase validation codes', async () => {
  const f = fixture([{ message: 'PRIVATE_ADDRESS customer@example.com shpat_privateFixtureToken', path: ['PRIVATE_PATH'],
    locations: [{ line: 99, column: 1 }], extensions: { code: 'undefinedField', typeName: 'Order', fieldName: 'nonexistentField', argumentName: 'first',
      query: 'PRIVATE_QUERY', variables: { address: 'PRIVATE_ADDRESS' }, value: 'PRIVATE_VALUE', accessToken: 'shpat_privateFixtureToken' } }]);
  await assert.rejects(f.adapter.getOrderOperations(orderId), error => {
    assert.equal(error.code, 'SHOPIFY_GRAPHQL_ERROR'); assert.equal(error.retryable, false);
    assert.deepEqual(error.details, { codes: [], schemaErrors: [{ code: 'undefinedField', typeName: 'Order', fieldName: 'nonexistentField', argumentName: 'first' }] });
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|customer@|shpat_|query|variables|locations|accessToken/);
    return true;
  });
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].query.startsWith('query'));
});

test('Shopify schema diagnostics drop non-identifiers, credential-like values, unknown keys and empty records', async () => {
  const f = fixture([
    { message: 'PRIVATE_MESSAGE', extensions: { code: 'bad code', typeName: 'Order.customer', fieldName: 'mail@example.com', argumentName: 'first\nprivate' } },
    { extensions: { code: 'SK_TEST_PRIVATESECRET', typeName: 'shpat_privateFixtureToken', fieldName: 'clientSecret', argumentName: 'BearerToken' } },
    { extensions: { code: 'a'.repeat(81), typeName: { name: 'Order' }, fieldName: ['id'], argumentName: 3 } },
    { extensions: { code: 'argumentNotAccepted', typeName: 'Order', fieldName: 'fulfillments', argumentName: 'first' } },
    null,
  ]);
  await assert.rejects(f.adapter.getOrderOperations(orderId), error => {
    assert.deepEqual(error.details, { codes: [], schemaErrors: [{ code: 'argumentNotAccepted', typeName: 'Order', fieldName: 'fulfillments', argumentName: 'first' }] });
    assert.doesNotMatch(JSON.stringify(error.details), /PRIVATE|Secret|Bearer|shpat_|example|\["id"\]/);
    return true;
  });
});

test('Shopify diagnostics are bounded to ten entries and preserve existing throttle retry classification', async () => {
  const f = fixture(Array.from({ length: 100 }, () => ({ extensions: { code: 'THROTTLED', typeName: 'Order' }, message: 'PRIVATE_MESSAGE' })));
  await assert.rejects(f.adapter.getOrderOperations(orderId), error => {
    assert.equal(error.retryable, true); assert.equal(error.details.codes.length, 10); assert.equal(error.details.schemaErrors.length, 10);
    assert.deepEqual(error.details.schemaErrors[0], { code: 'THROTTLED', typeName: 'Order' }); return true;
  });
});
