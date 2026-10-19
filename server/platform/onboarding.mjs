import {first,rows,fail,text,id} from './util.mjs';
import {createStoreDiscovery,sanitizeStoreProfile} from './store-discovery.mjs';

const PLATFORMS=['shopify','woocommerce','bigcommerce','csv'];
const unavailable=()=>fail('Configure a test-mode payout onboarding adapter on the server. Payout setup can be skipped; payouts remain held.',503,'PAYOUT_ONBOARDING_NOT_CONFIGURED');
const actorName=ctx=>ctx?.owner && !ctx.brandId ? 'owner' : ctx?.brandId ? `brand:${ctx.brandId}` : 'onboarding-worker';
const safeFailure=error=>/^(?:CONNECTOR|CATALOG|ONBOARDING|SHOPIFY|STORE|PAYOUT|COMPLIANCE)_[A-Z0-9_]{1,60}$/.test(error?.code || '')
  && !/(?:SK|RK|PK)_(?:LIVE|TEST)_|SECRET|TOKEN_VALUE/.test(error.code) ? error.code : 'ONBOARDING_REVIEW_REQUIRED';
export function createOnboarding(db,{domain,auth,brands,curation,compliance,shopifyConnections,clock=()=>new Date(),discovery,storeAdapters={},payoutAdapter=null,localOnly=true,allowStoreProbes=false}={}) {
  const detector=discovery || createStoreDiscovery({allowProbe:allowStoreProbes});
  const now=()=>clock();
  const audit=(tx,brandId,actor,action)=>tx.query('INSERT INTO audit_log(actor,brand_id,action,resource_id) VALUES($1,$2,$3,$2)',[actor,brandId,action]);
  const load=async(brandId,q=db)=>{const b=await first(q,'SELECT * FROM brands WHERE id=$1',[brandId]);if(!b)fail('Brand not found.',404,'NOT_FOUND');return b;};
  async function nativeShopify(brandId) {
    const b=await load(brandId),connection=await shopifyConnections.status(brandId);
    if(connection?.status!=='connected' || !b.connectionHealthy || ['paused','disconnected'].includes(b.status) || b.onboardingState?.platform!=='shopify' || new URL(b.onboardingState.storeUrl).hostname!==connection.shop)
      fail('The selected Shopify store must complete its own OAuth approval.',409,'SHOPIFY_STORE_REQUIRED');
    const adapter=await shopifyConnections.forBrand(brandId),checked=await adapter.preflight();
    if(checked?.verified!==true || checked.connected!==true || checked.shop?.myshopifyDomain!==connection.shop || checked.shop.currencyCode!=='USD')
      fail('Fresh exact-store, scope and currency verification is required.',409,'SHOPIFY_STORE_UNVERIFIED');
    return {adapter,shop:connection.shop,checked};
  }
  async function shopifySnapshot(brandId) {
    const {adapter,shop}=await nativeShopify(brandId);
    return brands.withCatalogSnapshot(brandId,'shopify',shop,async()=>{
    const list=[],cursors=new Set(),seen=new Set();let after=null,complete=false,children=0;
    for(let page=0;page<500;page++) {
      const batch=await adapter.listCompleteProducts({first:10,after});
      if(batch?.shop!==shop || batch.completeChildren!==true || !Array.isArray(batch.products) || batch.products.length>10 || typeof batch.pageInfo?.hasNextPage!=='boolean')fail('Shopify catalog pagination is incomplete.',409,'CATALOG_IMPORT_INCOMPLETE');
      for(const p of batch.products) {
        const pid=p.source?.productId;
        if(p.currency!=='USD' || p.source?.shop!==shop || !/^gid:\/\/shopify\/Product\/\d+$/.test(pid || '') || seen.has(pid)
          || p.variantsPageInfo?.hasNextPage!==false || p.imagesPageInfo?.hasNextPage!==false)fail('Shopify catalog identities or children are incomplete.',409,'CATALOG_IMPORT_INCOMPLETE');
        children+=(p.variants?.length || 0)+(p.images?.length || 0);
        if(children>20_000)fail('The catalog exceeds this bounded import job.',422,'CATALOG_IMPORT_INCOMPLETE');
        seen.add(pid);list.push({...p,externalId:pid,description:String(p.description || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()});
      }
      if(list.length>5000)fail('Use a bounded catalog import job for more than 5,000 products.',422,'CATALOG_IMPORT_INCOMPLETE');
      if(!batch.pageInfo.hasNextPage){complete=true;break;}
      const cursor=batch.pageInfo.endCursor;
      if(typeof cursor!=='string' || !cursor || cursors.has(cursor))fail('Shopify catalog pagination stalled.',409,'CATALOG_IMPORT_INCOMPLETE');
      cursors.add(cursor);after=cursor;
    }
    if(!complete)fail('Shopify catalog pagination exceeded the bounded import.',409,'CATALOG_IMPORT_INCOMPLETE');
    return list;
    },{complete:true});
  }
  async function change(brandId,patch,ctx,action,expectedOperation) {
    return db.transaction(async tx=>{
      await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const b=await load(brandId,tx);
      if(expectedOperation && (b.onboardingState?.activeOperation!==expectedOperation || !b.connectionHealthy || ['paused','disconnected'].includes(b.status)))fail('The selected store changed before onboarding completed.',409,'STORE_CONNECTION_CHANGED');
      const state={...b.onboardingState,...patch};
      await tx.query('UPDATE brands SET onboarding_state=$2,updated_at=$3 WHERE id=$1',[brandId,JSON.stringify(state),now()]);
      if(action)await audit(tx,brandId,actorName(ctx),action);return state;
    });
  }
  async function profile(brandId,source,metadata,ctx,expectedOperation) {
    const p=sanitizeStoreProfile(source,metadata || {});
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const b=await load(brandId,tx),edited=b.onboardingState?.profileEdited || [];
      if(expectedOperation && (b.onboardingState?.activeOperation!==expectedOperation || ['paused','disconnected'].includes(b.status)))fail('The selected store changed before its profile was saved.',409,'STORE_CONNECTION_CHANGED');
      await tx.query('UPDATE brands SET name=$2,support_email=$3,logo_url=$4,return_policy=$5,onboarding_state=$6,updated_at=$7 WHERE id=$1',
        [brandId,!edited.includes('name') && p.name ? p.name : b.name,!edited.includes('supportEmail') && p.contactEmail ? p.contactEmail : b.supportEmail,
          !edited.includes('logoUrl') && p.logoUrl ? p.logoUrl : b.logoUrl,!edited.includes('returnPolicy') && p.returnPolicy?.text ? p.returnPolicy.text : b.returnPolicy,
          JSON.stringify({...b.onboardingState,profileVerified:true,profileProvenance:p.provenance,storeProfileFields:Object.keys(p).filter(k=>['name','logoUrl','contactEmail','returnPolicy'].includes(k)),profileRequiresReview:true}),now()]);
      await audit(tx,brandId,actorName(ctx),'onboarding.profile_imported');
    });
    return p;
  }
  async function activate(brandId) {
    try {await domain.activateConnectedBrand(brandId,{actor:'onboarding-worker'});await change(brandId,{activationBlock:null});}
    catch(error) {if(error.statusCode!==409)throw error;await change(brandId,{activationBlock:safeFailure(error)});}
  }
  async function commitCatalog(brandId,s,ctx) {
    return db.transaction(async tx=>{
      await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const current=await load(brandId,tx),state=current.onboardingState || {};
      if(!state.connected || !current.connectionHealthy || ['paused','disconnected'].includes(current.status) || state.platform!==s.platform || state.connectionVersion!==s.connectionVersion)
        fail('The selected store changed before its catalog completed.',409,'STORE_CONNECTION_CHANGED');
      await tx.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[brandId,JSON.stringify({...state,catalogImportComplete:true,profileVerified:true,lastError:null})]);
      await audit(tx,brandId,actorName(ctx),'onboarding.catalog_imported');
      return {initialImport:state.catalogImportComplete!==true};
    });
  }
  const api={
    async status(brandId) {
      const b=await load(brandId),s=b.onboardingState || {},counts=await first(db,`SELECT COUNT(*)::int AS imported,COUNT(*) FILTER(WHERE status='approved' AND source_deleted_at IS NULL)::int AS approved,
        COUNT(*) FILTER(WHERE status IN('draft','in_review'))::int AS pending_curation FROM products WHERE brand_id=$1`,[brandId]);
      const payoutVerified=await domain.twoStepPayoutReady(brandId),payoutStatus=payoutVerified?'complete':b.payoutSetup==='pending'?'pending':'deferred';
      const connected=Boolean(s.connected && b.connectionHealthy && !['disconnected','paused'].includes(b.status));
      return {brand:{id:b.id,name:b.name,logoUrl:b.logoUrl,returnPolicy:b.returnPolicy,supportEmail:b.supportEmail,status:b.status},
        steps:{store:{complete:connected && s.catalogImportComplete===true,status:connected?'connected':s.activeOperation?'review_required':'not_connected'},
          payouts:{status:payoutStatus,deferred:payoutStatus==='deferred'}},
        connection:{platform:s.platform || null,storeUrl:s.storeUrl || null,status:connected?'connected':'not_connected',verified:connected,
          configured:Boolean(storeAdapters[s.platform] || ['csv','woocommerce','bigcommerce'].includes(s.platform)),simulated:storeAdapters[s.platform]?.simulated===true},
        catalog:{...counts,productsAreCurated:true,newProductsListedAutomatically:false},
        activation:{status:b.status,blockedReason:s.activationBlock || null,brandActive:['ready','live'].includes(b.status),productsRemainCurated:true},
        profile:{name:b.name,logoUrl:b.logoUrl,supportEmail:b.supportEmail,returnPolicy:b.returnPolicy,provenance:s.profileProvenance || 'invitation',requiresReview:s.profileRequiresReview!==false,fields:s.storeProfileFields || []},
        capabilities:{localOnly,discovery:detector.capabilities(),payouts:{configured:Boolean(payoutAdapter),mode:payoutAdapter?.mode || 'unconfigured',simulated:payoutAdapter?.simulated===true,providerVerified:payoutVerified,embedded:false},
          approvals:{shopify:'public_oauth_configuration_required',woocommerce:'manual_credentials_only',bigcommerce:'manual_credentials_only'},emailDelivery:'separate_server_configuration_required'},
        payoutNotice:!payoutVerified ? 'You can finish store onboarding now. Payouts are held until payout onboarding is verified; product approval is separate.' : null,
        lastError:s.lastError || null};
    },
    async detect(brandId,{storeUrl},ctx) {
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      const b=await load(brandId);
      if(b.onboardingState?.connected)fail('Disconnect the current store before choosing a different store.',409,'STORE_ALREADY_CONNECTED');
      const detected=await detector.detect({storeUrl});
      await change(brandId,{storeUrl:detected.storeUrl,platform:detected.platform,detectedAt:now().toISOString()},ctx,'onboarding.store_detected');
      return detected;
    },
    async connect(brandId,{platform,credentials={}},ctx={}) {
      if(!PLATFORMS.includes(platform))fail('Select a supported store or CSV fallback.');
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      const b=await load(brandId);
      if(b.status==='paused' || (b.status==='disconnected' && b.onboardingMode!=='two_step'))fail('An operator must reopen this brand before onboarding.',409,'BRAND_UNAVAILABLE');
      if(b.onboardingState?.connected) {
        if(b.onboardingState.platform!==platform)fail('Disconnect the existing store first.',409,'STORE_ALREADY_CONNECTED');
        return api.status(brandId);
      }
      if(platform==='shopify' && !storeAdapters.shopify) return {authorizationRequired:true,configured:false,next:{method:'POST',path:`/api/onboarding/${brandId}/shopify/authorize`},message:'Shopify needs a configured public OAuth callback. No connection is claimed yet.'};
      const operation=id('onb');
      await db.transaction(async tx=>{
        await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const current=await load(brandId,tx);
        if(current.onboardingState?.activeOperation)fail('An earlier connection/import may still be running. Review it; do not start another.',409,'ONBOARDING_OPERATION_PENDING');
        if(platform==='woocommerce' && current.onboardingState?.storeUrl && new URL(credentials.storeUrl).origin!==current.onboardingState.storeUrl)fail('Credentials must belong to the detected store.',409,'STORE_IDENTITY_MISMATCH');
        await tx.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[brandId,JSON.stringify({...current.onboardingState,platform,source:platform,connectionVersion:operation,activeOperation:operation,catalogImportComplete:false})]);
        await tx.query("INSERT INTO onboarding_operations(brand_id,operation_id,kind,state,created_at,updated_at) VALUES($1,$2,'connect','pending',$3,$3)",[brandId,operation,now()]);
      });
      try {
        const adapter=storeAdapters[platform];
        if(adapter) {
          const proof=await adapter.connect(brandId,credentials);
          if(proof?.verified!==true)fail('The store connection could not be verified.',409,'STORE_CONNECTION_UNVERIFIED');
          await domain.updateBrand(brandId,{connectionTier:platform==='csv'?'dashboard':platform,connectionHealthy:true});
          await db.query(`INSERT INTO brand_connectors(brand_id,platform,store_ref,created_at) VALUES($1,$2,$3,$4)
            ON CONFLICT(brand_id,platform) DO UPDATE SET status='connected',store_ref=EXCLUDED.store_ref`,[brandId,platform,proof.storeRef || 'isolated-test-store',now()]);
        } else await brands.connect(brandId,platform,credentials,{onboardingFlow:true});
        let metadata={};
        if(adapter?.profile)metadata=await adapter.profile(brandId);
        else if(platform!=='csv' && brands.connectedProfile)metadata=await brands.connectedProfile(brandId,platform);
        await profile(brandId,platform,metadata,ctx,operation);
        await db.transaction(async tx=>{
          await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const current=await load(brandId,tx);
          if(current.onboardingState?.activeOperation!==operation || !current.connectionHealthy || ['paused','disconnected'].includes(current.status))fail('The store changed while connecting.',409,'STORE_CONNECTION_CHANGED');
          await tx.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[brandId,JSON.stringify({...current.onboardingState,connected:true,activeOperation:null,lastError:null})]);
          await tx.query("UPDATE onboarding_operations SET state='complete',updated_at=$3 WHERE brand_id=$1 AND operation_id=$2",[brandId,operation,now()]);
          await audit(tx,brandId,actorName(ctx),'onboarding.store_connected');
        });
        if(platform!=='csv')await api.syncCatalog(brandId,ctx,operation);
        return api.status(brandId);
      } catch(error) {
        await db.transaction(async tx=>{
          await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const current=await load(brandId,tx);
          if(current.onboardingState?.activeOperation===operation)await tx.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[brandId,JSON.stringify({...current.onboardingState,activeOperation:null,lastError:safeFailure(error)})]);
          await tx.query("UPDATE onboarding_operations SET state='failed',updated_at=$3 WHERE brand_id=$1 AND operation_id=$2",[brandId,operation,now()]);
          await audit(tx,brandId,actorName(ctx),'onboarding.connection_review');
        });
        throw Object.assign(new Error('Store onboarding needs review. No products were automatically listed.'),{statusCode:error.statusCode || 502,code:safeFailure(error)});
      }
    },
    async syncCatalog(brandId,ctx={},expectedConnectionVersion) {
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      const b=await load(brandId),s=b.onboardingState || {},adapter=storeAdapters[s.platform];
      if(expectedConnectionVersion && s.connectionVersion!==expectedConnectionVersion)fail('The selected store changed before its catalog started.',409,'STORE_CONNECTION_CHANGED');
      if(!s.connected || !b.connectionHealthy)fail('Connect a store before importing products.',409,'STORE_CONNECTION_REQUIRED');
      const before=await rows(db,'SELECT id FROM products WHERE brand_id=$1',[brandId]);
      let result;
      try {result=adapter?.sync ? await adapter.sync(brandId) : s.platform==='shopify' ? await shopifySnapshot(brandId) : await brands.sync(brandId,s.platform);}
      catch(error){fail('Catalog synchronization needs review. No raw provider response is exposed.',502,safeFailure(error));}
      if(result?.complete===false || !Number.isInteger(result?.accepted) || result.accepted<0 || result.accepted!==result.total || result.errors?.length)
        fail('The catalog import is incomplete and cannot activate the brand.',409,'CATALOG_IMPORT_INCOMPLETE');
      const {initialImport}=await commitCatalog(brandId,s,ctx);
      if(initialImport && curation?.applyInitialAutoApprove) {
        const ids=Array.isArray(result.acceptedProductIds)?[...new Set(result.acceptedProductIds)].filter(id=>typeof id==='string' && !before.some(p=>p.id===id)):[];
        const expectedFingerprints=Object.fromEntries((Array.isArray(result.acceptedProducts)?result.acceptedProducts:[]).filter(p=>ids.includes(p?.id) && /^[a-f0-9]{64}$/.test(p.fingerprint || '')).map(p=>[p.id,p.fingerprint]));
        await curation.applyInitialAutoApprove(brandId,ids.slice(0,500),'system:onboarding',{expectedFingerprints});
      }
      await activate(brandId);return api.status(brandId);
    },
    async importCsv(brandId,{csv},ctx) {
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      let b=await load(brandId);
      if(!b.onboardingState?.connected)await api.connect(brandId,{platform:'csv'},ctx);
      b=await load(brandId);
      if(b.onboardingState.platform!=='csv')fail('Use the selected store connector for re-sync.',409,'STORE_PLATFORM_MISMATCH');
      const before=await rows(db,'SELECT id FROM products WHERE brand_id=$1',[brandId]);
      const result=await brands.importCsv(brandId,csv);
      if(result.errors?.length || !Number.isInteger(result.accepted) || result.accepted<1 || result.accepted!==result.total)fail('Resolve the rejected import rows before activation.',409,'CATALOG_IMPORT_INCOMPLETE');
      const {initialImport}=await commitCatalog(brandId,b.onboardingState,ctx);
      if(initialImport && curation?.applyInitialAutoApprove) {
        const ids=Array.isArray(result.acceptedProductIds)?[...new Set(result.acceptedProductIds)].filter(id=>typeof id==='string' && !before.some(p=>p.id===id)):[];
        const expectedFingerprints=Object.fromEntries((Array.isArray(result.acceptedProducts)?result.acceptedProducts:[]).filter(p=>ids.includes(p?.id) && /^[a-f0-9]{64}$/.test(p.fingerprint || '')).map(p=>[p.id,p.fingerprint]));
        await curation.applyInitialAutoApprove(brandId,ids.slice(0,500),'system:onboarding',{expectedFingerprints});
      }
      await activate(brandId);return api.status(brandId);
    },
    async updateProfile(brandId,input,ctx) {
      const allowed=['name','supportEmail','logoUrl','returnPolicy'];
      if(Object.keys(input).some(k=>!allowed.includes(k)))fail('Only display profile fields can be edited.');
      if(input.name!==undefined && (typeof input.name!=='string' || !input.name.trim() || input.name.length>160))fail('A name of 1–160 characters is required.');
      if(input.supportEmail!==undefined && !/^[^@\s\r\n]+@[^@\s\r\n]+\.[^@\s\r\n]+$/.test(input.supportEmail))fail('A valid contact email is required.');
      const logo=input.logoUrl ? sanitizeStoreProfile('shopify',{logoUrl:input.logoUrl}).logoUrl : '';
      if(input.logoUrl && !logo)fail('Use a supported provider HTTPS logo URL.');
      if(input.returnPolicy!==undefined && (typeof input.returnPolicy!=='string' || input.returnPolicy.length>12_000 || /<[^>]*>/.test(input.returnPolicy)))fail('Use plain return-policy text up to 12,000 characters.');
      await db.transaction(async tx=>{
        await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const b=await load(brandId,tx);
        await tx.query('UPDATE brands SET name=$2,support_email=$3,logo_url=$4,return_policy=$5,onboarding_state=$6,updated_at=$7 WHERE id=$1',
          [brandId,input.name?.trim() ?? b.name,input.supportEmail ?? b.supportEmail,input.logoUrl===undefined ? b.logoUrl : logo,input.returnPolicy ?? b.returnPolicy,
            JSON.stringify({...b.onboardingState,profileEdited:[...new Set([...(b.onboardingState?.profileEdited || []),...Object.keys(input)])],profileRequiresReview:false}),now()]);
        await audit(tx,brandId,actorName(ctx),'onboarding.profile_edited');
      });return api.status(brandId);
    },
    async deferPayouts(brandId,ctx) {
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      await db.transaction(async tx=>{
        await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const b=await load(brandId,tx);
        if(!await domain.twoStepPayoutReady(brandId,{tx}))await tx.query("UPDATE brands SET payout_setup='deferred' WHERE id=$1",[brandId]);
        await audit(tx,brandId,actorName(ctx),'onboarding.payout_setup_deferred');
      });return api.status(brandId);
    },
    async startPayouts(brandId,ctx) {
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      const b=await load(brandId);if(!payoutAdapter || payoutAdapter.mode!=='test' || typeof payoutAdapter.begin!=='function')unavailable();
      // No bank details or agreement acceptance are collected by Avafem here.
      const result=await payoutAdapter.begin({brandId,profile:{name:b.name,contactEmail:b.supportEmail},returnPath:'/'});
      let u;try{u=new URL(result?.url);}catch{unavailable();}
      if(u.protocol!=='https:' || !['connect.stripe.com','accounts.stripe.com'].includes(u.hostname) || u.port || u.username || u.password || u.hash || !/^\/(setup\/|r\/acct_)/.test(u.pathname))fail('The payout onboarding URL is invalid.',502,'PAYOUT_ONBOARDING_URL_INVALID');
      await change(brandId,{payoutOnboardingStartedAt:now().toISOString()},ctx,'onboarding.payout_setup_started');
      return {url:u.href,mode:'test',embedded:false,providerVerified:false,simulated:payoutAdapter.simulated===true};
    },
    async payoutPrompts() {
      const due=await rows(db,`SELECT b.id,MIN(j.due_at) AS due_at FROM brands b JOIN bags bag ON bag.brand_id=b.id JOIN jobs j ON j.bag_id=bag.id
        WHERE b.onboarding_mode='two_step' AND (NOT b.payouts_enabled OR b.stripe_account_id IS NULL)
          AND j.kind='sandbox_payout' AND j.status IN('held','scheduled') AND j.due_at<=$1 GROUP BY b.id`,[new Date(now().getTime()+3*86_400_000)]);
      for(const b of due) await db.query(`INSERT INTO platform_alerts(id,kind,severity,resource_id,message,dedupe_key,created_at)
        VALUES($1,'payout_onboarding_required','warning',$2,'Finish payout setup before releasing this brand’s held payables.',$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[id('alert'),b.id,`payout-onboarding:${b.id}`,now()]);
      return {prompted:due.length,channel:'admin_alert_and_brand_dashboard',externalEmailDelivered:false};
    },
    async authorizeShopify(brandId) {
      await domain.enterTwoStepOnboarding(brandId,{actor:'onboarding-worker'});
      const b=await load(brandId),s=b.onboardingState || {};
      if(!s.storeUrl || s.platform!=='shopify')fail('Detect the exact Shopify store first.',409,'SHOPIFY_STORE_REQUIRED');
      const shop=new URL(s.storeUrl).hostname;
      if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))fail('Use the store’s exact .myshopify.com address for approval.',422,'SHOPIFY_STORE_REQUIRED');
      return shopifyConnections.begin(brandId,shop);
    },
    async refreshStore(brandId,ctx={}) {
      await domain.enterTwoStepOnboarding(brandId,{actor:actorName(ctx)});
      const b=await load(brandId);
      if(b.onboardingState?.platform!=='shopify' || storeAdapters.shopify)return api.syncCatalog(brandId,ctx);
      const operation=id('onb');
      try {
        const {adapter,checked}=await nativeShopify(brandId);
        await db.transaction(async tx=>{
          await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const current=await load(brandId,tx);
          if(!current.connectionHealthy || ['paused','disconnected'].includes(current.status) || current.onboardingState?.activeOperation || current.onboardingState?.storeUrl!==b.onboardingState.storeUrl)
            fail('The selected store changed or another connection is running.',409,'STORE_CONNECTION_CHANGED');
          await tx.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[brandId,JSON.stringify({...current.onboardingState,activeOperation:operation,connectionVersion:operation})]);
        });
        const metadata=adapter.getStoreProfile ? await adapter.getStoreProfile() : checked.shop;
        await profile(brandId,'shopify',metadata,ctx,operation);
        await change(brandId,{connected:true,source:'shopify',lastError:null,unavailableProfileFields:['logoUrl','returnPolicy']},ctx,'onboarding.shopify_verified',operation);
        return await api.syncCatalog(brandId,ctx,operation);
      } catch(error){fail('Shopify connection or catalog import needs review. No products were automatically published.',502,safeFailure(error));}
      finally{await db.transaction(async tx=>{await tx.query('SELECT id FROM brands WHERE id=$1 FOR UPDATE',[brandId]);const current=await load(brandId,tx);
        if(current.onboardingState?.activeOperation===operation)await tx.query('UPDATE brands SET onboarding_state=$2 WHERE id=$1',[brandId,JSON.stringify({...current.onboardingState,activeOperation:null})]);});}
    },
  };
  return api;
}
