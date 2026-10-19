import {fail} from './util.mjs';

// A field cannot be added to a renderer/rule engine without an explicit privacy
// declaration. Health-derived fields may never declare themselves non-health.
export function declareFields(definitions) {
  for (const [name,definition] of Object.entries(definitions)) {
    if (typeof definition.health!=='boolean' || !['profile','commerce','health'].includes(definition.source)
      || (definition.source==='health' && !definition.health))
      throw new Error(`Field ${name} needs an explicit, consistent health classification.`);
    Object.freeze(definition);
  }
  return Object.freeze(definitions);
}
export const SEGMENT_FIELDS=declareFields({
  cyclePhase:{source:'health',health:true},concern:{source:'health',health:true},
  minSpendCents:{source:'commerce',health:false},maxSpendCents:{source:'commerce',health:false},lapsedDays:{source:'commerce',health:false},
});
export const MESSAGE_FIELDS=declareFields({
  firstName:{source:'profile',health:false,read:({profile})=>profile.firstName || 'there'},
  nextPeriodStart:{source:'health',health:true,read:({cycle})=>cycle?.nextPeriodStart || ''},
  cyclePhase:{source:'health',health:true,read:({cycle})=>cycle?.phase || ''},
});
export const CAMPAIGN_KINDS=declareFields({broadcast:{source:'commerce',health:false},restock_reminder:{source:'health',health:true}});
export function rulesNeedHealth(rules={}) {
  if (!rules || typeof rules!=='object' || Array.isArray(rules)) fail('Segment rules must be an object.');
  let health=false;
  for (const key of Object.keys(rules)) {
    if (!Object.hasOwn(SEGMENT_FIELDS,key)) fail(`Unclassified segment field: ${key}.`,422,'HEALTH_CLASSIFICATION_REQUIRED');
    health ||= SEGMENT_FIELDS[key].health;
  }
  return health;
}
export function templateFields(template) {
  const fields=[...String(template).matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)].map(m=>m[1]);
  if (/{{|}}/.test(String(template).replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g,''))) fail('Invalid template field.',422,'HEALTH_CLASSIFICATION_REQUIRED');
  for (const field of fields) if (!Object.hasOwn(MESSAGE_FIELDS,field)) fail(`Unclassified message field: ${field}.`,422,'HEALTH_CLASSIFICATION_REQUIRED');
  return fields;
}
export function campaignNeedsHealth(campaign,segment) {
  if (!Object.hasOwn(CAMPAIGN_KINDS,campaign.kind)) fail('Unclassified campaign kind.',422,'HEALTH_CLASSIFICATION_REQUIRED');
  return campaign.health===true || segment?.health===true || CAMPAIGN_KINDS[campaign.kind].health
    || rulesNeedHealth(segment?.rules || {}) || templateFields(campaign.template).some(key=>MESSAGE_FIELDS[key].health);
}
export function renderMessage(template,values) {
  templateFields(template);
  return String(template).replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g,(_match,key)=>MESSAGE_FIELDS[key].read(values));
}
