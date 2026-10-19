import { readFile } from 'node:fs/promises';
import { exec } from './util.mjs';
import { createHealthVault } from './health.mjs';
import { createCrm } from './crm.mjs';

/** Avafem backend + CRM platform modules layered on the canonical sandbox core.
 * All external delivery (email/SMS, Stripe, Shopify, Woo, BigCommerce) is simulated. */
export async function createPlatform(db, { domain, auth, secret, clock = () => new Date() }) {
  await exec(db, await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const health = await createHealthVault(db, { secret, clock });
  const platform = { db, domain, auth, clock, health };
  platform.crm = createCrm(db, { secret, clock, health, domain, get bank() { return platform.bank; } });
  platform.refundBag = async (bagId, reason) => {
    const refund = await domain.requestRefund(bagId, { reason });
    const approved = await domain.approveSandboxRefund(refund.id);
    if (platform.afterRefund) await platform.afterRefund(bagId);
    return approved;
  };
  platform.jobs = async () => ({ campaigns: await platform.crm.runActiveCampaigns() });
  return platform;
}
