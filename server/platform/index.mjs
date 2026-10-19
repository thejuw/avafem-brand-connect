import { readFile } from 'node:fs/promises';
import { exec } from './util.mjs';
import { createHealthVault } from './health.mjs';
import { createCrm } from './crm.mjs';
import { createBrandSide } from './brands.mjs';
import { createCompliance } from './compliance.mjs';
import { createSubscriptions, createShipping, createPrivacy } from './commerce.mjs';
import { createBeautyBank, createRisk, createConsole, createReports } from './money.mjs';
import {createCuration} from './curation.mjs';
import {createOnboarding} from './onboarding.mjs';
import {createInviteDelivery,createResendInviteAdapter} from './invite-delivery.mjs';

/** Avafem platform modules layered on the canonical sandbox core. Email/SMS and
 * subscription charges are simulated. Explicitly connected Woo/BigCommerce
 * adapters use bounded real HTTPS unless a test transport is injected. These
 * features do not replace or certify the provider-backed unified checkout. */
export async function createPlatform(db, options) {
  const { domain, auth, secret, clock = () => new Date() } = options;
  await exec(db, await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const health = await createHealthVault(db, { secret, clock });
  const platform = { db, domain, auth, clock, health };
  platform.crm = createCrm(db, { secret, clock, health, domain, get bank() { return platform.bank; } });
  platform.bank = createBeautyBank(db, { clock, ...(options.bank || {}) });
  platform.risk = createRisk(db, { clock });
  platform.console = createConsole(db, { clock, domain, risk: platform.risk, secret,creditExpiryDays:options.bank?.expiryDays ?? 365 });
  platform.reports = createReports(db, { domain });
  platform.brands = createBrandSide(db, { clock, domain, auth, secret, shopifyConnections: options.shopifyConnections, ...(options.fetch ? { fetch: options.fetch } : {}),
    compliance: { check: (...a) => platform.compliance?.check(...a) ?? null, scanBrand: (...a) => platform.compliance?.scanBrand(...a) ?? null } });
  platform.compliance = createCompliance(db, { clock });
  platform.curation=createCuration(db,{domain,compliance:platform.compliance,clock});
  platform.onboarding=createOnboarding(db,{domain,auth,brands:platform.brands,curation:platform.curation,compliance:platform.compliance,
    shopifyConnections:options.shopifyConnections,clock,...(options.onboarding || {})});
  const email=options.inviteDelivery || {};
  platform.inviteDelivery=createInviteDelivery(db,{auth,domain,clock,secret,publicBaseUrl:email.publicBaseUrl || options.publicBaseUrl,
    adapter:email.adapter || (email.enableExternal===true ? createResendInviteAdapter({apiKey:email.apiKey,from:email.from}) : null),allowExternal:email.enableExternal===true});
  platform.subscriptions = createSubscriptions(db, { clock, domain, crm: platform.crm, health, bank: platform.bank, secret, charge: options.subscriptionCharge });
  platform.shipping = createShipping(db, { clock });
  platform.privacy = createPrivacy(db, { clock, crm: platform.crm, health, bank: platform.bank, secret });
  platform.afterRefund = bagId => platform.bank.reverseRefunded(bagId);
  platform.refundBag = async (bagId, reason) => {
    const refund = await domain.requestRefund(bagId, { reason });
    const approved = await domain.approveSandboxRefund(refund.id);
    if (platform.afterRefund) await platform.afterRefund(bagId);
    return approved;
  };
  platform.jobs = async () => ({ healthMigration: await health.migrateOutbox(),onboardingPayoutPrompts:await platform.onboarding.payoutPrompts(),subscriptions: await platform.subscriptions.runDue(), bank: await platform.bank.run(), campaigns: await platform.crm.runActiveCampaigns(),
    alerts: (await platform.console.scan()).length });
  return platform;
}
