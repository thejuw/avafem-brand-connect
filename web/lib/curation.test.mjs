import test from 'node:test';
import assert from 'node:assert/strict';
import {autoApproveRequest,bulkCurationRequest,curationQuery,curationReasons,isFlagged,normalizeCuration,productChanged} from './curation.mjs';
const clean={id:'product_one',fingerprint:'fingerprint_v1',compliance:{status:'pass',canGoLive:true,flags:[]}};
const base={operationId:'curation_operation_01',reason:'Reviewed synthetic product selection',action:'approved',products:[clean]};

test('auto-approval defaults off and normalizes the canonical brand setting',()=>{
  const data=normalizeCuration({brands:[{id:'a'},{id:'b',autoApproveProducts:true},{id:'c',autoApproveClean:true}]});
  assert.deepEqual(data.brands.map(b=>b.autoApproveClean),[false,true,true]);
  assert.deepEqual(normalizeCuration(null || {}).products,[]);
  assert.throws(()=>autoApproveRequest(true,''));
  assert.deepEqual(autoApproveRequest(false,'Do not auto-approve this brand'),{enabled:false,reason:'Do not auto-approve this brand'});
});

test('filters support exact IDs, collections/types/tags and new/changed review state',()=>{
  const path=curationQuery({brandId:'brand_test',ids:'one,two one',collection:'Cycle care',productType:'Cup',tag:'cotton',sinceReview:'new_or_changed'});
  const query=new URL(path,'https://local.example').searchParams;
  assert.equal(query.get('ids'),'one,two');assert.equal(query.get('collection'),'Cycle care');assert.equal(query.get('productType'),'Cup');assert.equal(query.get('tag'),'cotton');assert.equal(query.get('sinceReview'),'new_or_changed');
  assert.equal(productChanged({changedSinceReview:true}),true);assert.equal(productChanged({isChanged:true}),true);
});

test('bulk decisions send only displayed IDs and optimistic fingerprints, never raw product/private data',()=>{
  const request=bulkCurationRequest({...base,products:[{...clean,secret:'not for the server',title:'Synthetic'}]});
  assert.deepEqual(request.products,[{id:'product_one',fingerprint:'fingerprint_v1'}]);
  assert.equal(request.action,'approved');assert.equal(request.filter,undefined);
  assert.throws(()=>bulkCurationRequest({...base,products:[{id:'product_one'}]}),/fingerprint/);
  assert.throws(()=>bulkCurationRequest({...base,products:[clean,clean]}),/Duplicate/);
});

test('warnings and blocking compliance need a separate exact-content override, not just the bulk reason',()=>{
  for(const severity of ['warn','block']){
    const product={...clean,compliance:{status:'flagged',canGoLive:severity==='warn',flags:[{code:'SYNTHETIC_FLAG',severity,message:'Human review required'}]}};
    assert.equal(isFlagged(product),true);
    assert.throws(()=>bulkCurationRequest({...base,products:[product]}),/separate explicit override/);
    const result=bulkCurationRequest({...base,products:[product],overrideReason:'Reviewed exact synthetic evidence for this flag'});
    assert.equal(result.products[0].fingerprint,'fingerprint_v1');assert.ok(result.products[0].overrideReason);
    assert.equal(bulkCurationRequest({...base,action:'rejected',products:[product]}).products[0].overrideReason,undefined);
  }
});

test('already recorded exact-content overrides do not require invented new evidence; unknown checks fail closed',()=>{
  const product={...clean,compliance:{status:'flagged',flags:[{code:'known'}],overridden:true}};
  assert.equal(bulkCurationRequest({...base,products:[product]}).products[0].overrideReason,undefined);
  assert.equal(isFlagged({id:'unknown'}),true);
  assert.deepEqual(curationReasons({compliance:{flags:[{code:'CHECK',message:'Review claim'}]},validationIssues:[{field:'ingredients',message:'Supply evidence'}]}),[{code:'CHECK',message:'Review claim'},{code:'ingredients',message:'Supply evidence'}]);
});

test('bounded, audited decisions cannot submit empty, oversized or unsupported bulk actions',()=>{
  for(const change of [{reason:''},{operationId:'bad'},{action:'approve'},{products:[]},{limit:0}])assert.throws(()=>bulkCurationRequest({...base,...change}));
});
