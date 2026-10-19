/** Async responses must belong to the current workspace, not an old cookie scope. */
export function createScopeFence() {
  let generation=0,scope='uninitialized',request=0;
  return {
    change(next){scope=next || 'owner';generation++;request=0;},
    invalidate(){generation++;request=0;},
    capture(){return {generation,scope};},
    begin(){return {generation,scope,request:++request};},
    sameScope(token){return Boolean(token && token.generation===generation && token.scope===scope);},
    current(token){return Boolean(token && token.generation===generation && token.scope===scope && token.request===request);},
  };
}
