/** Public integration errors contain no credentials or raw upstream responses. */
export class IntegrationError extends Error {
  constructor(message, { code = 'INTEGRATION_ERROR', statusCode = 502, retryable = false, details, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    if (details) this.details = details;
  }
}

export class IntegrationUnavailableError extends IntegrationError {
  constructor(provider, reason = 'Credentials have not been configured.') {
    super(`${provider} is unavailable. ${reason}`, { code: 'INTEGRATION_UNAVAILABLE', statusCode: 503 });
    this.provider = provider;
  }
}

/** A write may have succeeded remotely. Callers MUST reconcile; never blindly retry/fallback. */
export class UncertainOperationError extends IntegrationError {
  constructor(provider, operation, reference, cause) {
    super(`${provider} ${operation} has an uncertain outcome. Reconciliation is required before any retry or fallback.`, {
      code: 'OUTCOME_UNCERTAIN', statusCode: 409, retryable: false, cause,
      details: { provider, operation, reference, requiresReconciliation: true },
    });
    this.requiresReconciliation = true;
  }
}

export function invalid(message) {
  return new IntegrationError(message, { code: 'INVALID_INTEGRATION_INPUT', statusCode: 422 });
}

export function cents(value, label = 'amount', { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw invalid(`${label} must be an integer amount in minor currency units.`);
  return value;
}
