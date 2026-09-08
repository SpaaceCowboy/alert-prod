import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult } from 'pg';
import type { Queryable } from '@roco/vendor-client';
import { createUnknownPaymentEnqueuer, PaymentStillPendingError, processVerifyPayment, type VerifyPaymentJobData } from './verify-payment.js';
import { failOverdueExpectations } from './check-expectations.js';

const data: VerifyPaymentJobData = {
  vendor: 'coinigo',
  endpoint: 'coinigo.withdrawal.create',
  requestId: 'request-synthetic',
  vendorReference: 'reference-synthetic',
  occurredAt: '2026-01-01T00:00:00Z',
  firstUnknownAt: '2026-01-01T00:00:00Z',
};

test('verification records terminal status and never submits a payment', async () => {
  const recorded: string[] = [];
  const result = await processVerifyPayment({ data }, {
    lookupStatus: async () => 'succeeded',
    recordResolution: async (_job, status) => { recorded.push(status); },
    escalateAfterMs: 60_000,
    now: () => Date.parse('2026-01-01T00:00:01Z'),
  });
  assert.deepEqual(result, { resolution: 'succeeded' });
  assert.deepEqual(recorded, ['succeeded']);
});

test('pending verification backs off, then becomes unknown after escalation deadline', async () => {
  await assert.rejects(processVerifyPayment({ data }, {
    lookupStatus: async () => 'pending',
    recordResolution: async () => undefined,
    escalateAfterMs: 60_000,
    now: () => Date.parse('2026-01-01T00:00:01Z'),
  }), PaymentStillPendingError);

  const recorded: string[] = [];
  const result = await processVerifyPayment({ data }, {
    lookupStatus: async () => 'pending',
    recordResolution: async (_job, status) => { recorded.push(status); },
    escalateAfterMs: 60_000,
    now: () => Date.parse('2026-01-01T00:02:00Z'),
  });
  assert.deepEqual(result, { resolution: 'unknown' });
  assert.deepEqual(recorded, ['unknown']);
});

test('UNKNOWN enqueue is deduplicated by vendor and request ID', async () => {
  const calls: unknown[][] = [];
  const enqueue = createUnknownPaymentEnqueuer({
    async add(...args: unknown[]): Promise<unknown> { calls.push(args); return {}; },
  });
  await enqueue({
    vendor: 'coinigo',
    endpoint: 'coinigo.withdrawal.create',
    requestId: 'request-synthetic',
    vendorReference: 'reference-synthetic',
    occurredAt: '2026-01-01T00:00:00Z',
  });
  const options = calls[0]?.[2] as { jobId: string; attempts: number };
  assert.equal(options.jobId, 'verify:coinigo:request-synthetic');
  assert.equal(options.attempts, 12);
});

test('expectation sweep marks only overdue pending rows failed', async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const database: Queryable = {
    async query(text, values): Promise<QueryResult> {
      calls.push({ text, values });
      return { rows: [{ id: '1', action_type: 'deposit' }], rowCount: 1 } as QueryResult;
    },
  };
  const failed = await failOverdueExpectations(database, new Date('2026-01-01T00:00:00Z'));
  assert.equal(failed.length, 1);
  assert.match(calls[0]?.text ?? '', /status = 'pending' and deadline_at < \$1/);
});
