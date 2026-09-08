import assert from 'node:assert/strict';
import test from 'node:test';
import { RETRY_POLICY } from '../config/retry-policy.js';
import { executeWithRetry, RetrySafetyError } from './retry.js';

const error = (status?: number, code?: string): Error & { response?: { status: number }; code?: string } =>
  Object.assign(new Error(code ?? `HTTP ${status}`), {
    ...(status === undefined ? {} : { response: { status } }),
    ...(code ? { code } : {}),
  });

test('unlisted endpoints default to NEVER_RETRY', async () => {
  let attempts = 0;
  await assert.rejects(
    executeWithRetry(async () => {
      attempts += 1;
      throw error(503);
    }, { endpoint: 'unlisted.endpoint', sleep: async () => undefined }),
  );
  assert.equal(attempts, 1);
});

test('SAFE_TO_RETRY retries 5xx with exponential jitter but never 4xx', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await executeWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw error(503);
    return 'ok';
  }, {
    endpoint: 'axis.client.get',
    baseDelayMs: 100,
    random: () => 0.5,
    sleep: async (delay) => { delays.push(delay); },
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);

  attempts = 0;
  await assert.rejects(executeWithRetry(async () => {
    attempts += 1;
    throw error(400);
  }, { endpoint: 'axis.client.get', sleep: async () => undefined }));
  assert.equal(attempts, 1);
});

test('RETRY_WITH_KEY requires a key and payment timeouts remain non-retryable even with one', async () => {
  const endpoint = 'coinigo.withdrawal.create';
  const previous = RETRY_POLICY[endpoint];
  RETRY_POLICY[endpoint] = 'RETRY_WITH_KEY';
  try {
    let missingKeyAttempts = 0;
    await assert.rejects(
      executeWithRetry(async () => {
        missingKeyAttempts += 1;
        throw error(503);
      }, { endpoint }),
      RetrySafetyError,
    );
    assert.equal(missingKeyAttempts, 1);
    let attempts = 0;
    await assert.rejects(executeWithRetry(async () => {
      attempts += 1;
      throw error(undefined, 'ETIMEDOUT');
    }, {
      endpoint,
      idempotencyKeyPresent: true,
      sleep: async () => undefined,
    }));
    assert.equal(attempts, 1);
  } finally {
    RETRY_POLICY[endpoint] = previous ?? 'NEVER_RETRY';
  }
});
