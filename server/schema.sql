CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  commission_bps INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('invited','onboarding','ready','live','paused','disconnected')),
  connection_tier TEXT NOT NULL DEFAULT 'dashboard' CHECK (connection_tier IN ('dashboard','shopify','api','woocommerce','bigcommerce')),
  agreement_signed BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_account_id TEXT, charges_enabled BOOLEAN NOT NULL DEFAULT FALSE, payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  return_window_days INTEGER NOT NULL DEFAULT 30 CHECK (return_window_days BETWEEN 0 AND 365),
  ship_from_address JSONB NOT NULL DEFAULT '{}', shipping_table JSONB NOT NULL DEFAULT '[]',
  support_email TEXT NOT NULL DEFAULT '', test_order_passed BOOLEAN NOT NULL DEFAULT FALSE,
  connection_healthy BOOLEAN NOT NULL DEFAULT FALSE, sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), sku TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0), inventory_qty INTEGER NOT NULL DEFAULT 0 CHECK (inventory_qty >= 0),
  images JSONB NOT NULL DEFAULT '[]', variants JSONB NOT NULL DEFAULT '[]', evidence JSONB NOT NULL DEFAULT '{}',
  tax_code TEXT NOT NULL DEFAULT '', shipping_profile TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','rejected')),
  validation_issues JSONB NOT NULL DEFAULT '[]', review_note TEXT NOT NULL DEFAULT '',
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (brand_id,sku)
);
ALTER TABLE brands ADD COLUMN IF NOT EXISTS onboarding_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (onboarding_mode IN ('legacy','two_step'));
ALTER TABLE brands ADD COLUMN IF NOT EXISTS payout_setup TEXT NOT NULL DEFAULT 'pending' CHECK (payout_setup IN ('deferred','pending','complete'));
ALTER TABLE brands ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS auto_approve_products BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS return_policy TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS collections JSONB NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS source_provider TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source_product_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source_catalog_key TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source_deleted_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS review_fingerprint TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reviewed_fingerprint TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS compliance_result JSONB NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS compliance_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS products_brand_status ON products(brand_id,status);
CREATE TABLE IF NOT EXISTS compliance_overrides (product_id TEXT PRIMARY KEY,reason TEXT NOT NULL,actor TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS curation_audit (
  id TEXT PRIMARY KEY,operation_id TEXT,brand_id TEXT NOT NULL REFERENCES brands(id),product_id TEXT,
  actor TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,fingerprint TEXT,payload JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, order_ref TEXT NOT NULL UNIQUE, currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  status TEXT NOT NULL DEFAULT 'paid', subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents>=0),
  shipping_cents INTEGER NOT NULL CHECK (shipping_cents>=0), tax_cents INTEGER NOT NULL CHECK (tax_cents>=0),
  total_cents INTEGER NOT NULL CHECK (total_cents=subtotal_cents+shipping_cents+tax_cents),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents BETWEEN 0 AND total_cents),
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS bags (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), brand_id TEXT NOT NULL REFERENCES brands(id),
  status TEXT NOT NULL DEFAULT 'awaiting_shipment' CHECK (status IN ('awaiting_shipment','shipped','delivered','refunded','cancelled')),
  items JSONB NOT NULL, ship_to JSONB NOT NULL, shipping_method TEXT NOT NULL DEFAULT 'standard',
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents>=0), shipping_cents INTEGER NOT NULL CHECK (shipping_cents>=0),
  tax_cents INTEGER NOT NULL CHECK (tax_cents>=0), commission_cents INTEGER NOT NULL CHECK (commission_cents BETWEEN 0 AND subtotal_cents),
  transfer_cents INTEGER NOT NULL CHECK (transfer_cents=subtotal_cents-commission_cents+shipping_cents),
  total_cents INTEGER NOT NULL CHECK (total_cents=subtotal_cents+shipping_cents+tax_cents),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents BETWEEN 0 AND total_cents),
  ship_by TIMESTAMPTZ NOT NULL, delivered_at TIMESTAMPTZ, payout_due_at TIMESTAMPTZ,
  return_window_days INTEGER NOT NULL DEFAULT 30,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(order_id,brand_id)
);
CREATE INDEX IF NOT EXISTS bags_brand_status ON bags(brand_id,status);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, bag_id TEXT NOT NULL REFERENCES bags(id), brand_id TEXT NOT NULL REFERENCES brands(id),
  carrier TEXT NOT NULL, tracking_number TEXT NOT NULL, tracking_url TEXT,
  items JSONB NOT NULL DEFAULT '[]', shipped_at TIMESTAMPTZ NOT NULL,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(bag_id,carrier,tracking_number)
);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY, bag_id TEXT NOT NULL UNIQUE REFERENCES bags(id), brand_id TEXT NOT NULL REFERENCES brands(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents>=0), reversed_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('scheduled','held','paid','cancelled','reversed')),
  due_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox),
  CHECK (reversed_cents BETWEEN 0 AND amount_cents), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS credits (
  id TEXT PRIMARY KEY, bag_id TEXT NOT NULL UNIQUE REFERENCES bags(id), brand_id TEXT NOT NULL REFERENCES brands(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents>=0),
  status TEXT NOT NULL CHECK (status IN ('pending','released','voided')),
  released_at TIMESTAMPTZ, voided_at TIMESTAMPTZ,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, bag_id TEXT NOT NULL REFERENCES bags(id), brand_id TEXT NOT NULL REFERENCES brands(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents>0), reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  requires_approval BOOLEAN NOT NULL DEFAULT TRUE CHECK(requires_approval), approved_at TIMESTAMPTZ,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS subtotal_cents INTEGER CHECK (subtotal_cents>=0);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS shipping_cents INTEGER CHECK (shipping_cents>=0);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS tax_cents INTEGER CHECK (tax_cents>=0);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS commission_cents INTEGER CHECK (commission_cents>=0);
-- Historical full-Bag refunds have exact canonical allocations. Do not guess
-- allocations for legacy partial refunds: reporting marks those incomplete.
UPDATE refunds r SET subtotal_cents=b.subtotal_cents,shipping_cents=b.shipping_cents,
  tax_cents=b.tax_cents,commission_cents=b.commission_cents FROM bags b
  WHERE r.bag_id=b.id AND r.status='approved' AND r.amount_cents=b.total_cents
  AND r.subtotal_cents IS NULL AND r.shipping_cents IS NULL AND r.tax_cents IS NULL AND r.commission_cents IS NULL;
CREATE TABLE IF NOT EXISTS ledger_journals (
  id TEXT PRIMARY KEY, business_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, bag_id TEXT REFERENCES bags(id),
  brand_id TEXT REFERENCES brands(id), total_debit_cents INTEGER NOT NULL CHECK(total_debit_cents>0),
  total_credit_cents INTEGER NOT NULL CHECK(total_credit_cents=total_debit_cents),
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, journal_id TEXT NOT NULL REFERENCES ledger_journals(id), account TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK(debit_cents>=0), credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(credit_cents>=0),
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK(sandbox),
  CHECK ((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0))
);
CREATE INDEX IF NOT EXISTS ledger_entries_journal ON ledger_entries(journal_id);
CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  aggregate_id TEXT NOT NULL, brand_id TEXT REFERENCES brands(id), payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ, last_error TEXT,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, bag_id TEXT NOT NULL REFERENCES bags(id),
  status TEXT NOT NULL CHECK(status IN ('scheduled','held','completed','cancelled','failed')),
  due_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  sandbox BOOLEAN NOT NULL DEFAULT TRUE CHECK (sandbox), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(kind,bag_id)
);

-- Upgrade earlier local builds without shortening a previously promised hold.
-- Existing snapshots stay immutable; only missing values are backfilled.
ALTER TABLE brands ALTER COLUMN return_window_days SET DEFAULT 30;
ALTER TABLE bags ADD COLUMN IF NOT EXISTS return_window_days INTEGER;
UPDATE bags b SET return_window_days=GREATEST(7,COALESCE(br.return_window_days,30))
  FROM brands br WHERE b.brand_id=br.id AND b.return_window_days IS NULL;
ALTER TABLE bags ALTER COLUMN return_window_days SET DEFAULT 30;
ALTER TABLE bags ALTER COLUMN return_window_days SET NOT NULL;
-- Real provider TEST orders share the canonical core but may never enter the
-- synthetic checkout/refund/payout workers merely because sandbox=true.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_bound BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bags ADD COLUMN IF NOT EXISTS provider_bound BOOLEAN NOT NULL DEFAULT false;
UPDATE bags b SET payout_due_at=GREATEST(b.payout_due_at,
  (SELECT t.due_at FROM transfers t WHERE t.bag_id=b.id),
  (SELECT j.due_at FROM jobs j WHERE j.bag_id=b.id AND j.kind='sandbox_payout'),
  b.delivered_at+GREATEST(7,b.return_window_days,br.return_window_days)*INTERVAL '1 day')
  FROM brands br WHERE br.id=b.brand_id AND b.delivered_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM transfers t WHERE t.bag_id=b.id AND t.status IN ('scheduled','held'));
UPDATE transfers t SET due_at=GREATEST(t.due_at,b.payout_due_at)
  FROM bags b WHERE b.id=t.bag_id AND b.payout_due_at IS NOT NULL AND t.status IN ('scheduled','held');
UPDATE jobs j SET due_at=GREATEST(j.due_at,b.payout_due_at)
  FROM bags b WHERE b.id=j.bag_id AND b.payout_due_at IS NOT NULL
  AND j.kind='sandbox_payout' AND j.status IN ('scheduled','held','failed');
