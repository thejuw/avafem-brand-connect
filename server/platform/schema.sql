CREATE TABLE IF NOT EXISTS curation_audit (
  id TEXT PRIMARY KEY,operation_id TEXT,brand_id TEXT NOT NULL REFERENCES brands(id),product_id TEXT,
  actor TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,fingerprint TEXT,payload JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS curation_audit_brand ON curation_audit(brand_id,created_at,id);
CREATE TABLE IF NOT EXISTS curation_operations (
  operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,response JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS onboarding_operations (
  brand_id TEXT NOT NULL REFERENCES brands(id),operation_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(brand_id,operation_id)
);
CREATE TABLE IF NOT EXISTS brand_invite_deliveries (
  id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),invite_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,error_code TEXT,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL
);
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
ALTER TABLE segments ADD COLUMN IF NOT EXISTS health BOOLEAN;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS health BOOLEAN;
CREATE TABLE IF NOT EXISTS message_outbox (
  id TEXT PRIMARY KEY, campaign_id TEXT, shopper_id TEXT NOT NULL, channel TEXT NOT NULL, recipient_enc TEXT NOT NULL,
  recipient_hint TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'simulated' CHECK (status IN ('simulated')), created_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS contains_health BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS body_enc TEXT;
ALTER TABLE message_outbox ADD COLUMN IF NOT EXISTS protection_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS message_outbox_legacy_protection ON message_outbox(id) WHERE protection_version<2;
CREATE INDEX IF NOT EXISTS message_outbox_shopper_created ON message_outbox(shopper_id,created_at,id);
CREATE INDEX IF NOT EXISTS message_outbox_created ON message_outbox(created_at,id);
CREATE TABLE IF NOT EXISTS health_outbox_migrations (
  id TEXT PRIMARY KEY,key_verifier_enc TEXT NOT NULL,processed_count INTEGER NOT NULL DEFAULT 0,completed_at TIMESTAMPTZ
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
CREATE TABLE IF NOT EXISTS bank_lots (
  id TEXT PRIMARY KEY, shopper_id TEXT NOT NULL REFERENCES shoppers(id), bag_id TEXT, source TEXT NOT NULL CHECK (source IN ('purchase','goodwill','promo')),
  state TEXT NOT NULL CHECK (state IN ('LAB','VAULT','REVERSED','EXPIRED')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents>0), remaining_cents INTEGER NOT NULL CHECK (remaining_cents BETWEEN 0 AND amount_cents),
  matures_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, source_key TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_lots_shopper ON bank_lots(shopper_id,state);
CREATE TABLE IF NOT EXISTS bank_events (id BIGSERIAL PRIMARY KEY, lot_id TEXT, shopper_id TEXT NOT NULL, kind TEXT NOT NULL, from_state TEXT, to_state TEXT, amount_cents INTEGER NOT NULL, ref TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS bank_redemptions (id TEXT PRIMARY KEY, shopper_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK (amount_cents>0), idempotency_key TEXT NOT NULL UNIQUE, allocations JSONB NOT NULL, order_ref TEXT, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, bag_id TEXT NOT NULL, brand_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK (amount_cents>0),
  reason TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('needs_response','under_review','won','lost')),
  evidence JSONB NOT NULL DEFAULT '{}', respond_by TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL, resource_id TEXT, message TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, acknowledged_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS risk_assessments (id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT, score INTEGER NOT NULL, decision TEXT NOT NULL, signals JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS brand_applications (
  brand_id TEXT PRIMARY KEY, contact_enc TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS brand_connectors (
  brand_id TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('shopify','woocommerce','bigcommerce','csv')),
  credentials_enc TEXT, store_ref TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'connected', last_sync_at TIMESTAMPTZ, last_result JSONB,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (brand_id, platform)
);
CREATE TABLE IF NOT EXISTS connector_orders (bag_id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, platform TEXT NOT NULL, external_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS connector_dispatch_attempts (
  id TEXT PRIMARY KEY,bag_id TEXT NOT NULL REFERENCES bags(id),brand_id TEXT NOT NULL,platform TEXT NOT NULL,target_ref TEXT NOT NULL,
  state TEXT NOT NULL,snapshot_enc TEXT NOT NULL,snapshot_hash TEXT NOT NULL,external_id TEXT,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_dispatch_attempts_bag ON connector_dispatch_attempts(bag_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS connector_dispatch_attempts_live_bag ON connector_dispatch_attempts(bag_id) WHERE state IN ('pending','uncertain','created','confirmed');
CREATE TABLE IF NOT EXISTS connector_order_recoveries (
  operation_id TEXT PRIMARY KEY,bag_id TEXT NOT NULL REFERENCES bags(id),attempt_id TEXT NOT NULL REFERENCES connector_dispatch_attempts(id),
  action TEXT NOT NULL,external_id TEXT NOT NULL,request_hash TEXT NOT NULL,reason_enc TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL,
  proof_enc TEXT,result JSONB,lease_token TEXT,lease_expires_at TIMESTAMPTZ,retry_consumed_by TEXT,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS placements (
  id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('featured_spot','sponsored_swipe','sampling_box')),
  product_id TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL, units INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL CHECK (price_cents>=0), status TEXT NOT NULL CHECK (status IN ('requested','approved','rejected','cancelled')),
  impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_records (
  id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, placement_id TEXT NOT NULL UNIQUE REFERENCES placements(id), amount_cents INTEGER NOT NULL CHECK (amount_cents>=0),
  status TEXT NOT NULL CHECK (status IN ('invoiced','paid','void')), method TEXT NOT NULL DEFAULT 'invoice', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, shopper_id TEXT NOT NULL REFERENCES shoppers(id), status TEXT NOT NULL CHECK (status IN ('active','paused','past_due','cancelled')),
  interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 7 AND 180), align_to_cycle BOOLEAN NOT NULL DEFAULT FALSE,
  items JSONB NOT NULL, ship_to_enc TEXT, payment_ref TEXT NOT NULL, provider_ref TEXT NOT NULL, cycle_count INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_run_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_runs (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, cycle INTEGER NOT NULL, status TEXT NOT NULL, order_id TEXT, charge_ref TEXT, amount_cents INTEGER, error TEXT, created_at TIMESTAMPTZ NOT NULL, UNIQUE(subscription_id,cycle,status));
CREATE TABLE IF NOT EXISTS subscription_attempts (
  id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  cycle INTEGER NOT NULL CHECK (cycle>0), attempt INTEGER NOT NULL CHECK (attempt>0), status TEXT NOT NULL,
  amount_cents INTEGER, order_id TEXT REFERENCES orders(id), charge_ref TEXT, error TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(subscription_id,cycle,attempt)
);
ALTER TABLE subscription_attempts ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE subscription_attempts ADD COLUMN IF NOT EXISTS charge_evidence_enc TEXT;
CREATE TABLE IF NOT EXISTS subscription_review_actions (
  operation_id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES subscriptions(id),attempt_id TEXT REFERENCES subscription_attempts(id),
  action TEXT NOT NULL,state TEXT NOT NULL,request_hash TEXT NOT NULL,actor TEXT NOT NULL,reason_enc TEXT NOT NULL,proof_enc TEXT,response JSONB,
  created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS subscription_review_actions_subscription ON subscription_review_actions(subscription_id,created_at);
CREATE TABLE IF NOT EXISTS financial_resolutions (
  id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,kind TEXT NOT NULL,action TEXT NOT NULL,
  bag_id TEXT NOT NULL REFERENCES bags(id),transfer_id TEXT,dispute_id TEXT,credit_id TEXT,actor TEXT NOT NULL,reason_enc TEXT NOT NULL,
  recovery_reference TEXT,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_resolutions_dispute ON financial_resolutions(dispute_id) WHERE kind='lost_dispute';
CREATE TABLE IF NOT EXISTS shipping_rules (id TEXT PRIMARY KEY, free_threshold_cents INTEGER NOT NULL CHECK (free_threshold_cents>=0), enabled BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS shipping_subsidies (bag_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, brand_id TEXT NOT NULL, shipping_cents INTEGER NOT NULL, funded_from_commission_cents INTEGER NOT NULL, absorbed_cents INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS privacy_requests (id TEXT PRIMARY KEY, shopper_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('export','delete')), status TEXT NOT NULL, result JSONB, requested_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS compliance_overrides (product_id TEXT PRIMARY KEY, reason TEXT NOT NULL, actor TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
-- Repair copies left by the previous erasure implementation, including shoppers
-- whose tombstones correctly prevent a second interactive erasure request.
UPDATE subscriptions SET ship_to_enc=NULL,status='cancelled'
  WHERE shopper_id IN (SELECT id FROM shoppers WHERE deleted_at IS NOT NULL);
UPDATE support_tickets SET subject='[erased]',messages=(SELECT COALESCE(jsonb_agg(jsonb_set(m,'{body}','"[erased]"')),'[]'::jsonb) FROM jsonb_array_elements(messages) m)
  WHERE shopper_id IN (SELECT id FROM shoppers WHERE deleted_at IS NOT NULL);
UPDATE message_outbox SET subject='[erased]',body='[erased]',body_enc=NULL,recipient_enc='erased',recipient_hint='erased'
  WHERE shopper_id IN (SELECT id FROM shoppers WHERE deleted_at IS NOT NULL);
