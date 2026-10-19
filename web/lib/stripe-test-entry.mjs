const secretFieldNames = ['stripeTestSecretKey','stripeWebhookSigningSecret'];

export function isLoopbackHost(hostname) {
  return ['127.0.0.1','localhost','::1','[::1]'].includes(hostname);
}

export function clearStripeSecretForm(form) {
  if (!form) return;
  form.reset?.();
  for (const name of secretFieldNames) {
    const field = form.elements?.namedItem?.(name);
    if (field) field.value = '';
  }
}

/** Secrets remain transient form/request values; never return them to UI state. */
export async function configureStripeTestCredentials({form,csrfToken,hostname,isOwner,fetchImpl=globalThis.fetch}) {
  if (!isOwner || !isLoopbackHost(hostname)) throw new Error('Stripe test credentials can only be configured in the local operations workspace.');
  if (!csrfToken) throw new Error('Refresh the local operations session before configuring test credentials.');
  let secretKey = String(form?.elements?.namedItem?.('stripeTestSecretKey')?.value || '').trim();
  let webhookSecret = String(form?.elements?.namedItem?.('stripeWebhookSigningSecret')?.value || '').trim();
  try {
    if (!secretKey.startsWith('sk_test_')) throw new Error('Use a Stripe test secret key beginning sk_test_. Live keys are not accepted.');
    if (webhookSecret && !webhookSecret.startsWith('whsec_')) throw new Error('The optional webhook signing secret must begin whsec_.');
    let response;
    try {
      response = await fetchImpl('/api/local/stripe-test-credentials', {
        method:'POST', credentials:'same-origin', cache:'no-store', referrerPolicy:'no-referrer',
        headers:{'Content-Type':'application/json','x-csrf-token':csrfToken},
        body:JSON.stringify({secretKey,...(webhookSecret?{webhookSecret}:{})}),
      });
    } catch { throw new Error('Could not reach the local server. Check that it is running, then retry.'); }
    let body;
    try { body = await response.json(); } catch { throw new Error('The local server returned an unexpected response. Refresh and retry.'); }
    const result = body?.data;
    if (!response.ok || result?.configured!==true || result?.verified!==true || result?.mode!=='test' || result?.storage!=='process-memory' || result?.clearedOnRestart!==true) {
      // Do not surface raw provider/server errors: they could contain request values.
      throw new Error('The test credentials could not be verified. Check the key and local server, then retry.');
    }
    clearStripeSecretForm(form);
    return {configured:true,verified:true,mode:'test',accountId:typeof result.accountId==='string' && /^acct_[A-Za-z0-9]+$/.test(result.accountId)?result.accountId:undefined,webhookConfigured:result.webhookConfigured===true,storage:'process-memory',clearedOnRestart:true};
  } finally { secretKey=''; webhookSecret=''; }
}
