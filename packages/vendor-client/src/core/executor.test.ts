import assert from 'node:assert/strict';
import test from 'node:test';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { createVendorClient } from './interceptor.js';
import { createPhase1VendorExecutor } from './executor.js';
import type { RedisHealthGate } from './breaker.js';

class RedisUp implements RedisHealthGate {
  async get(): Promise<string | null> { return null; }
  async set(): Promise<unknown> { return 'OK'; }
  async publish(): Promise<unknown> { return 1; }
}

test('Phase 1 executor applies retries only through the endpoint registry', async () => {
  let attempts = 0;
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    attempts += 1;
    if (attempts < 2) {
      return Promise.reject(Object.assign(new Error('server error'), {
        config,
        response: { status: 503, config, data: {}, headers: {}, statusText: 'Unavailable' },
      }));
    }
    return { status: 200, data: { ok: true }, headers: {}, statusText: 'OK', config };
  };
  const client = createVendorClient('axis', { baseURL: 'https://unused.invalid', timeout: 100 });
  client.defaults.adapter = adapter;
  const executor = createPhase1VendorExecutor('axis', client, new RedisUp(), {
    enabled: true,
    sleep: async () => undefined,
    breaker: { volumeThreshold: 10 },
  });
  const response = await executor.request('axis.client.get', { method: 'GET', url: '/client' });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  executor.shutdown();
});

test('Phase 1 executor never retries an unlisted write', async () => {
  let attempts = 0;
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    attempts += 1;
    return Promise.reject(Object.assign(new Error('server error'), {
      config,
      response: { status: 503, config, data: {}, headers: {}, statusText: 'Unavailable' },
    }));
  };
  const client = createVendorClient('coinigo', { baseURL: 'https://unused.invalid', timeout: 100 });
  client.defaults.adapter = adapter;
  const executor = createPhase1VendorExecutor('coinigo', client, new RedisUp(), {
    enabled: true,
    sleep: async () => undefined,
  });
  await assert.rejects(executor.request('coinigo.withdrawal.create', { method: 'POST', url: '/payout' }));
  assert.equal(attempts, 1);
  executor.shutdown();
});

test('Phase 1 executor is disabled unless explicitly enabled', () => {
  const client = createVendorClient('axis', { baseURL: 'https://unused.invalid', timeout: 100 });
  assert.throws(
    () => createPhase1VendorExecutor('axis', client, new RedisUp(), { enabled: false }),
    /PHASE1_ENABLED=true/,
  );
});
