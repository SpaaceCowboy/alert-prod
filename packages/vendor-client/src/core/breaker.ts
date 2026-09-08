import CircuitBreaker, { type Options as OpossumOptions } from 'opossum';
import { Redis } from 'ioredis';
import type { Vendor } from '../types.js';

export interface RedisHealthGate {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
}

export interface VendorBreakerOptions<TInput, TResult> {
  vendor: Vendor;
  redis: RedisHealthGate;
  action: (input: TInput) => Promise<TResult>;
  healthTtlSeconds?: number;
  breaker?: OpossumOptions;
}

export class VendorUnavailableError extends Error {
  public constructor(public readonly vendor: Vendor) {
    super(`${vendor} is marked down by the shared Redis health gate`);
    this.name = 'VendorUnavailableError';
  }
}

export interface VendorBreaker<TInput, TResult> {
  execute(input: TInput): Promise<TResult>;
  shutdown(): void;
}

export const createVendorBreaker = <TInput, TResult>(
  options: VendorBreakerOptions<TInput, TResult>,
): VendorBreaker<TInput, TResult> => {
  const key = `vendor:health:${options.vendor}`;
  const channel = 'vendor:health:transitions';
  const ttl = options.healthTtlSeconds ?? 30;
  const breaker = new CircuitBreaker(options.action, {
    name: `vendor-${options.vendor}`,
    timeout: 10_000,
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
    volumeThreshold: 10,
    ...options.breaker,
  });

  const transition = (state: 'up' | 'down'): void => {
    void Promise.all([
      options.redis.set(key, state, 'EX', ttl),
      options.redis.publish(channel, JSON.stringify({ vendor: options.vendor, state })),
    ]).catch(() => undefined);
  };
  breaker.on('open', () => transition('down'));
  breaker.on('halfOpen', () => transition('down'));
  breaker.on('close', () => transition('up'));

  return {
    async execute(input: TInput): Promise<TResult> {
      const sharedState = await options.redis.get(key).catch(() => null);
      if (sharedState === 'down') throw new VendorUnavailableError(options.vendor);
      return breaker.fire(input);
    },
    shutdown(): void {
      breaker.shutdown();
    },
  };
};

export const createRedisHealthGate = (redisUrl: string): Redis =>
  new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
