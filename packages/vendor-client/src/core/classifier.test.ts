import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHttpStatus, classifyNetworkError } from './classifier.js';

test('Phase 0 HTTP classifications match the build plan', () => {
  assert.equal(classifyHttpStatus(200), 'OK');
  assert.equal(classifyHttpStatus(204), 'OK');
  assert.equal(classifyHttpStatus(401), 'AUTH');
  assert.equal(classifyHttpStatus(403), 'AUTH');
  assert.equal(classifyHttpStatus(429), 'RATE_LIMIT');
  assert.equal(classifyHttpStatus(503), 'HARD_FAIL');
  assert.equal(classifyHttpStatus(400), null);
});

test('timeouts are UNKNOWN and other connection errors are HARD_FAIL', () => {
  assert.equal(classifyNetworkError({ code: 'ETIMEDOUT' }), 'UNKNOWN');
  assert.equal(classifyNetworkError({ code: 'ECONNABORTED' }), 'UNKNOWN');
  assert.equal(classifyNetworkError({ code: 'ECONNRESET' }), 'HARD_FAIL');
});
