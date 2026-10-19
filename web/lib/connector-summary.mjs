import { displayLabel } from './display-label.mjs';

export function connectorSummary(result = {}) {
  if (Number.isFinite(result.imported) || Array.isArray(result.products)) {
    const products = Array.isArray(result.products) ? result.products : [];
    return {
      kind:'import',
      title:'Catalog import complete',
      imported:Number.isFinite(result.imported) ? result.imported : products.length,
      issues:Array.isArray(result.issues) ? result.issues.length : 0,
      drafts:products.filter(product => product.status === 'draft').length,
    };
  }
  const missingScopes = Array.isArray(result.missingScopes) ? result.missingScopes.filter(scope => typeof scope === 'string') : [];
  return {
    kind:'preflight', title:'Shopify preflight complete',
    verified:result.verified === true && missingScopes.length === 0,
    shop:displayLabel(result.shop, 'Configured store'),
    app:displayLabel(result.app, 'Installed app'),
    missingScopes,
  };
}
