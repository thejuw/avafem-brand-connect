import { randomUUID } from 'node:crypto';
import { checkProduct, productReviewFingerprint } from './platform/compliance.mjs';

const DAY = 86_400_000;
const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const json = value => JSON.stringify(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])) : value;
const equal = (left,right) => json(stable(left))===json(stable(right));
const camel = key => key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
const record = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [camel(key), value instanceof Date ? value.toISOString() : value]));
const records = rows => rows.map(record);
const first = async (tx, sql, params = []) => record((await tx.query(sql, params)).rows[0]);
const rows = async (tx, sql, params = []) => records((await tx.query(sql, params)).rows);
const fail = (message, statusCode = 422, code = 'VALIDATION_ERROR') => {
  const error = new Error(message); Object.assign(error, { statusCode, code }); throw error;
};
const integer = (value, name, min = 0, max = 2_000_000_000) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}.`);
  return value;
};
const text = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const https = value => { try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; } };
const address = value => {
  const input = value || {};
  // An allow-list intentionally excludes customer email, arbitrary metadata,
  // cycle information, health notes and any other shopper-supplied fields.
  const result = {};
  for (const key of ['name','line1','line2','city','region','postal','country','phone'])
    if (input[key] != null) result[key] = text(input[key], 250);
  for (const key of ['name','line1','city','region','postal','country'])
    if (!result[key]) fail(`shipTo.${key} is required.`);
  if (result.country !== 'US') fail('The sandbox shipping fixture supports US addresses only.');
  return result;
};

/** Sandbox business core. Amounts are integer USD cents. Optional brandId
 * arguments constrain reads and writes to that tenant; admin authorization is
 * supplied by the HTTP layer. Every mutation and its outbox event commit together. */
export function createDomain(db, { clock = () => new Date(), protectShipping, revealShipping, beforeProductApproval, verifyTwoStepPayout } = {}) {
  const now = () => new Date(typeof clock === 'function' ? clock() : clock.now());
  const iso = () => now().toISOString();
  const protectedAddress=value=>value && typeof value==='object' && Object.hasOwn(value,'encryptedShipping');
  async function protectAddress(value) {
    if (protectedAddress(value)) return value;
    if (typeof protectShipping!=='function') return value;
    const ciphertext=await protectShipping(value);
    if (typeof ciphertext!=='string' || !ciphertext) fail('Shipping encryption did not return protected data.',500,'SHIPPING_PROTECTION_FAILED');
    return {encryptedShipping:ciphertext};
  }
  async function revealAddress(value) {
    if (!protectedAddress(value)) return value;
    if (typeof revealShipping!=='function' || typeof value.encryptedShipping!=='string' || !value.encryptedShipping)
      fail('The shipping encryption key is required to read this order.',503,'SHIPPING_KEY_REQUIRED');
    try { return address(await revealShipping(value.encryptedShipping)); }
    catch { fail('Protected shipping data could not be opened.',503,'SHIPPING_KEY_REQUIRED'); }
  }
  const event = async (tx, type, aggregateId, brandId, payload = {}) => first(tx,
    `INSERT INTO outbox_events (id,type,aggregate_id,brand_id,payload,created_at,available_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [id('evt'), type, aggregateId, brandId || null, json({ ...payload, sandbox: true }), iso()]);
  const brandRow = async (tx, brandId) => {
    const brand = await first(tx, 'SELECT * FROM brands WHERE id=$1', [brandId]);
    if (!brand) fail('Brand not found.', 404, 'NOT_FOUND');
    return brand;
  };
  const owned = async (tx, table, key, brandId) => {
    const row = await first(tx, `SELECT * FROM ${table} WHERE id=$1${brandId ? ' AND brand_id=$2' : ''}`, brandId ? [key, brandId] : [key]);
    if (!row) fail(`${table === 'bags' ? 'Bag' : table === 'products' ? 'Product' : 'Record'} not found.`, 404, 'NOT_FOUND');
    return row;
  };
  async function requirements(tx, brand) {
    if((await first(tx,"SELECT to_regclass('commerce_brand_policy_versions') AS relation")).relation){
      const policy=await first(tx,'SELECT config FROM commerce_brand_policy_versions WHERE brand_id=$1 ORDER BY version DESC LIMIT 1',[brand.id]);
      if(policy?.config?.model==='first_party'){
        const missing=[];
        if(!brand.shipFromAddress?.line1||!brand.shipFromAddress?.postal)missing.push('Avafem warehouse ship-from address');
        if(!brand.supportEmail)missing.push('Support contact');
        const nativeTable=(await first(tx,"SELECT to_regclass('commerce_native_variants') AS relation")).relation;
        const approved=nativeTable?await first(tx,`SELECT COUNT(*)::int AS count FROM products p
          JOIN commerce_native_variants v ON v.product_id=p.id WHERE p.brand_id=$1 AND p.status='approved' AND p.source_deleted_at IS NULL`,[brand.id]):{count:0};
        if(!approved.count)missing.push('Approved product with a native variant');
        return missing;
      }
    }
    if (brand.onboardingMode === 'two_step') {
      const missing = [];
      if (!brand.agreementSigned) missing.push('Signed brand agreement');
      if (!brand.connectionHealthy || brand.status === 'disconnected' || !brand.onboardingState?.connected) missing.push('Healthy verified store connection');
      if (!brand.onboardingState?.profileVerified) missing.push('Verified connected profile');
      if (!brand.onboardingState?.catalogImportComplete) missing.push('Complete catalog import');
      return missing;
    }
    const approved = (await first(tx, "SELECT COUNT(*)::integer AS count FROM products WHERE brand_id=$1 AND status='approved'", [brand.id])).count;
    const missing = [];
    if (!brand.agreementSigned) missing.push('Signed brand agreement');
    if (!brand.stripeAccountId || !brand.chargesEnabled || !brand.payoutsEnabled) missing.push('Sandbox Express onboarding');
    if (!brand.shipFromAddress?.line1 || !brand.shipFromAddress?.postal) missing.push('Ship-from address');
    if (!brand.shippingTable?.length) missing.push('Shipping table');
    if (!brand.supportEmail) missing.push('Support contact');
    if (!approved) missing.push('At least one approved product');
    if (!brand.testOrderPassed) missing.push('Passing sandbox order');
    if (!brand.connectionHealthy || brand.status === 'disconnected') missing.push('Healthy connection');
    return missing;
  }
  async function decorateBrand(tx, brand) {
    return { ...brand, onboardingRequirements: await requirements(tx, brand) };
  }
  async function journal(tx, businessKey, kind, bag, entries) {
    const normalized = entries.filter(entry => entry.debitCents || entry.creditCents);
    for (const entry of normalized) {
      integer(entry.debitCents || 0, 'debitCents'); integer(entry.creditCents || 0, 'creditCents');
      if ((entry.debitCents > 0) === (entry.creditCents > 0)) fail('Each journal entry must be a debit or a credit.');
    }
    const debit = normalized.reduce((sum, entry) => sum + (entry.debitCents || 0), 0);
    const credit = normalized.reduce((sum, entry) => sum + (entry.creditCents || 0), 0);
    if (!debit || debit !== credit) fail('Unbalanced ledger journal.', 500, 'UNBALANCED_LEDGER');
    const journalId = id('jrnl');
    const inserted = await first(tx, `INSERT INTO ledger_journals
      (id,business_key,kind,bag_id,brand_id,total_debit_cents,total_credit_cents,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,$7) ON CONFLICT(business_key) DO NOTHING RETURNING *`,
      [journalId,businessKey,kind,bag.id,bag.brandId,debit,iso()]);
    if (!inserted) return;
    for (const entry of normalized) await tx.query(`INSERT INTO ledger_entries
      (id,journal_id,account,debit_cents,credit_cents) VALUES($1,$2,$3,$4,$5)`,
      [id('entry'),journalId,entry.account,entry.debitCents || 0,entry.creditCents || 0]);
  }
  const debit = (account, debitCents) => ({ account, debitCents, creditCents: 0 });
  const credit = (account, creditCents) => ({ account, creditCents, debitCents: 0 });

  const releaseDays=(bag,brand)=>Math.max(7,bag.returnWindowDays??30,brand.returnWindowDays??30);
  const twoStep = brand => brand.onboardingMode==='two_step' || Boolean(brand.onboardingState?.platform || brand.onboardingState?.source || brand.onboardingState?.connected);
  // Legacy mock flags are deliberately not a provider proof. A future payout
  // driver must supply this server-owned, transaction-local durable verifier;
  // no current HTTP payload or JSON flag can enable two-step payouts.
  async function payoutReady(brand,tx) {
    if(!brand.stripeAccountId || !brand.chargesEnabled || !brand.payoutsEnabled) return false;
    if(!twoStep(brand))return true;
    if(brand.payoutSetup!=='complete' || !/^acct_[A-Za-z0-9]{8,64}$/.test(brand.stripeAccountId) || typeof verifyTwoStepPayout!=='function')return false;
    try {
      const proof=await verifyTwoStepPayout({brandId:brand.id,accountId:brand.stripeAccountId},tx);
      return proof?.verified===true && proof.provider==='stripe' && proof.mode==='test' && proof.brandId===brand.id && proof.accountId===brand.stripeAccountId && proof.chargesEnabled===true && proof.payoutsEnabled===true;
    } catch {return false;}
  }
  async function extendScheduledWindow(tx,bag,brand) {
    if (!bag.deliveredAt) return bag;
    const transfer=await first(tx,'SELECT * FROM transfers WHERE bag_id=$1',[bag.id]);
    if (!transfer || !['scheduled','held'].includes(transfer.status)) return bag;
    const job=await first(tx,"SELECT * FROM jobs WHERE bag_id=$1 AND kind='sandbox_payout'",[bag.id]);
    const dueAt=new Date(Math.max(new Date(bag.deliveredAt).getTime()+releaseDays(bag,brand)*DAY,
      ...[bag.payoutDueAt,transfer.dueAt,job?.dueAt].filter(Boolean).map(value=>new Date(value).getTime()))).toISOString();
    if (bag.payoutDueAt===dueAt && transfer.dueAt===dueAt && (!job || job.dueAt===dueAt)) return bag;
    const result=await first(tx,'UPDATE bags SET payout_due_at=$2,updated_at=$3 WHERE id=$1 RETURNING *',[bag.id,dueAt,iso()]);
    await tx.query('UPDATE transfers SET due_at=$2 WHERE bag_id=$1',[bag.id,dueAt]);
    await tx.query("UPDATE jobs SET due_at=$2 WHERE bag_id=$1 AND kind='sandbox_payout' AND status IN ('scheduled','held','failed')",[bag.id,dueAt]);
    await event(tx,'payout.scheduled',bag.id,bag.brandId,{bagId:bag.id,dueAt,amountCents:transfer.amountCents,
      returnWindowDays:releaseDays(bag,brand),reason:'return_window_extended'});
    return result;
  }

  // Quotes and order creation share validation, stock accounting and the fixed
  // sandbox pricing policy. A quote never reserves stock or emits paid orders.
  async function planSandboxOrder(tx,input,shipTo) {
    if (input.currency && input.currency!=='USD') fail('Only USD sandbox orders are supported.');
    if (!Array.isArray(input.items) || !input.items.length || input.items.length>100) fail('Provide 1–100 catalog items.');
    const grouped=new Map(), allocations=new Map();
    for (const line of input.items) {
      // Native stock has its own atomic reservation authority. Legacy fixtures
      // must never sell a second copy through the old product scalar counter.
      if ((await first(tx,"SELECT to_regclass('commerce_brand_policy_versions') AS relation")).relation) {
        const policy=await first(tx,'SELECT config FROM commerce_brand_policy_versions WHERE brand_id=$1 ORDER BY version DESC LIMIT 1',[line.brandId]);
        if(policy?.config?.model==='first_party')fail('Use the native commerce checkout for Avafem inventory.',409,'COMMERCE_WORKFLOW_REQUIRED');
      }
      const qty=integer(line.qty ?? line.quantity ?? 1,'qty',1,1000);
      const brand=await brandRow(tx,line.brandId);
      if (brand.status==='disconnected' || brand.status==='paused') fail('This brand is unavailable for new sandbox orders.',409,'BRAND_UNAVAILABLE');
      const found=await first(tx,"SELECT * FROM products WHERE brand_id=$1 AND sku=$2 AND status='approved' AND source_deleted_at IS NULL",[brand.id,line.sku]);
      if (!found) fail(`Approved product ${line.sku} not found for this brand.`,409,'PRODUCT_UNAVAILABLE');
      if (!allocations.has(found.id)) allocations.set(found.id,structuredClone(found));
      const product=allocations.get(found.id);
      let price=product.priceCents,inventory=product.inventoryQty,variantIndex=-1;
      if (line.variantSku) {
        variantIndex=product.variants.findIndex(variant=>variant.sku===line.variantSku);
        if (variantIndex<0) fail('Variant SKU is not part of this brand product.');
        price=product.variants[variantIndex].price.amount; inventory=product.variants[variantIndex].inventory.qty;
      }
      if (inventory<qty) fail(`Insufficient inventory for ${line.variantSku||line.sku}.`,409,'INSUFFICIENT_STOCK');
      integer(price*qty,'Line total');
      if (variantIndex<0) product.inventoryQty-=qty;
      else product.variants[variantIndex].inventory.qty-=qty;
      if (!grouped.has(brand.id)) grouped.set(brand.id,{brand,items:[],subtotal:0});
      const group=grouped.get(brand.id);
      group.items.push({sku:product.sku,...(line.variantSku?{variantSku:line.variantSku}:{}),title:product.title,qty,unitPriceCents:price});
      group.subtotal+=price*qty;
    }
    const groups=[...grouped.values()];
    for (const group of groups) {
      group.shipping=group.brand.shippingTable.find(rate=>rate.country===shipTo.country)?.priceCents ?? 0;
      // Explicitly fixed sandbox fixture, not a live tax engine or tax advice.
      group.tax=Math.round(group.subtotal*825/10000);
      group.commission=Math.round(group.subtotal*group.brand.commissionBps/10000);
    }
    const subtotal=groups.reduce((sum,g)=>sum+g.subtotal,0),shipping=groups.reduce((sum,g)=>sum+g.shipping,0),tax=groups.reduce((sum,g)=>sum+g.tax,0);
    integer(subtotal+shipping+tax,'Order total',1);
    if (input.expectedTotalCents!==undefined && integer(input.expectedTotalCents,'Expected order total',1)!==subtotal+shipping+tax)
      fail('The sandbox quote changed; no paid order was created.',409,'QUOTE_CHANGED');
    return {groups,allocations,subtotal,shipping,tax};
  }

  async function bagView(tx, bag) {
    const order = await first(tx, 'SELECT order_ref FROM orders WHERE id=$1', [bag.orderId]);
    const brand = await brandRow(tx, bag.brandId);
    return { ...bag, items:bag.items.map(({unitCostCents,units,...item})=>item),shipTo:await revealAddress(bag.shipTo), orderRef: order.orderRef, brandName: brand.name,
      shipments: await rows(tx, 'SELECT * FROM shipments WHERE bag_id=$1 ORDER BY created_at,id', [bag.id]),
      credit: await first(tx, 'SELECT * FROM credits WHERE bag_id=$1', [bag.id]),
      transfer: await first(tx, 'SELECT * FROM transfers WHERE bag_id=$1', [bag.id]) };
  }
  function validateProduct(product) {
    const issues = [];
    const add = (field, message) => issues.push({ field, message });
    if (!product.title) add('title','A product title is required.');
    if (!product.description) add('description','A shopper description is required.');
    if (!product.category) add('category','Choose a product category.');
    if (!product.images?.length || product.images.some(image => !https(image))) add('images','Provide at least one HTTPS product image.');
    if (!product.taxCode) add('taxCode','A tax code is required.');
    if (!product.shippingProfile) add('shippingProfile','A shipping profile is required.');
    if (!Array.isArray(product.evidence?.ingredients_inci) || !product.evidence.ingredients_inci.length)
      add('evidence.ingredients_inci','List ingredients or materials; use not applicable with an explanation where appropriate.');
    if (!Array.isArray(product.evidence?.claims)) add('evidence.claims','Claims must be an array.');
    else product.evidence.claims.forEach((claim, index) => {
      if (!text(claim.text)) add(`evidence.claims.${index}.text`,'Claim text is required.');
      if (!https(claim.source_url || claim.sourceUrl)) add(`evidence.claims.${index}.source_url`,'Each claim needs an HTTPS source citation.');
    });
    if (!Array.isArray(product.variants)) add('variants','Variants must be an array.');
    else product.variants.forEach((variant,index) => {
      if (!text(variant.sku)) add(`variants.${index}.sku`,'A variant SKU is required.');
      if (!Number.isSafeInteger(variant.price?.amount) || variant.price.amount<0) add(`variants.${index}.price.amount`,'Variant price must be integer cents.');
      if (!Number.isSafeInteger(variant.inventory?.qty) || variant.inventory.qty<0) add(`variants.${index}.inventory.qty`,'Variant inventory must be a nonnegative integer.');
    });
    return issues;
  }
  const filter = (input, extra = []) => {
    if (typeof input === 'string') input = { brandId: input };
    const parts = [], params = [];
    for (const [key, column] of [['brandId','brand_id'],...extra]) if (input?.[key]) {
      params.push(input[key]); parts.push(`${column}=$${params.length}`);
    }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
  };

  const domain = {
    async listBrands() {
      const result = await rows(db,'SELECT * FROM brands ORDER BY name');
      return Promise.all(result.map(brand => decorateBrand(db,brand)));
    },
    async getBrand(brandId) { return decorateBrand(db,await brandRow(db,brandId)); },
    async twoStepPayoutReady(brandId,{tx}={}) {const q=tx||db;if(tx)await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);return payoutReady({...await brandRow(q,brandId),onboardingMode:'two_step'},q);},
    async enterTwoStepOnboarding(brandId,{actor='system:onboarding'}={}) {
      if(!/^[A-Za-z0-9_:-]{1,120}$/.test(actor))fail('Use a server-owned onboarding actor.');
      return db.transaction(async tx=>{
        await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);
        const brand=await brandRow(tx,brandId),verified=await payoutReady({...brand,onboardingMode:'two_step'},tx);
        const setup=verified?'complete':'deferred',status=brand.onboardingMode!=='two_step' && ['invited','ready','live'].includes(brand.status)?'onboarding':brand.status;
        const changed=brand.onboardingMode!=='two_step' || brand.payoutSetup!==setup || (!verified && Boolean(brand.stripeAccountId || brand.chargesEnabled || brand.payoutsEnabled));
        const result=await first(tx,`UPDATE brands SET onboarding_mode='two_step',payout_setup=$2,status=$3,
          stripe_account_id=CASE WHEN $4 THEN stripe_account_id ELSE NULL END,charges_enabled=CASE WHEN $4 THEN charges_enabled ELSE FALSE END,
          payouts_enabled=CASE WHEN $4 THEN payouts_enabled ELSE FALSE END,updated_at=$5 WHERE id=$1 RETURNING *`,[brandId,setup,status,verified,iso()]);
        if(!verified) {
          await tx.query("UPDATE transfers SET status='held' WHERE brand_id=$1 AND status='scheduled'",[brandId]);
          await tx.query("UPDATE jobs SET status='held',last_error='Verified two-step payout setup required' WHERE bag_id IN(SELECT id FROM bags WHERE brand_id=$1) AND kind='sandbox_payout' AND status IN('scheduled','failed')",[brandId]);
        }
        if(changed) {
          await tx.query(`INSERT INTO curation_audit(id,brand_id,actor,action,reason,payload,created_at) VALUES($1,$2,$3,'two_step_entered',$4,$5,$6)`,
            [id('curation'),brandId,actor,'Two-step payout authority is separate from legacy simulated onboarding.',json({payoutSetup:setup,payoutVerified:verified,legacySimulationDiscarded:!verified && Boolean(brand.stripeAccountId || brand.chargesEnabled || brand.payoutsEnabled)}),iso()]);
          await event(tx,'brand.onboarding_entered',brandId,brandId,{onboardingMode:'two_step',payoutSetup:setup,payoutVerified:verified});
        }
        return decorateBrand(tx,result);
      });
    },
    async activateConnectedBrand(brandId,{actor='system:onboarding',payoutSetup='deferred'} = {}) {
      if (!/^[A-Za-z0-9_:-]{1,120}$/.test(actor) || !['deferred','pending'].includes(payoutSetup)) fail('Use a server-owned onboarding actor and payout choice.');
      return db.transaction(async tx => {
        await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);
        const brand=await brandRow(tx,brandId),state=brand.onboardingState||{};
        if (!state.connected || !state.catalogImportComplete || !state.profileVerified || !brand.agreementSigned || !brand.connectionHealthy || ['paused','disconnected'].includes(brand.status))
          fail('A verified connection, profile, catalog import and agreement are required.',409,'ONBOARDING_INCOMPLETE');
        let connection; const source=state.platform || state.source;
        if (source==='shopify' && brand.connectionTier==='shopify') connection=await first(tx,"SELECT brand_id FROM shopify_connections WHERE brand_id=$1 AND status='connected'",[brandId]);
        else if (['woocommerce','bigcommerce','csv','feed'].includes(source) && brand.connectionTier===(['csv','feed'].includes(source)?'dashboard':source)) connection=await first(tx,"SELECT brand_id FROM brand_connectors WHERE brand_id=$1 AND platform=$2 AND status='connected'",[brandId,source==='feed'?'csv':source]);
        if (!connection) fail('The selected store connection is not verified.',409,'ONBOARDING_INCOMPLETE');
        const products=await rows(tx,'SELECT * FROM products WHERE brand_id=$1 AND source_deleted_at IS NULL',[brandId]);
        if (products.some(product=>checkProduct(product).status!=='pass')) fail('Flagged catalog listings need admin review; brand auto-activation is held.',409,'ONBOARDING_COMPLIANCE_REVIEW');
        const verified=await payoutReady({...brand,onboardingMode:'two_step'},tx),payout=verified?'complete':payoutSetup;
        const result=await first(tx,`UPDATE brands SET onboarding_mode='two_step',payout_setup=$2,status='live',
          stripe_account_id=CASE WHEN $3 THEN stripe_account_id ELSE NULL END,charges_enabled=CASE WHEN $3 THEN charges_enabled ELSE FALSE END,
          payouts_enabled=CASE WHEN $3 THEN payouts_enabled ELSE FALSE END,updated_at=$4 WHERE id=$1 RETURNING *`,[brandId,payout,verified,iso()]);
        if(!verified) {
          await tx.query("UPDATE transfers SET status='held' WHERE brand_id=$1 AND status='scheduled'",[brandId]);
          await tx.query("UPDATE jobs SET status='held',last_error='Verified two-step payout setup required' WHERE bag_id IN(SELECT id FROM bags WHERE brand_id=$1) AND kind='sandbox_payout' AND status IN('scheduled','failed')",[brandId]);
        }
        await tx.query(`INSERT INTO curation_audit(id,brand_id,actor,action,reason,payload,created_at) VALUES($1,$2,$3,'brand_connected_activation',$4,$5,$6)`,
          [id('curation'),brandId,actor,'Verified clean connected brand; product approvals remain independent.',json({productCount:products.length,approvedProducts:products.filter(p=>p.status==='approved').length,payoutSetup:payout}),iso()]);
        await event(tx,'brand.activated',brandId,brandId,{status:'live',onboardingMode:'two_step',payoutSetup:payout,productsAutoapproved:false});
        return decorateBrand(tx,result);
      });
    },
    async createBrand(input = {}) {
      return db.transaction(async tx => {
        const name = text(input.name,160); if (!name) fail('Brand name is required.');
        const slug = text(input.slug || name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),100);
        const commission = integer(input.commissionBps ?? 1500,'commissionBps',0,10000);
        const returnWindow = integer(input.returnWindowDays ?? 30,'returnWindowDays',0,365);
        const brandId = input.id || id('brand');
        const brand = await first(tx,`INSERT INTO brands(id,name,slug,commission_bps,return_window_days,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,[brandId,name,slug,commission,returnWindow,iso()]);
        await event(tx,'brand.created',brand.id,brand.id,{name:brand.name});
        return decorateBrand(tx,brand);
      });
    },
    async updateBrand(brandId, input = {}) {
      return db.transaction(async tx => {
        const existing = await brandRow(tx,brandId);
        if(twoStep(existing) && (input.stripeAccountId || input.chargesEnabled===true || input.payoutsEnabled===true))
          fail('A verified server-owned payout flow is required for two-step brands.',409,'USE_ONBOARDING_PAYOUT_FLOW');
        const merged = { ...existing };
        for (const field of ['name','commissionBps','status','connectionTier','agreementSigned','stripeAccountId','chargesEnabled','payoutsEnabled','returnWindowDays','shipFromAddress','shippingTable','supportEmail','testOrderPassed','connectionHealthy'])
          if (input[field] !== undefined) merged[field] = input[field];
        merged.name = text(merged.name,160); if (!merged.name) fail('Brand name is required.');
        integer(merged.commissionBps,'commissionBps',0,10000); integer(merged.returnWindowDays,'returnWindowDays',0,365);
        if (!['invited','onboarding','ready','live','paused','disconnected'].includes(merged.status)) fail('Invalid brand status.');
        if (!['dashboard','shopify','api','woocommerce','bigcommerce'].includes(merged.connectionTier)) fail('Invalid connection tier.');
        if (!Array.isArray(merged.shippingTable)) fail('shippingTable must be an array.');
        for (const rate of merged.shippingTable) integer(rate.priceCents,'Shipping price');
        if (merged.stripeAccountId && !merged.stripeAccountId.startsWith('acct_sandbox_')) fail('Only simulated acct_sandbox_ accounts are accepted.');
        const missing = await requirements(tx,merged);
        if (['ready','live'].includes(merged.status) && missing.length) fail(`Onboarding incomplete: ${missing.join('; ')}.`,409,'ONBOARDING_INCOMPLETE');
        const brand = await first(tx,`UPDATE brands SET name=$2,commission_bps=$3,status=$4,connection_tier=$5,
          agreement_signed=$6,stripe_account_id=$7,charges_enabled=$8,payouts_enabled=$9,return_window_days=$10,
          ship_from_address=$11,shipping_table=$12,support_email=$13,test_order_passed=$14,connection_healthy=$15,updated_at=$16
          WHERE id=$1 RETURNING *`,[brandId,merged.name,merged.commissionBps,merged.status,merged.connectionTier,
          merged.agreementSigned,merged.stripeAccountId,merged.chargesEnabled,merged.payoutsEnabled,merged.returnWindowDays,
          json(merged.shipFromAddress),json(merged.shippingTable),text(merged.supportEmail,254),merged.testOrderPassed,merged.connectionHealthy,iso()]);
        if (brand.status==='disconnected') await tx.query("UPDATE products SET status='in_review',updated_at=$2 WHERE brand_id=$1 AND status='approved'",[brandId,iso()]);
        if (brand.returnWindowDays!==existing.returnWindowDays) {
          const delivered=await rows(tx,"SELECT * FROM bags WHERE brand_id=$1 AND status='delivered'",[brandId]);
          for (const bag of delivered) await extendScheduledWindow(tx,bag,brand);
        }
        await event(tx,brand.status==='disconnected'?'brand.disconnected':'brand.updated',brandId,brandId,{status:brand.status,connectionTier:brand.connectionTier});
        return decorateBrand(tx,brand);
      });
    },
    async listProducts(input = {}) {
      const query = filter(input,[['status','status']]);
      return rows(db,`SELECT * FROM products${query.sql} ORDER BY updated_at DESC,id`,query.params);
    },
    async getProduct(productId, brandId) { return owned(db,'products',productId,brandId); },
    async upsertProduct(brandId,sku,input = {},{source,beforeUpsert} = {}) {
      return db.transaction(async tx => {
        if(beforeUpsert) await beforeUpsert(tx);
        await brandRow(tx,brandId);
        sku = text(sku,120); if (!sku) fail('SKU is required.');
        let existing = await first(tx,'SELECT * FROM products WHERE brand_id=$1 AND sku=$2',[brandId,sku]);
        if (source) {
          if (!['shopify','woocommerce','bigcommerce','csv','feed'].includes(source.provider) || !text(source.catalogKey,500) || !text(source.productId,200)) fail('A bounded server-owned catalog identity is required.');
          const mapped=await rows(tx,'SELECT * FROM products WHERE brand_id=$1 AND source_provider=$2 AND source_catalog_key=$3 AND source_product_id=$4 FOR UPDATE',[brandId,source.provider,source.catalogKey,source.productId]);
          if(mapped.length>1 || (mapped[0] && existing && mapped[0].id!==existing.id)) fail('This source identity conflicts with another catalog product.',409,'CATALOG_SKU_CONFLICT');
          if(mapped[0] && mapped[0].sku!==sku) {
            existing={...mapped[0],status:'in_review',reviewedFingerprint:mapped[0].reviewedFingerprint || (mapped[0].status==='approved'?productReviewFingerprint(mapped[0]):null)};
            await tx.query("UPDATE products SET sku=$2,status='in_review',review_note='Source SKU changed; human review required.' WHERE id=$1",[existing.id,sku]);
          }
          if (existing && (!existing.sourceProvider || existing.sourceProvider!==source.provider || existing.sourceCatalogKey!==source.catalogKey || existing.sourceProductId!==source.productId))
            fail('This source would overwrite a different or user-managed product.',409,'CATALOG_SKU_CONFLICT');
        }
        const product = { title:'',description:'',category:'',priceCents:0,inventoryQty:0,images:[],variants:[],productType:'',tags:[],collections:[],
          evidence:{ingredients_inci:[],certifications:[],claims:[],contraindications:''},taxCode:'',shippingProfile:'standard',...existing };
        product.sku=sku;
        for (const field of ['title','description','category','priceCents','inventoryQty','images','variants','evidence','taxCode','shippingProfile','productType','tags','collections'])
          if (input[field]!==undefined) product[field]=input[field];
        // Accept the normalized contract's price/inventory aliases as well.
        if (input.price?.amount!==undefined) product.priceCents=input.price.amount;
        if (input.inventory?.qty!==undefined) product.inventoryQty=input.inventory.qty;
        integer(product.priceCents,'priceCents'); integer(product.inventoryQty,'inventoryQty',0,1_000_000);
        product.title=text(product.title,250); product.description=text(product.description,12000); product.category=text(product.category,150);
        product.productType=text(product.productType,150);
        for (const field of ['tags','collections']) {
          if (!Array.isArray(product[field]) || product[field].length>100 || product[field].some(value=>typeof value!=='string' || !text(value,150))) fail(`${field} must contain up to 100 nonempty names.`);
          product[field]=[...new Set(product[field].map(value=>text(value,150)))].sort();
        }
        if (!Array.isArray(product.images)) fail('images must be an array.');
        if (!product.evidence || typeof product.evidence!=='object' || Array.isArray(product.evidence)) fail('evidence must be an object.');
        const issues=validateProduct(product);
        const reviewFields=['title','description','category','images','evidence','taxCode','shippingProfile','productType','tags','collections'];
        const contentChanged=existing && reviewFields.some(field=>!equal(existing[field],product[field]));
        // Variant prices and quantities are commercial edits. Variant identities,
        // options and other descriptive changes still require a fresh review.
        const descriptiveVariants = variants => (variants||[]).map(({price,inventory,...rest})=>rest);
        const variantChanged=existing && !equal(descriptiveVariants(existing.variants),descriptiveVariants(product.variants));
        let status=existing?.status || 'in_review';
        if (contentChanged || variantChanged) status='in_review';
        if (issues.length) status='draft';
        const sourceDeletedAt=source ? (source.active===false?iso():null) : existing?.sourceDeletedAt||null;
        if (sourceDeletedAt) status='draft';
        const fingerprint=productReviewFingerprint(product);
        const reviewedFingerprint=existing?.reviewedFingerprint || (existing?.status==='approved'?productReviewFingerprint(existing):null);
        const reviewedAt=existing?.reviewedAt || (existing?.status==='approved'?existing.updatedAt:null);
        const result=await first(tx,`INSERT INTO products
          (id,brand_id,sku,title,description,category,price_cents,inventory_qty,images,variants,evidence,tax_code,shipping_profile,status,validation_issues,review_note,created_at,updated_at,
           product_type,collections,tags,source_provider,source_product_id,source_catalog_key,source_deleted_at,review_fingerprint,reviewed_fingerprint,reviewed_at,compliance_result,compliance_checked_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$17)
          ON CONFLICT(brand_id,sku) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,category=EXCLUDED.category,
          price_cents=EXCLUDED.price_cents,inventory_qty=EXCLUDED.inventory_qty,images=EXCLUDED.images,variants=EXCLUDED.variants,
          evidence=EXCLUDED.evidence,tax_code=EXCLUDED.tax_code,shipping_profile=EXCLUDED.shipping_profile,status=EXCLUDED.status,
          validation_issues=EXCLUDED.validation_issues,review_note=EXCLUDED.review_note,updated_at=EXCLUDED.updated_at,
          product_type=EXCLUDED.product_type,collections=EXCLUDED.collections,tags=EXCLUDED.tags,source_provider=EXCLUDED.source_provider,
          source_product_id=EXCLUDED.source_product_id,source_catalog_key=EXCLUDED.source_catalog_key,source_deleted_at=EXCLUDED.source_deleted_at,
          review_fingerprint=EXCLUDED.review_fingerprint,reviewed_fingerprint=EXCLUDED.reviewed_fingerprint,reviewed_at=EXCLUDED.reviewed_at,
          compliance_result=EXCLUDED.compliance_result,compliance_checked_at=EXCLUDED.compliance_checked_at RETURNING *`,
          [existing?.id||id('prod'),brandId,sku,product.title,product.description,product.category,product.priceCents,product.inventoryQty,
          json(product.images),json(product.variants),json(product.evidence),text(product.taxCode,150),text(product.shippingProfile,100),status,json(issues),
          contentChanged||variantChanged?'Content changed; human review required.':existing?.reviewNote||'',iso(),product.productType,json(product.collections),json(product.tags),
          source?.provider||existing?.sourceProvider||null,source?.productId||existing?.sourceProductId||null,source?.catalogKey||existing?.sourceCatalogKey||null,
          sourceDeletedAt,fingerprint,reviewedFingerprint,reviewedAt,json(checkProduct(product))]);
        await event(tx,'product.upserted',result.id,brandId,{productId:result.id,sku,status,validationIssues:issues});
        if (existing && existing.inventoryQty!==result.inventoryQty) await event(tx,'inventory.changed',result.id,brandId,{sku,inventoryQty:result.inventoryQty});
        return result;
      });
    },
    async reviewProduct(productId,input = {},brandId,{tx: providedTransaction} = {}) {
      const review = async tx => {
        await tx.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[productId]);
        const product=await owned(tx,'products',productId,brandId);
        const status=input.status || (input.approved===true?'approved':input.approved===false?'rejected':null);
        if (!['approved','rejected'].includes(status)) fail('Review status must be approved or rejected.');
        const issues=validateProduct(product);
        if (status==='approved' && issues.length) fail('Resolve catalog validation issues before approval.',409,'CATALOG_INVALID');
        const fingerprint=productReviewFingerprint(product),compliance=checkProduct(product);
        if (input.fingerprint && input.fingerprint!==fingerprint) fail('The product changed; refresh the review.',409,'CURATION_STALE');
        if (status==='approved' && product.sourceDeletedAt) fail('A delisted source product cannot be approved.',409,'PRODUCT_DELISTED');
        if (status==='approved' && compliance.flags.length) {
          const override=await first(tx,'SELECT * FROM compliance_overrides WHERE product_id=$1',[productId]);
          if (!override || override.fingerprint!==fingerprint || text(override.reason).length<10) fail('Flagged products require an exact-content override with a reason.',409,'COMPLIANCE_BLOCKED');
        }
        if (status==='approved' && beforeProductApproval) await beforeProductApproval(product,tx);
        if(status==='approved' && productReviewFingerprint(await owned(tx,'products',productId,brandId))!==fingerprint)
          fail('The listing changed during approval; refresh its exact-content review.',409,'CURATION_STALE');
        const result=await first(tx,`UPDATE products SET status=$2,review_note=$3,validation_issues=$4,updated_at=$5,
          review_fingerprint=$6,reviewed_fingerprint=$6,reviewed_at=$5,compliance_result=$7,compliance_checked_at=$5 WHERE id=$1 RETURNING *`,
          [productId,status,text(input.note,2000),json(issues),iso(),fingerprint,json(compliance)]);
        await tx.query(`INSERT INTO curation_audit(id,operation_id,brand_id,product_id,actor,action,reason,fingerprint,payload,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id('curation'),input.operationId||null,product.brandId,productId,text(input.actor||'internal:domain',120),
          status,text(input.note||'Canonical product review.',2000),fingerprint,json({previousStatus:product.status,status}),iso()]);
        await event(tx,`product.${status}`,productId,product.brandId,{productId,sku:product.sku,status});
        return result;
      };
      return providedTransaction?review(providedTransaction):db.transaction(review);
    },
    async listBags(input = {}) {
      const query=filter(input,[['status','status']]);
      const result=await rows(db,`SELECT * FROM bags${query.sql} ORDER BY created_at DESC,id`,query.params);
      return Promise.all(result.map(bag=>bagView(db,bag)));
    },
    async getBag(bagId,brandId) { return bagView(db,await owned(db,'bags',bagId,brandId)); },
    async quoteSandboxOrder(input = {}) {
      return db.transaction(async tx => {
        const shipTo=address(input.shipTo);
        const {subtotal,shipping,tax}=await planSandboxOrder(tx,input,shipTo);
        return {subtotalCents:subtotal,shippingCents:shipping,taxCents:tax,totalCents:subtotal+shipping+tax,currency:'USD'};
      });
    },
    async createSandboxOrder(input = {}, { beforeCreate } = {}) {
      return db.transaction(async tx => {
        // Server-only lifecycle guard, serialized with cancellation/erasure. It
        // must never contain a provider request; payment already ran outside tx.
        if (beforeCreate) await beforeCreate(tx);
        if (input.currency && input.currency!=='USD') fail('Only USD sandbox orders are supported.');
        if (!Array.isArray(input.items) || !input.items.length || input.items.length>100) fail('Provide 1–100 catalog items.');
        const shipTo=address(input.shipTo);
        if (input.externalId) {
          if (!text(input.externalId,100)) fail('externalId must be a nonempty string.');
          const previous=await first(tx,'SELECT * FROM orders WHERE order_ref=$1',[`SANDBOX-${text(input.externalId,100)}`]);
          if (previous) {
            const previousBags=await rows(tx,'SELECT * FROM bags WHERE order_id=$1',[previous.id]);
            const canonical=lines=>lines.map(line=>({brandId:line.brandId,sku:line.sku,variantSku:line.variantSku||null,
              qty:integer(line.qty??line.quantity??1,'qty',1,1000)})).sort((a,b)=>json(a).localeCompare(json(b)));
            const previousItems=previousBags.flatMap(bag=>bag.items.map(item=>({...item,brandId:bag.brandId})));
            const canonicalAddress=value=>json(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
            const previousAddresses=await Promise.all(previousBags.map(bag=>revealAddress(bag.shipTo)));
            if (json(canonical(input.items))!==json(canonical(previousItems)) || previousAddresses.some(previous=>canonicalAddress(previous)!==canonicalAddress(shipTo)))
              fail('externalId was already used for a different sandbox order.',409,'IDEMPOTENCY_CONFLICT');
            return {...previous,bags:await Promise.all(previousBags.map(bag=>bagView(tx,bag)))};
          }
        }
        const {groups,allocations,subtotal,shipping,tax}=await planSandboxOrder(tx,input,shipTo);
        for (const product of allocations.values()) {
          await tx.query('UPDATE products SET inventory_qty=$2,variants=$3,updated_at=$4 WHERE id=$1',[product.id,product.inventoryQty,json(product.variants),iso()]);
        }
        for (const group of groups) for (const line of group.items) {
          const product=[...allocations.values()].find(p=>p.brandId===group.brand.id && p.sku===line.sku);
          await event(tx,'inventory.changed',product.id,group.brand.id,{sku:product.sku,quantityChange:-line.qty});
        }
        const orderId=id('ord'); const orderRef=input.externalId?`SANDBOX-${text(input.externalId,100)}`:`SANDBOX-${randomUUID().slice(0,8).toUpperCase()}`;
        const storedShipTo=await protectAddress(shipTo);
        const order=await first(tx,`INSERT INTO orders(id,order_ref,subtotal_cents,shipping_cents,tax_cents,total_cents,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[orderId,orderRef,subtotal,shipping,tax,subtotal+shipping+tax,iso()]);
        const created=[];
        for (const group of groups) {
          const bag=await first(tx,`INSERT INTO bags
            (id,order_id,brand_id,items,ship_to,subtotal_cents,shipping_cents,tax_cents,commission_cents,transfer_cents,total_cents,ship_by,return_window_days,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
            [id('bag'),orderId,group.brand.id,json(group.items),json(storedShipTo),group.subtotal,group.shipping,group.tax,group.commission,
            group.subtotal-group.commission+group.shipping,group.subtotal+group.shipping+group.tax,new Date(now().getTime()+3*DAY).toISOString(),group.brand.returnWindowDays,iso()]);
          const payoutHeld=twoStep(group.brand) && !(await payoutReady(group.brand,tx));
          await tx.query("INSERT INTO transfers(id,bag_id,brand_id,amount_cents,status,created_at) VALUES($1,$2,$3,$4,$5,$6)",
            [id('tr'),bag.id,bag.brandId,bag.transferCents,payoutHeld?'held':'scheduled',iso()]);
          if (payoutHeld) await tx.query("INSERT INTO jobs(id,kind,bag_id,status,due_at,last_error,created_at) VALUES($1,'sandbox_payout',$2,'held',$3,'Payout onboarding required; delivery still required',$4)",
            [id('job'),bag.id,new Date(now().getTime()+releaseDays(bag,group.brand)*DAY).toISOString(),iso()]);
          const creditAmount=Math.round(bag.subtotalCents*500/10000);
          await tx.query("INSERT INTO credits(id,bag_id,brand_id,amount_cents,status,created_at) VALUES($1,$2,$3,$4,'pending',$5)",
            [id('credit'),bag.id,bag.brandId,creditAmount,iso()]);
          if (bag.totalCents) await journal(tx,`payment:${bag.id}`,'sandbox_payment',bag,[debit('sandbox_clearing',bag.totalCents),credit('brand_payable',bag.transferCents),credit('commission_revenue',bag.commissionCents),credit('tax_payable',bag.taxCents)]);
          if (creditAmount) await journal(tx,`credit-accrual:${bag.id}`,'credit_pending',bag,[debit('loyalty_expense',creditAmount),credit('credit_pending',creditAmount)]);
          await event(tx,'bag.created',bag.id,bag.brandId,{bagId:bag.id,orderRef,items:bag.items,shipTo:bag.shipTo,shippingCents:bag.shippingCents,shipBy:bag.shipBy,paid:true});
          await event(tx,'credit.pending',bag.id,bag.brandId,{bagId:bag.id,amountCents:creditAmount});
          created.push(await bagView(tx,bag));
        }
        await event(tx,'checkout.paid',orderId,null,{orderId,orderRef,totalCents:order.totalCents,bagIds:created.map(bag=>bag.id)});
        return {...order,bags:created,taxMode:'fixed_8.25_percent_sandbox_fixture'};
      });
    },
    async recordShipment(bagId,input = {},brandId,options = {}) {
      return db.transaction(async tx => {
        const bag=await owned(tx,'bags',bagId,brandId);
        if (bag.commerceManaged) fail('Use the commerce fulfillment workflow for this Bag.',409,'COMMERCE_WORKFLOW_REQUIRED');
        if (bag.providerBound) fail('Use the provider-backed fulfillment workflow for this Bag.',409,'PROVIDER_WORKFLOW_REQUIRED');
        let handoff;
        if (options.handoffTokenHash) {
          handoff=await first(tx,`SELECT * FROM handoff_links WHERE token_hash=$1 AND bag_id=$2 AND brand_id=$3 FOR UPDATE`,
            [options.handoffTokenHash,bagId,bag.brandId]);
          if (!handoff || handoff.usedAt || new Date(handoff.expiresAt)<=now() || bag.status!=='awaiting_shipment')
            fail('This shipping link has expired or has already been used.',401,'HANDOFF_EXPIRED');
          const external=await first(tx,'SELECT bag_id FROM external_orders WHERE bag_id=$1',[bagId]);
          if (external) fail('This Bag is reserved for fulfillment through its connected store.',409,'EXTERNAL_FULFILLMENT_RESERVED');
        }
        if (!['awaiting_shipment','shipped'].includes(bag.status)) fail('Only open Bags can be shipped.',409,'INVALID_BAG_STATE');
        const carrier=text(input.carrier,80), number=text(input.trackingNumber||input.tracking_number,200);
        if (!carrier || !number) fail('Carrier and tracking number are required.');
        const existing=await first(tx,'SELECT * FROM shipments WHERE bag_id=$1 AND carrier=$2 AND tracking_number=$3',[bagId,carrier,number]);
        if (existing) return bagView(tx,bag);
        const proposal=await first(tx,"SELECT COUNT(*)::integer AS count FROM refunds WHERE bag_id=$1 AND status='proposed'",[bagId]);
        if (proposal.count) fail('A refund proposal is pending; resolve it before recording a new shipment.',409,'REFUND_PENDING');
        const trackingUrl=input.trackingUrl||input.tracking_url||null;
        if (trackingUrl && !https(trackingUrl)) fail('Tracking URL must use HTTPS.');
        const shippedAt=new Date(input.shippedAt||input.shipped_at||now());
        if (!Number.isFinite(shippedAt.getTime()) || shippedAt>now()) fail('shippedAt must be a valid time at or before now.');
        const shipmentItems=input.items||bag.items.map(({sku,qty})=>({sku,qty}));
        if (!Array.isArray(shipmentItems) || !shipmentItems.length || shipmentItems.length>100) fail('Provide 1–100 shipment items.');
        for (const line of shipmentItems) {
          integer(line.qty,'Shipment qty',1);
          const original=bag.items.filter(item=>item.sku===line.sku).reduce((sum,item)=>sum+item.qty,0);
          if (!original || line.qty>original) fail('Shipment items must belong to this Bag and not exceed ordered quantities.');
        }
        // MVP has one complete shipment; this prevents a partial shipment from
        // starting the payout clock for the entire Bag.
        const quantities=items=>items.reduce((map,item)=>(map[item.sku]=(map[item.sku]||0)+item.qty,map),{});
        if (json(Object.entries(quantities(shipmentItems)).sort())!==json(Object.entries(quantities(bag.items)).sort())) fail('The sandbox currently requires one complete shipment per Bag.');
        if ((await first(tx,'SELECT COUNT(*)::integer AS count FROM shipments WHERE bag_id=$1',[bagId])).count) fail('A shipment is already recorded for this Bag.',409,'SHIPMENT_EXISTS');
        await tx.query(`INSERT INTO shipments(id,bag_id,brand_id,carrier,tracking_number,tracking_url,items,shipped_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id('ship'),bagId,bag.brandId,carrier,number,trackingUrl,json(shipmentItems),shippedAt.toISOString(),iso()]);
        const result=await first(tx,"UPDATE bags SET status='shipped',updated_at=$2 WHERE id=$1 RETURNING *",[bagId,iso()]);
        if (handoff) await tx.query('UPDATE handoff_links SET used_at=$2 WHERE token_hash=$1',[options.handoffTokenHash,iso()]);
        await event(tx,'bag.shipped',bagId,bag.brandId,{bagId,carrier,trackingNumber:number,trackingUrl,shippedAt:shippedAt.toISOString()});
        return bagView(tx,result);
      });
    },
    async markDelivered(bagId,input = {},brandId) {
      return db.transaction(async tx => {
        const bag=await owned(tx,'bags',bagId,brandId);
        if (bag.commerceManaged) fail('Use the commerce delivery workflow for this Bag.',409,'COMMERCE_WORKFLOW_REQUIRED');
        if (bag.providerBound) fail('Provider delivery evidence is required for this Bag.',409,'PROVIDER_WORKFLOW_REQUIRED');
        const brand=await brandRow(tx,bag.brandId);
        if (bag.status==='delivered') return bagView(tx,await extendScheduledWindow(tx,bag,brand));
        if (bag.status!=='shipped') fail('Only a shipped Bag can be marked delivered.',409,'INVALID_BAG_STATE');
        const deliveredAt=new Date(input.deliveredAt||now());
        const shipment=await first(tx,'SELECT shipped_at FROM shipments WHERE bag_id=$1',[bagId]);
        if (!Number.isFinite(deliveredAt.getTime()) || deliveredAt>now() || deliveredAt<new Date(shipment.shippedAt)) fail('deliveredAt must fall between shipment and now.');
        const dueAt=new Date(Math.max(deliveredAt.getTime()+releaseDays(bag,brand)*DAY,
          bag.payoutDueAt?new Date(bag.payoutDueAt).getTime():0)).toISOString();
        const result=await first(tx,"UPDATE bags SET status='delivered',delivered_at=$2,payout_due_at=$3,updated_at=$4 WHERE id=$1 RETURNING *",[bagId,deliveredAt.toISOString(),dueAt,iso()]);
        const pending=await first(tx,"SELECT COUNT(*)::integer AS count FROM refunds WHERE bag_id=$1 AND status='proposed'",[bagId]);
        const held=Boolean(pending.count) || !(await payoutReady(brand,tx));
        await tx.query('UPDATE transfers SET due_at=$2,status=$3 WHERE bag_id=$1',[bagId,dueAt,held?'held':'scheduled']);
        await tx.query(`INSERT INTO jobs(id,kind,bag_id,status,due_at,created_at) VALUES($1,'sandbox_payout',$2,$3,$4,$5)
          ON CONFLICT(kind,bag_id) DO UPDATE SET due_at=GREATEST(jobs.due_at,EXCLUDED.due_at),status=EXCLUDED.status`,[id('job'),bagId,held?'held':'scheduled',dueAt,iso()]);
        await event(tx,'bag.delivered',bagId,bag.brandId,{bagId,deliveredAt:deliveredAt.toISOString()});
        await event(tx,'payout.scheduled',bagId,bag.brandId,{bagId,dueAt,amountCents:bag.transferCents,held,returnWindowDays:releaseDays(bag,brand)});
        return bagView(tx,result);
      });
    },
    async listRefunds(input = {}) {
      const query=filter(input,[['status','status']]);
      return rows(db,`SELECT * FROM refunds${query.sql} ORDER BY created_at DESC,id`,query.params);
    },
    async requestRefund(bagId,input = {},brandId) {
      return db.transaction(async tx => {
        const bag=await owned(tx,'bags',bagId,brandId);
        if (bag.commerceManaged) fail('Use the commerce refund workflow for this Bag.',409,'COMMERCE_WORKFLOW_REQUIRED');
        if (bag.providerBound) fail('Use the provider-backed refund workflow for this Bag.',409,'PROVIDER_WORKFLOW_REQUIRED');
        const existing=await first(tx,"SELECT * FROM refunds WHERE bag_id=$1 AND status IN ('proposed','approved') ORDER BY created_at LIMIT 1",[bagId]);
        if (existing) return existing;
        if (['refunded','cancelled'].includes(bag.status)) fail('This Bag is already closed.',409,'INVALID_BAG_STATE');
        const amount=integer(input.amountCents??bag.totalCents,'amountCents',1);
        if (amount!==bag.totalCents) fail('This sandbox supports full-Bag refund proposals only; shipping, tax and commission are included.');
        const reason=text(input.reason,1500); if (!reason) fail('A refund reason is required.');
        const refund=await first(tx,`INSERT INTO refunds(id,bag_id,brand_id,amount_cents,reason,created_at)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id('refund'),bagId,bag.brandId,amount,reason,iso()]);
        await tx.query("UPDATE transfers SET status='held' WHERE bag_id=$1 AND status='scheduled'",[bagId]);
        await tx.query("UPDATE jobs SET status='held' WHERE bag_id=$1 AND status='scheduled'",[bagId]);
        await event(tx,'refund.requested',refund.id,bag.brandId,{refundId:refund.id,bagId,amountCents:amount,requiresApproval:true});
        return refund;
      });
    },
    async approveSandboxRefund(refundId,input = {}) {
      return db.transaction(async tx => {
        const refund=await owned(tx,'refunds',refundId,input.brandId);
        if (refund.status==='approved') return refund;
        if (refund.status!=='proposed') fail('Refund is no longer awaiting approval.',409,'REFUND_CLOSED');
        const bag=await owned(tx,'bags',refund.bagId);
        if (bag.commerceManaged) fail('Use the commerce refund workflow for this Bag.',409,'COMMERCE_WORKFLOW_REQUIRED');
        if (bag.providerBound) fail('A synthetic refund cannot change a provider-backed Bag.',409,'PROVIDER_WORKFLOW_REQUIRED');
        if (bag.status==='refunded') fail('Bag has already been refunded.',409,'REFUND_CLOSED');
        const transfer=await first(tx,'SELECT * FROM transfers WHERE bag_id=$1',[bag.id]);
        if (transfer.status==='paid') {
          await journal(tx,`reversal:${transfer.id}`,'sandbox_transfer_reversal',bag,[debit('sandbox_clearing',transfer.amountCents),credit('brand_payable',transfer.amountCents)]);
          await tx.query("UPDATE transfers SET status='reversed',reversed_cents=amount_cents WHERE id=$1",[transfer.id]);
          await event(tx,'transfer.reversed',transfer.id,bag.brandId,{bagId:bag.id,amountCents:transfer.amountCents});
        } else await tx.query("UPDATE transfers SET status='cancelled' WHERE id=$1",[transfer.id]);
        const waiver=await first(tx,`SELECT COALESCE(SUM(e.credit_cents-e.debit_cents),0)::int AS amount
          FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id
          WHERE j.bag_id=$1 AND e.account='sandbox_payable_writeoff_adjustment'`,[bag.id]);
        if (waiver.amount!==0 && waiver.amount!==bag.transferCents) fail('Reconcile the prior payable waiver before refunding this Bag.',409,'LEDGER_RECONCILIATION_REQUIRED');
        // A noncash operator payable waiver did not refund the shopper. Preserve
        // their refund path, reversing that waiver rather than double-debiting
        // the brand payable that was already cancelled.
        await journal(tx,`refund:${refund.id}`,'sandbox_refund',bag,[debit(waiver.amount ? 'sandbox_payable_writeoff_adjustment' : 'brand_payable',bag.transferCents),debit('commission_revenue',bag.commissionCents),debit('tax_payable',bag.taxCents),credit('sandbox_clearing',bag.totalCents)]);
        const earned=await first(tx,'SELECT * FROM credits WHERE bag_id=$1',[bag.id]);
        if (earned.status!=='voided') {
          if (earned.amountCents) await journal(tx,`credit-void:${bag.id}`,'credit_voided',bag,[debit(earned.status==='released'?'credit_vault':'credit_pending',earned.amountCents),credit('loyalty_expense',earned.amountCents)]);
          await tx.query("UPDATE credits SET status='voided',voided_at=$2 WHERE bag_id=$1",[bag.id,iso()]);
          await event(tx,'credit.voided',bag.id,bag.brandId,{bagId:bag.id,amountCents:earned.amountCents});
        }
        await tx.query("UPDATE jobs SET status='cancelled' WHERE bag_id=$1 AND status IN ('scheduled','held','failed')",[bag.id]);
        await tx.query("UPDATE bags SET status='refunded',refunded_cents=total_cents,updated_at=$2 WHERE id=$1",[bag.id,iso()]);
        await tx.query("UPDATE orders SET refunded_cents=refunded_cents+$2,status=CASE WHEN refunded_cents+$2=total_cents THEN 'refunded' ELSE 'partially_refunded' END WHERE id=$1",[bag.orderId,bag.totalCents]);
        const result=await first(tx,"UPDATE refunds SET status='approved',approved_at=$2,subtotal_cents=$3,shipping_cents=$4,tax_cents=$5,commission_cents=$6 WHERE id=$1 RETURNING *",[refund.id,iso(),bag.subtotalCents,bag.shippingCents,bag.taxCents,bag.commissionCents]);
        await event(tx,'refund.issued',refund.id,bag.brandId,{refundId:refund.id,bagId:bag.id,amountCents:refund.amountCents,taxCents:bag.taxCents,commissionCents:bag.commissionCents,transferCents:bag.transferCents});
        return result;
      });
    },
    async runDueSandboxPayouts() {
      return db.transaction(async tx => {
        const due=await rows(tx,"SELECT * FROM jobs WHERE kind='sandbox_payout' AND status='scheduled' AND due_at<=$1 ORDER BY due_at,id",[iso()]);
        const paid=[];
        for (const job of due) {
          let bag=await owned(tx,'bags',job.bagId);
          if (bag.providerBound || bag.commerceManaged) {
            await tx.query("UPDATE jobs SET status='held',last_error='Provider-backed settlement required' WHERE id=$1",[job.id]);
            continue;
          }
          const brand=await brandRow(tx,bag.brandId);
          bag=await extendScheduledWindow(tx,bag,brand);
          if (!(await payoutReady(brand,tx))) {
            await tx.query("UPDATE jobs SET status='held',last_error='Payout onboarding required' WHERE id=$1",[job.id]);
            await tx.query("UPDATE transfers SET status='held' WHERE bag_id=$1 AND status='scheduled'",[bag.id]);
            await event(tx,'payout.held',bag.id,bag.brandId,{bagId:bag.id,reason:'payout_onboarding_required'});
            continue;
          }
          if (bag.payoutDueAt && new Date(bag.payoutDueAt)>now()) continue;
          const transfer=await first(tx,'SELECT * FROM transfers WHERE bag_id=$1',[bag.id]);
          const proposal=await first(tx,"SELECT COUNT(*)::integer AS count FROM refunds WHERE bag_id=$1 AND status='proposed'",[bag.id]);
          if (proposal.count) {
            await tx.query("UPDATE jobs SET status='held' WHERE id=$1",[job.id]);
            await tx.query("UPDATE transfers SET status='held' WHERE id=$1 AND status='scheduled'",[transfer.id]);
            await event(tx,'payout.held',bag.id,bag.brandId,{bagId:bag.id,reason:'refund_approval_pending'});
            continue;
          }
          if (bag.status!=='delivered' || transfer.status!=='scheduled') {
            await tx.query("UPDATE jobs SET status='cancelled' WHERE id=$1",[job.id]);
            await event(tx,'payout.cancelled',bag.id,bag.brandId,{bagId:bag.id,reason:'ineligible_bag_state'});
            continue;
          }
          if (transfer.amountCents) await journal(tx,`payout:${bag.id}`,'sandbox_payout',bag,[debit('brand_payable',transfer.amountCents),credit('sandbox_clearing',transfer.amountCents)]);
          const result=await first(tx,"UPDATE transfers SET status='paid',paid_at=$2 WHERE id=$1 RETURNING *",[transfer.id,iso()]);
          await tx.query("UPDATE jobs SET status='completed',attempts=attempts+1 WHERE id=$1",[job.id]);
          const earned=await first(tx,'SELECT * FROM credits WHERE bag_id=$1',[bag.id]);
          if (earned.status==='pending') {
            if (earned.amountCents) await journal(tx,`credit-release:${bag.id}`,'credit_released',bag,[debit('credit_pending',earned.amountCents),credit('credit_vault',earned.amountCents)]);
            await tx.query("UPDATE credits SET status='released',released_at=$2 WHERE id=$1",[earned.id,iso()]);
            await event(tx,'credit.released',bag.id,bag.brandId,{bagId:bag.id,amountCents:earned.amountCents});
          }
          await event(tx,'transfer.created',transfer.id,bag.brandId,{bagId:bag.id,amountCents:transfer.amountCents});
          await event(tx,'payout.paid',transfer.id,bag.brandId,{bagId:bag.id,amountCents:transfer.amountCents});
          paid.push(result);
        }
        return {processed:paid.length,transfers:paid,sandbox:true};
      });
    },
    async listLedger(input = {}) {
      const brandId=typeof input==='string'?input:input.brandId;
      return rows(db,`SELECT e.*,j.business_key,j.kind,j.bag_id,j.brand_id,j.created_at,j.sandbox
        FROM ledger_entries e JOIN ledger_journals j ON j.id=e.journal_id${brandId?' WHERE j.brand_id=$1':''}
        ORDER BY j.created_at DESC,j.id,e.id`,brandId?[brandId]:[]);
    },
    async encryptExistingShipping() {
      if (typeof protectShipping!=='function') return {enabled:false,encryptedBags:0,encryptedEvents:0,sandbox:true};
      return db.transaction(async tx=>{
        let encryptedBags=0,encryptedEvents=0;
        const bags=await rows(tx,"SELECT id,ship_to FROM bags WHERE NOT (ship_to ? 'encryptedShipping')");
        for (const bag of bags) {
          await tx.query('UPDATE bags SET ship_to=$2 WHERE id=$1',[bag.id,json(await protectAddress(address(bag.shipTo)))]);
          encryptedBags++;
        }
        const events=await rows(tx,"SELECT id,payload FROM outbox_events WHERE payload ? 'shipTo' OR payload ? 'ship_to'");
        for (const entry of events) {
          let changed=false;
          for (const key of ['shipTo','ship_to']) if (entry.payload[key] && !protectedAddress(entry.payload[key])) {
            entry.payload[key]=await protectAddress(address(entry.payload[key])); changed=true;
          }
          if (changed) { await tx.query('UPDATE outbox_events SET payload=$2 WHERE id=$1',[entry.id,json(entry.payload)]); encryptedEvents++; }
        }
        if (encryptedBags || encryptedEvents) await event(tx,'shipping.encrypted','shipping-maintenance',null,{encryptedBags,encryptedEvents});
        return {enabled:true,encryptedBags,encryptedEvents,sandbox:true};
      });
    },
    async listTransfers(input = {}) { const query=filter(input); return rows(db,`SELECT * FROM transfers${query.sql} ORDER BY created_at DESC,id`,query.params); },
    async listCredits(input = {}) { const query=filter(input); return rows(db,`SELECT * FROM credits${query.sql} ORDER BY created_at DESC,id`,query.params); },
    async listEvents(input = {}) { const query=filter(input,[['status','status']]); return rows(db,`SELECT * FROM outbox_events${query.sql} ORDER BY created_at DESC,id LIMIT 250`,query.params); },
    async listJobs(input = {}) {
      const brandId=typeof input==='string'?input:input.brandId;
      return rows(db,`SELECT j.*,b.brand_id FROM jobs j JOIN bags b ON b.id=j.bag_id${brandId?' WHERE b.brand_id=$1':''} ORDER BY j.due_at,j.id`,brandId?[brandId]:[]);
    },
    async dashboard(input = {}) {
      const [brands,products,bags,refunds,transfers,credits,ledger,events,jobs]=await Promise.all([
        input.brandId?domain.getBrand(input.brandId).then(brand=>[brand]):domain.listBrands(),domain.listProducts(input),domain.listBags(input),
        domain.listRefunds(input),domain.listTransfers(input),domain.listCredits(input),domain.listLedger(input),domain.listEvents(input),domain.listJobs(input)]);
      const debitTotal=ledger.reduce((sum,e)=>sum+e.debitCents,0), creditTotal=ledger.reduce((sum,e)=>sum+e.creditCents,0);
      const summary={brandCount:brands.length,liveBrands:brands.filter(b=>b.status==='live').length,productCount:products.length,
        reviewCount:products.filter(p=>p.status==='in_review').length,bagCount:bags.length,
        awaitingShipment:bags.filter(b=>b.status==='awaiting_shipment').length,shippedCount:bags.filter(b=>b.status==='shipped').length,
        deliveredCount:bags.filter(b=>b.status==='delivered').length,grossCents:bags.reduce((sum,b)=>sum+b.totalCents,0),
        commissionCents:bags.filter(b=>b.status!=='refunded').reduce((sum,b)=>sum+b.commissionCents,0),
        pendingRefunds:refunds.filter(r=>r.status==='proposed').length,
        scheduledPayoutCents:transfers.filter(t=>['scheduled','held'].includes(t.status)).reduce((sum,t)=>sum+t.amountCents,0),
        paidPayoutCents:transfers.filter(t=>t.status==='paid').reduce((sum,t)=>sum+t.amountCents-t.reversedCents,0),
        pendingCreditCents:credits.filter(c=>c.status==='pending').reduce((sum,c)=>sum+c.amountCents,0),
        releasedCreditCents:credits.filter(c=>c.status==='released').reduce((sum,c)=>sum+c.amountCents,0),
        ledgerDebitCents:debitTotal,ledgerCreditCents:creditTotal,ledgerBalanced:debitTotal===creditTotal,
        eventCount:events.length,scheduledJobs:jobs.filter(j=>j.status==='scheduled').length,sandbox:true};
      return {summary,brands,products,bags,refunds,transfers,credits,ledger,events,jobs,sandbox:true};
    },
  };
  return domain;
}
