import { first, rows, sha, text } from './util.mjs';

/** Rule-based claim/ingredient screening before a listing can go live. Not legal advice:
 * flags disease/drug claims (FD&C Act / FTC), missing DSHEA disclaimers on supplements,
 * and restricted ingredients. `block` findings stop approval unless an operator overrides. */
const DISEASES = ['cancer', 'pcos', 'endometriosis', 'uti', 'urinary tract infection', 'yeast infection', 'candida', 'bacterial vaginosis', 'bv', 'std', 'sti', 'hpv', 'herpes',
  'diabetes', 'depression', 'anxiety disorder', 'infertility', 'covid', 'infection', 'fibroids', 'menorrhagia', 'osteoporosis', 'thyroid disease', 'hypertension'];
const DISEASE_VERBS = ['cure', 'cures', 'cured', 'treat', 'treats', 'treatment', 'prevent', 'prevents', 'heal', 'heals', 'diagnose', 'diagnoses', 'mitigate', 'reverses', 'eliminates', 'fights', 'kills'];
const DRUG_TERMS = [['antibiotic', 'block'], ['antifungal', 'block'], ['antiviral', 'block'], ['prescription strength', 'block'], ['fda approved', 'block'], ['clinically proven to cure', 'block'],
  ['replaces your medication', 'block'], ['no need for a doctor', 'block'], ['miracle', 'warn'], ['detox', 'warn'], ['balances hormones', 'warn'], ['boosts fertility', 'warn'], ['guaranteed results', 'warn']];
const RESTRICTED_INGREDIENTS = [['sibutramine', 'block'], ['dmaa', 'block'], ['ephedra', 'block'], ['ephedrine', 'block'], ['phenolphthalein', 'block'], ['dmha', 'block'],
  ['yohimbe', 'warn'], ['black cohosh', 'warn'], ['dong quai', 'warn'], ['st. john', 'warn'], ['hydroquinone', 'warn'], ['boric acid', 'warn']];
const DSHEA = /not been evaluated by the food and drug administration/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = term => new RegExp(`\\b${esc(term)}\\b`, 'i');

export function checkProduct(p) {
  const evidence = p.evidence || {};
  const claims = (evidence.claims || []).map(c => text(c.text, 3000));
  const corpus = [['title', p.title], ['description', p.description], ...claims.map((c, i) => [`evidence.claims.${i}`, c])].map(([f, v]) => [f, String(v || '')]);
  const flags = [];
  const add = (severity, code, field, match, message) => flags.push({ severity, code, field, match, message });
  for (const [field, value] of corpus) {
    const sentences = value.split(/(?<=[.!?;])\s+/);
    for (const s of sentences) {
      const verb = DISEASE_VERBS.find(v => word(v).test(s)); const disease = DISEASES.find(d => word(d).test(s));
      if (verb && disease) add('block', 'DISEASE_CLAIM', field, `${verb} … ${disease}`, 'Implies the product diagnoses, treats, cures or prevents a disease (drug claim).');
    }
    for (const [term, severity] of DRUG_TERMS) if (word(term).test(value)) add(severity, severity === 'block' ? 'DRUG_CLAIM' : 'RISKY_CLAIM', field, term, severity === 'block' ? 'Drug-style or regulatory claim not allowed on a cosmetic/supplement listing.' : 'Claim needs substantiation and careful wording.');
  }
  const ingredients = (evidence.ingredients_inci || []).map(i => String(i).toLowerCase());
  for (const [term, severity] of RESTRICTED_INGREDIENTS) if (ingredients.some(i => i.includes(term))) add(severity, severity === 'block' ? 'BANNED_INGREDIENT' : 'RESTRICTED_INGREDIENT', 'evidence.ingredients_inci', term, severity === 'block' ? 'Ingredient is banned or unlawful in supplements/cosmetics.' : 'Ingredient needs a warning or contraindication review.');
  const supplement = /supplement|vitamin|capsule|gummy|gummies|softgel|tablet/i.test(`${p.category} ${p.title}`);
  if (supplement) {
    const hasStructureClaim = (evidence.claims || []).some(c => c.type === 'structure' || c.type === 'health') || /supports|promotes|maintains/i.test(p.description || '');
    if (hasStructureClaim && !DSHEA.test(`${p.description} ${evidence.contraindications || ''}`)) add('block', 'MISSING_DSHEA_DISCLAIMER', 'description', null, 'Supplements with structure/function claims need the FDA (DSHEA) disclaimer.');
    if (!text(evidence.contraindications)) add('warn', 'MISSING_CONTRAINDICATIONS', 'evidence.contraindications', null, 'Add pregnancy/medication contraindications for supplements.');
  }
  const status = flags.some(f => f.severity === 'block') ? 'blocked' : flags.length ? 'flagged' : 'pass';
  return { status, supplement, flags };
}
const fingerprint = p => sha(JSON.stringify([p.title, p.description, p.category, p.evidence]));

export function createCompliance(db, { clock }) {
  const load = async (productId, query = db) => first(query, 'SELECT * FROM products WHERE id=$1', [productId]);
  const api = {
    // Approval callers pass their transaction and its freshly locked product. Never
    // route a transactional override read through the serialized outer database.
    async check(productOrId, query = db) {
      const p = typeof productOrId === 'string' ? await load(productOrId, query) : productOrId;
      if (!p) return null;
      const result = checkProduct(p);
      const o = p.id ? await first(query, 'SELECT * FROM compliance_overrides WHERE product_id=$1', [p.id]) : null;
      const full = p.evidence && p.title !== undefined && p.description !== undefined && p.category !== undefined;
      const overridden = Boolean(o && full && o.fingerprint === fingerprint(p));
      return { productId: p.id || null, ...result, overridden, override: overridden ? { reason: o.reason, actor: o.actor, at: o.createdAt } : null, canGoLive: result.status !== 'blocked' || overridden };
    },
    async scanBrand(brandId) {
      const list = await rows(db, 'SELECT * FROM products WHERE brand_id=$1 ORDER BY sku', [brandId]);
      const out = await Promise.all(list.map(p => api.check(p)));
      return { brandId, blocked: out.filter(r => r.status === 'blocked' && !r.overridden).map(r => r.productId), flagged: out.filter(r => r.status === 'flagged').map(r => r.productId), checked: out.length };
    },
    /** Operator override, bound to the exact listing content: any later edit invalidates it. */
    async override(productId, reason, actor) {
      const why = text(reason, 1000); if (why.length < 10) throw Object.assign(new Error('Give an override reason of at least 10 characters.'), { statusCode: 422, code: 'VALIDATION_ERROR' });
      return db.transaction(async tx => {
        await tx.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [productId]);
        const p = await load(productId, tx); if (!p) throw Object.assign(new Error('Product not found.'), { statusCode: 404, code: 'NOT_FOUND' });
        await tx.query(`INSERT INTO compliance_overrides(product_id,reason,actor,fingerprint,created_at) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(product_id) DO UPDATE SET reason=EXCLUDED.reason,actor=EXCLUDED.actor,fingerprint=EXCLUDED.fingerprint,created_at=EXCLUDED.created_at`, [productId, why, actor, fingerprint(p), clock()]);
        return api.check(p, tx);
      });
    },
  };
  return api;
}
