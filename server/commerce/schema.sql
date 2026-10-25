CREATE TABLE IF NOT EXISTS commerce_checkouts (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','paid','cancelled','expired')),
  brand_ids JSONB NOT NULL, policy_version INTEGER NOT NULL,
  snapshot_encrypted TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  order_id TEXT UNIQUE REFERENCES orders(id), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS commerce_external_holds (
  checkout_id TEXT NOT NULL REFERENCES commerce_checkouts(id), reference TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id), variant_key TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0),
  state TEXT NOT NULL CHECK(state IN ('reserved','committed','released','expired')), PRIMARY KEY(checkout_id,reference)
);
CREATE TABLE IF NOT EXISTS commerce_bag_allocations (
  bag_id TEXT PRIMARY KEY REFERENCES bags(id), checkout_id TEXT NOT NULL REFERENCES commerce_checkouts(id),
  brand_id TEXT NOT NULL REFERENCES brands(id), model TEXT NOT NULL CHECK(model IN ('partner','first_party')),
  terms JSONB NOT NULL, allocation JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS commerce_fulfillment_orders (
  id TEXT PRIMARY KEY, bag_id TEXT UNIQUE NOT NULL REFERENCES bags(id), brand_id TEXT NOT NULL REFERENCES brands(id),
  fulfiller TEXT NOT NULL CHECK(fulfiller IN ('avafem','partner')),
  state TEXT NOT NULL CHECK(state IN ('open','partially_shipped','shipped','delivered','cancelled')),
  items JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS commerce_operations (
  operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, kind TEXT NOT NULL,
  result JSONB NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS commerce_return_inspections (
  id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, bag_id TEXT NOT NULL REFERENCES bags(id),
  reference TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), disposition TEXT NOT NULL CHECK(disposition IN ('restock','quarantine')),
  unit_cost_cents INTEGER NOT NULL CHECK(unit_cost_cents>=0), actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS commerce_external_stock ON commerce_external_holds(product_id,variant_key,state);
CREATE INDEX IF NOT EXISTS commerce_fulfillment_brand ON commerce_fulfillment_orders(brand_id,state);
