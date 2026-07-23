import assert from 'node:assert/strict';
import test from 'node:test';
import type { AxiosAdapter } from 'axios';
import { createVendorClient } from './interceptor.js';
import type { VendorCallRecord, VendorRequestConfig } from '../types.js';

test('records a successful call and preserves its response', async () => {
  const rows: VendorCallRecord[] = [];
  const client = createVendorClient('axis', { baseURL: 'https://unused.invalid', timeout: 100 }, (row) => { rows.push(row); });
  const adapter: AxiosAdapter = async (config) => ({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config });
  const response = await client.request({ method: 'GET', url: '/anything', adapter, vendorMetadata: { endpoint: 'axis.client.get' } } as VendorRequestConfig);
  assert.deepEqual(response.data, { ok: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.classification, 'OK');
  assert.equal(rows[0]?.endpoint, 'axis.client.get');
  assert.match(rows[0]?.request_id ?? '', /^[0-9a-f-]{36}$/);
});

test('a logger exception cannot break a vendor call', async () => {
  const client = createVendorClient('axis', { baseURL: 'https://unused.invalid', timeout: 100 }, () => { throw new Error('database down'); });
  const adapter: AxiosAdapter = async (config) => ({ data: 'still returned', status: 200, statusText: 'OK', headers: {}, config });
  const response = await client.request({ method: 'GET', url: '/', adapter, vendorMetadata: { endpoint: 'axis.client.get' } } as VendorRequestConfig);
  assert.equal(response.data, 'still returned');
});
