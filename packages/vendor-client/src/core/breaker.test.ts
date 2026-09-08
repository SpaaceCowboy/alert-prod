import assert from 'node:assert/strict';
import test from 'node:test';
import { createVendorBreaker, VendorUnavailableError, type RedisHealthGate } from './breaker.js';

class FakeRedis implements RedisHealthGate {
  public readonly values = new Map<string, string>();
  public readonly messages: string[] = [];
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<unknown> { this.values.set(key, value); return 'OK'; }
  async publish(_channel: string, message: string): Promise<unknown> { this.messages.push(message); return 1; }
}

test('Opossum open state is published to the shared Redis gate', async () => {
  const redis = new FakeRedis();
  const breaker = createVendorBreaker({
    vendor: 'axis',
    redis,
    action: async () => { throw new Error('vendor down'); },
    breaker: { volumeThreshold: 1, errorThresholdPercentage: 1, resetTimeout: 60_000 },
  });
  await assert.rejects(breaker.execute(undefined));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(redis.values.get('vendor:health:axis'), 'down');
  await assert.rejects(breaker.execute(undefined), VendorUnavailableError);
  assert.match(redis.messages[0] ?? '', /"vendor":"axis"/);
  breaker.shutdown();
});

test('vendors use independent breaker health keys', async () => {
  const redis = new FakeRedis();
  redis.values.set('vendor:health:axis', 'down');
  const coinigo = createVendorBreaker({
    vendor: 'coinigo',
    redis,
    action: async (value: string) => value,
  });
  assert.equal(await coinigo.execute('ok'), 'ok');
  coinigo.shutdown();
});

test('a Redis read outage does not become a vendor outage', async () => {
  const redis: RedisHealthGate = {
    async get() { throw new Error('redis unavailable'); },
    async set() { throw new Error('redis unavailable'); },
    async publish() { throw new Error('redis unavailable'); },
  };
  const breaker = createVendorBreaker({
    vendor: 'axis',
    redis,
    action: async () => 'vendor-response',
  });
  assert.equal(await breaker.execute(undefined), 'vendor-response');
  breaker.shutdown();
});
