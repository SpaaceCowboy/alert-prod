import type { AxiosError } from 'axios';
import { getRetryPolicy, type RetryPolicy } from '../config/retry-policy.js';
import { isTimeoutError } from './classifier.js';

export interface RetryOptions {
  endpoint: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  idempotencyKeyPresent?: boolean;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class RetrySafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RetrySafetyError';
  }
}

const paymentWriteEndpoints = new Set([
  'coinigo.withdrawal.create',
  'coinigo.deposit.create',
  'b2broker.withdrawal.create',
  'b2broker.deposit.create',
]);

export const isRetryableError = (error: unknown): boolean => {
  const candidate = error as Partial<AxiosError>;
  if (isTimeoutError({ code: candidate.code, message: candidate.message })) return true;
  if (candidate.response?.status !== undefined) return candidate.response.status >= 500;
  return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(candidate.code ?? '');
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const executeWithRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const policy: RetryPolicy = getRetryPolicy(options.endpoint);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const timeoutOnPayment = paymentWriteEndpoints.has(options.endpoint) &&
        isTimeoutError(error as { code?: string; message?: string });
      if (
        policy === 'RETRY_WITH_KEY' &&
        !options.idempotencyKeyPresent &&
        !timeoutOnPayment &&
        isRetryableError(error) &&
        attempt < maxAttempts
      ) {
        const safetyError = new RetrySafetyError(`Endpoint ${options.endpoint} requires an idempotency key before retry`);
        safetyError.cause = error;
        throw safetyError;
      }
      const canRetry =
        policy !== 'NEVER_RETRY' &&
        !timeoutOnPayment &&
        isRetryableError(error) &&
        attempt < maxAttempts;
      if (!canRetry) throw error;
      const exponential = (options.baseDelayMs ?? 250) * 2 ** (attempt - 1);
      const jittered = Math.round(exponential * (0.5 + random()));
      await sleep(jittered);
    }
  }
};
