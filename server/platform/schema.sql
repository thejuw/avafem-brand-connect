CREATE TABLE IF NOT EXISTS shoppers (
  id TEXT PRIMARY KEY, email_hash TEXT UNIQUE, email_enc TEXT, profile_enc TEXT,
  consent JSONB NOT NULL DEFAULT '{"email":false,"sms":false,"marketing":false,"health":false}',
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS shopper_orders (
  shopper_id TEXT NOT NULL REFERENCES shoppers(id), order_id TEXT NOT NULL, bag_id TEXT NOT NULL UNIQUE,
  brand_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (shopper_id,bag_id)
);
CREATE TABLE IF NOT EXISTS health_records (shopper_id TEXT PRIMARY KEY REFERENCES shoppers(id), data_enc TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS health_access_log (id BIGSERIAL PRIMARY KEY, shopper_id TEXT NOT NULL, actor TEXT NOT NULL, purpose TEXT NOT NULL, action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS swipe_likes (shopper_id TEXT NOT NULL REFERENCES shoppers(id), product_id TEXT NOT NULL, liked BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(shopper_id,product_id));
CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, name TEXT NOT NULL, rules JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('broadcast','restock_reminder')),
  segment_id TEXT REFERENCES segments(id), channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  template TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS message_outbox (
  id TEXT PRIMARY KEY, campaign_id TEXT, shopper_id TEXT NOT NULL, channel TEXT NOT NULL, recipient_enc TEXT NOT NULL,
  recipient_hint TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'simulated' CHECK (status IN ('simulated')), created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY, shopper_id TEXT REFERENCES shoppers(id), order_id TEXT, bag_id TEXT, brand_id TEXT, shipment_id TEXT,
  subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_brand','resolved')),
  messages JSONB NOT NULL DEFAULT '[]', actions JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS support_tickets_brand ON support_tickets(brand_id,status);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, shopper_id TEXT NOT NULL REFERENCES shoppers(id), bag_id TEXT NOT NULL, brand_id TEXT NOT NULL, product_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), body TEXT NOT NULL DEFAULT '', photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')), synced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(shopper_id,bag_id,product_id)
);
CREATE TABLE IF NOT EXISTS brand_sync_feed (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, UNIQUE(kind,resource_id));
