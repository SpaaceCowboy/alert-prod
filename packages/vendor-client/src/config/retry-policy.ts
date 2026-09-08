export type RetryPolicy = 'SAFE_TO_RETRY' | 'NEVER_RETRY' | 'RETRY_WITH_KEY';
// Default for anything not listed is NEVER_RETRY.
export const RETRY_POLICY: Record<string, RetryPolicy> = {
  'axis.client.get':        'SAFE_TO_RETRY',
  'axis.balance.get':       'SAFE_TO_RETRY',
  'axis.kyc.status.get':    'SAFE_TO_RETRY',
  'coinigo.withdrawal.create': 'NEVER_RETRY',   // promote to RETRY_WITH_KEY only if idempotency confirmed
  'b2broker.withdrawal.create':'NEVER_RETRY',
  'coinigo.deposit.create':    'NEVER_RETRY',
  'b2broker.deposit.create':   'NEVER_RETRY',
};

export const getRetryPolicy = (endpoint: string): RetryPolicy =>
  RETRY_POLICY[endpoint] ?? 'NEVER_RETRY';
