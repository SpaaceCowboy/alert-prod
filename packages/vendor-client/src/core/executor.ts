import { AxiosHeaders, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { Vendor, VendorRequestConfig, VendorRequestMetadata } from '../types.js';
import { isPhase1Enabled } from '../config/phase1.js';
import { createVendorBreaker, type RedisHealthGate, type VendorBreaker } from './breaker.js';
import { executeWithRetry } from './retry.js';

export interface VendorRequestExecutor {
  request<TResponse, TBody = unknown>(
    endpoint: string,
    config: AxiosRequestConfig<TBody>,
    metadata?: Omit<VendorRequestMetadata, 'endpoint'>,
  ): Promise<AxiosResponse<TResponse>>;
  shutdown(): void;
}

interface BreakerInput {
  endpoint: string;
  config: VendorRequestConfig<unknown>;
}

export interface Phase1ExecutorOptions {
  /**
   * Explicit escape hatch for tests and controlled composition. Production callers
   * should leave this unset so PHASE1_ENABLED remains the gate.
   */
  enabled?: boolean;
  healthTtlSeconds?: number;
  breaker?: {
    timeout?: number;
    errorThresholdPercentage?: number;
    resetTimeout?: number;
    volumeThreshold?: number;
  };
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

const idempotencyKeyPresent = (config: AxiosRequestConfig): boolean => {
  if (config.headers instanceof AxiosHeaders) {
    return Boolean(config.headers.get('idempotency-key') ?? config.headers.get('x-idempotency-key'));
  }
  return Object.entries(config.headers ?? {}).some(
    ([key, value]) =>
      (key.toLowerCase() === 'idempotency-key' || key.toLowerCase() === 'x-idempotency-key') &&
      value !== undefined &&
      value !== null &&
      value !== '',
  );
};

export const createPhase1VendorExecutor = (
  vendor: Vendor,
  client: AxiosInstance,
  redis: RedisHealthGate,
  options: Phase1ExecutorOptions = {},
): VendorRequestExecutor => {
  if (!(options.enabled ?? isPhase1Enabled())) {
    throw new Error('Phase 1 executor is disabled; set PHASE1_ENABLED=true before constructing it');
  }
  const breaker: VendorBreaker<BreakerInput, AxiosResponse> = createVendorBreaker({
    vendor,
    redis,
    healthTtlSeconds: options.healthTtlSeconds,
    breaker: options.breaker,
    action: ({ endpoint, config }) => executeWithRetry(
      () => client.request(config),
      {
        endpoint,
        maxAttempts: options.maxAttempts,
        baseDelayMs: options.baseDelayMs,
        idempotencyKeyPresent: idempotencyKeyPresent(config),
        sleep: options.sleep,
        random: options.random,
      },
    ),
  });
  return {
    request<TResponse, TBody = unknown>(
      endpoint: string,
      config: AxiosRequestConfig<TBody>,
      metadata: Omit<VendorRequestMetadata, 'endpoint'> = {},
    ): Promise<AxiosResponse<TResponse>> {
      const instrumented: VendorRequestConfig<TBody> = {
        ...config,
        vendorMetadata: { endpoint, ...metadata },
      };
      return breaker.execute({ endpoint, config: instrumented as VendorRequestConfig<unknown> }) as Promise<AxiosResponse<TResponse>>;
    },
    shutdown: () => breaker.shutdown(),
  };
};
