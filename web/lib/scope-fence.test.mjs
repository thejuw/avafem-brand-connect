import test from 'node:test';
import assert from 'node:assert/strict';
import {createScopeFence} from './scope-fence.mjs';
test('a workspace transition fences every older response even if the scope later returns to owner',()=>{
  const f=createScopeFence();f.change('owner');const owner=f.begin(),credential=f.capture();
  f.invalidate();assert.equal(f.current(owner),false);assert.equal(f.sameScope(credential),false);
  f.change('brand_a');const brand=f.begin();assert.equal(f.current(brand),true);f.change('owner');
  assert.equal(f.current(owner),false);assert.equal(f.current(brand),false);
});
test('a later refresh wins without making same-scope action tokens stale',()=>{
  const f=createScopeFence();f.change('brand_a');const action=f.capture(),first=f.begin(),last=f.begin();
  assert.equal(f.current(first),false);assert.equal(f.current(last),true);assert.equal(f.sameScope(action),true);
});
