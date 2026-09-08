import assert from 'node:assert/strict';
import test from 'node:test';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { createVendorClient } from '../core/interceptor.js';
import { AxisApi, createAxisAuthHeaders, createAxisSignature } from './axis.js';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import {
  CoinigoApi,
  createCoinigoPayloadDigest,
  decodeCoinigoBusinessResponse,
  decryptCoinigoPayload,
  encryptCoinigoPayload,
  extractCoinigoAccessToken,
} from './coinigo.js';
import { getVendorConfig, isVendorEnabled } from '../config/vendors.js';

const capturingAdapter = (captured: InternalAxiosRequestConfig[]): AxiosAdapter => async (config) => {
  captured.push(config);
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};

test('Broctagon uses documented public v1 client and KYC paths', async () => {
  const captured: InternalAxiosRequestConfig[] = [];
  const client = createVendorClient('axis', {
    baseURL: 'https://tenant.example',
    timeout: 100,
    headers: createAxisAuthHeaders('secret-api-key'),
  }, () => undefined);
  client.defaults.adapter = capturingAdapter(captured);
  const api = new AxisApi(client);

  await api.getClient('12345678');
  await api.getKycStatus('12345678');

  assert.equal(captured[0]?.url, '/public/v1/users/12345678');
  assert.equal(captured[1]?.url, '/public/v1/users/12345678/kyc');
  assert.equal(captured[0]?.headers.get('key'), 'secret-api-key');
  assert.equal(createAxisSignature('key', '{"a":1}'), 'sha256=88a67f24bbcdaed0e6c997404bb79a743baf44c6bab2f4c27328e3009d22e342');
});

test('Coinigo uses documented sign-in, wallet and payout paths', async () => {
  const captured: InternalAxiosRequestConfig[] = [];
  const client = createVendorClient('coinigo', {
    baseURL: 'https://gw.coinigo.com/api/',
    timeout: 100,
    headers: { Authorization: 'Bearer token' },
  }, () => undefined);
  client.defaults.adapter = capturingAdapter(captured);
  const api = new CoinigoApi(client);

  await api.signIn('client', 'secret', 'digest');
  await api.getWallets('encrypted-query', 'wallet-digest', 'USDT');
  await api.getPayouts('encrypted-query', 'payout-digest');
  await api.createWithdrawal({ dataEncrypted: 'encrypted-body' }, 'payload-digest', 'REF-SYNTHETIC');

  assert.deepEqual(captured.map(({ method, url }) => [method, url]), [
    ['post', '/ipg/sign-in'],
    ['get', '/ipg/crypto/wallets'],
    ['get', '/ipg/crypto/pay-outs'],
    ['post', '/ipg/crypto/pay-outs/requests'],
  ]);
  assert.equal(captured[1]?.params.currencyCode, 'USDT');
  assert.equal(captured[1]?.headers.get('X-Payload-Digest'), 'wallet-digest');
  assert.equal(captured[3]?.headers.get('X-Payload-Digest'), 'payload-digest');
  assert.equal(createCoinigoPayloadDigest('key', '{"a":1}'), 'tVV6S488wwjRnrT2nzNjkqMe73s=');
  assert.equal(captured[3]?.headers.has('Idempotency-Key'), false);
  assert.deepEqual(JSON.parse(String(captured[0]?.data)), {
    data: { clientId: 'client', clientSecret: 'secret' },
  });
  assert.deepEqual(JSON.parse(String(captured[3]?.data)), {
    data: { dataEncrypted: 'encrypted-body' },
  });
});

test('Coinigo hybrid encryption uses RSA-2048 PKCS1 v1.5 and AES-256-CBC', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const plaintext = JSON.stringify({ currencyCode: 'USDT', unicode: 'ریال' });
  const combined = Buffer.from(encryptCoinigoPayload(publicKey, plaintext), 'base64');
  const keyAndIv = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    combined.subarray(0, 256),
  );
  assert.equal(keyAndIv.length, 48);
  const decipher = createDecipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32));
  const decrypted = Buffer.concat([decipher.update(combined.subarray(256)), decipher.final()]);
  assert.equal(decrypted.toString('utf8'), plaintext);
  assert.equal(decryptCoinigoPayload(privateKey, encryptCoinigoPayload(publicKey, plaintext)), plaintext);
  assert.deepEqual(
    decodeCoinigoBusinessResponse<{ RequestId: number }>(
      { data: { dataEncrypted: encryptCoinigoPayload(publicKey, JSON.stringify({ data: { RequestId: 42 } })) } },
      privateKey,
    ),
    { RequestId: 42 },
  );
});

test('Coinigo token extraction tolerates observed response variants', () => {
  assert.equal(extractCoinigoAccessToken({ accessToken: 'root-token' }), 'root-token');
  assert.equal(extractCoinigoAccessToken({ data: { token: 'nested-token' } }), 'nested-token');
  assert.equal(extractCoinigoAccessToken({ data: { jwt: 'nested-jwt' } }), 'nested-jwt');
  assert.throws(() => extractCoinigoAccessToken({ data: {} }), /did not contain a token/);
});

test('B2BROKER is disabled by default and has no guessed endpoint contract', () => {
  const previous = process.env.B2BROKER_ENABLED;
  delete process.env.B2BROKER_ENABLED;
  try {
    assert.equal(isVendorEnabled('b2broker'), false);
    assert.throws(() => getVendorConfig('b2broker'), /B2BROKER is disabled/);
  } finally {
    if (previous === undefined) delete process.env.B2BROKER_ENABLED;
    else process.env.B2BROKER_ENABLED = previous;
  }
});
