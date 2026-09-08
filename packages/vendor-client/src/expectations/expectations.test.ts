import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryResult } from 'pg';
import { ExpectationService, ExpectedActionProducer } from './expectations.js';
import type { Queryable } from '../logging/call-log.js';

class FakeDatabase implements Queryable {
  public calls: Array<{ text: string; values: readonly unknown[] }> = [];
  async query(text: string, values: readonly unknown[]): Promise<QueryResult> {
    this.calls.push({ text, values });
    return { rows: [{ id: '7' }], rowCount: 1 } as QueryResult;
  }
}

test('expect and fulfill use the exact expectation columns', async () => {
  const database = new FakeDatabase();
  const service = new ExpectationService(database);
  assert.equal(await service.expect({
    action_type: 'deposit',
    subject_ref: 'txn-synthetic',
    amount_minor: 123n,
    deadline: new Date('2026-01-01T01:00:00Z'),
    expected_outcome: 'balance_credited',
    metadata: { source: 'test' },
  }), '7');
  assert.match(database.calls[0]?.text ?? '', /action_type, subject_ref, amount_minor, deadline_at, expected_outcome, metadata/);
  assert.equal(await service.fulfill('txn-synthetic', 'deposit'), true);
  assert.match(database.calls[1]?.text ?? '', /status = 'fulfilled'/);
});

test('expectation producers calculate configured deadlines and reject PII metadata', async () => {
  const database = new FakeDatabase();
  const service = new ExpectationService(database);
  const producer = new ExpectedActionProducer(service, {
    depositMs: 1_000,
    withdrawalMs: 2_000,
    kycMs: 3_000,
    emailMs: 4_000,
  }, () => new Date('2026-01-01T00:00:00Z'));
  await producer.withdrawal('withdrawal-synthetic', 500n);
  assert.equal((database.calls[0]?.values[3] as Date).toISOString(), '2026-01-01T00:00:02.000Z');
  await assert.rejects(service.expect({
    action_type: 'deposit',
    subject_ref: 'synthetic',
    deadline: new Date(),
    expected_outcome: 'done',
    metadata: { walletAddress: 'forbidden' },
  }), /forbidden by PII policy/);
});
