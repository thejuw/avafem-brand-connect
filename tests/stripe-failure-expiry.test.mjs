import test from 'node:test';
import assert from 'node:assert/strict';
import { createStripeAdapter } from '../server/integrations/stripe.mjs';
const id = 'cs_test_failureFixture123', orderId = `uco_${'e'.repeat(32)}`;
const baseline = () => ({ id, object: 'checkout.session', livemode: false, mode: 'payment', currency: 'usd',
  status: 'open', amount_total: 812, client_reference_id: orderId, metadata: { order_id: orderId, integration: 'avafem' } });
function fixture(overrides = {}, options = {}) {
  const calls = [], state = { current: { ...baseline(), ...overrides } };
  const stripe = createStripeAdapter({ secretKey: 'sk_test_fixtureOnly1234567890', client: { checkout: { sessions: {
    retrieve: async (...args) => { calls.push(['retrieve', ...args]); return structuredClone(state.current); },
    expire: async (...args) => { calls.push(['expire', ...args]); state.current.status = 'expired'; return structuredClone(state.current); },
  } } }, ...options }); return { stripe, calls, state };
}
test('failure Session expiration verifies exact TEST binding, uses stable idempotency and replays by read only', async () => {
  const f = fixture(); const result = await f.stripe.expireTestCheckoutSession({ sessionId: id, orderId });
  assert.equal(result.status, 'expired'); assert.deepEqual(f.calls[1], ['expire', id, {}, { idempotencyKey: `failure-expire:${orderId}:v1` }]);
  await f.stripe.expireTestCheckoutSession({ sessionId: id, orderId }); assert.equal(f.calls.filter(value => value[0] === 'expire').length, 1);
});
test('foreign, live, captured, oversized and malformed Sessions never dispatch expiration', async () => {
  for (const overrides of [{ livemode: true }, { mode: 'subscription' }, { currency: 'eur' }, { client_reference_id: 'foreign' },
    { metadata: {} }, { status: 'complete' }, { amount_total: 1001 }, { amount_total: null }]) {
    const f = fixture(overrides); await assert.rejects(f.stripe.expireTestCheckoutSession({ sessionId: id, orderId }));
    assert.equal(f.calls.filter(value => value[0] === 'expire').length, 0);
  }
  const f = fixture(); await assert.rejects(f.stripe.expireTestCheckoutSession({ sessionId: 'cs_live_other', orderId })); assert.equal(f.calls.length, 0);
});
test('failure expiration cannot opt into live mode even when legacy adapter methods can', async () => {
  for (const options of [{ allowLive: true }, { secretKey: 'sk_live_fixtureOnly1234567890', allowLive: true }]) {
    const f = fixture({}, options); await assert.rejects(f.stripe.expireTestCheckoutSession({ sessionId: id, orderId })); assert.equal(f.calls.length, 0);
  }
});
