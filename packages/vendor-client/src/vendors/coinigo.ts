import type { AxiosInstance, AxiosResponse } from 'axios';
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { VendorApi } from './base.js';
import type { VendorRequestExecutor } from '../core/executor.js';

export interface CoinigoApiResponse<T> { requestId: string; apiVersion?: string | null; data: T }
export interface CoinigoAccessToken { accessToken: string; tokenType: string; expiresIn: number }
export interface CoinigoWallet {
  walletName: string;
  accountNumber: string;
  currencyName: string;
  currencyCode: string;
  availableBalance: number;
  totalBalance: number;
}
export interface CoinigoPayout {
  requestId: number;
  referenceNumber: string;
  networkName: string;
  networkCode: string;
  amount: number;
  address: string;
  memo?: string | null;
  status: string;
  note?: string | null;
}
export interface CoinigoEncryptedPayload { dataEncrypted: string }

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

const normalizePem = (pem: string): string => pem.replaceAll('\\n', '\n');

/** HMAC-SHA1 over the exact plaintext JSON, encoded as Base64 per Coinigo v1.6.0. */
export const createCoinigoPayloadDigest = (digestSecret: string, plaintextJson: string): string =>
  createHmac('sha1', Buffer.from(digestSecret, 'ascii'))
    .update(Buffer.from(plaintextJson, 'ascii'))
    .digest('base64');

/**
 * Coinigo hybrid encryption: RSA-PKCS1-v1_5(AES-256 key || 128-bit IV) ||
 * AES-256-CBC(UTF-8 plaintext), with the complete byte sequence Base64 encoded.
 */
export const encryptCoinigoPayload = (coinigoPublicKeyPem: string, plaintextJson: string): string => {
  const aesKey = randomBytes(32);
  const iv = randomBytes(16);
  const encryptedKeyAndIv = publicEncrypt(
    { key: normalizePem(coinigoPublicKeyPem), padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([aesKey, iv]),
  );
  if (encryptedKeyAndIv.length !== 256) {
    throw new Error('COINIGO_PUBLIC_KEY_PEM must contain a 2048-bit RSA public key');
  }
  const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
  const encryptedPayload = Buffer.concat([
    cipher.update(Buffer.from(plaintextJson, 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([encryptedKeyAndIv, encryptedPayload]).toString('base64');
};

/** Decrypts Coinigo's observed direct-RSA or hybrid RSA/AES response format. */
export const decryptCoinigoPayload = (merchantPrivateKeyPem: string, base64Ciphertext: string): string => {
  const key = createPrivateKey(normalizePem(merchantPrivateKeyPem));
  const modulusBits = key.asymmetricKeyDetails?.modulusLength;
  if (!modulusBits || modulusBits % 8 !== 0) throw new Error('Unable to determine Coinigo response RSA block size');
  const rsaBlockBytes = modulusBits / 8;
  const raw = Buffer.from(base64Ciphertext, 'base64');
  if (raw.length < rsaBlockBytes) throw new Error('Coinigo encrypted response is shorter than one RSA block');

  if (raw.length % rsaBlockBytes === 0) {
    try {
      const plaintext = Buffer.concat(
        Array.from({ length: raw.length / rsaBlockBytes }, (_, index) =>
          privateDecrypt(
            { key, padding: constants.RSA_PKCS1_PADDING },
            raw.subarray(index * rsaBlockBytes, (index + 1) * rsaBlockBytes),
          )),
      ).toString('utf8');
      JSON.parse(plaintext);
      return plaintext;
    } catch {
      // The hybrid payload can coincidentally be a multiple of the RSA block size.
    }
  }

  const keyAndIv = privateDecrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    raw.subarray(0, rsaBlockBytes),
  );
  if (keyAndIv.length !== 48) throw new Error('Coinigo hybrid response key material must be 48 bytes');
  const decipher = createDecipheriv('aes-256-cbc', keyAndIv.subarray(0, 32), keyAndIv.subarray(32));
  return Buffer.concat([decipher.update(raw.subarray(rsaBlockBytes)), decipher.final()]).toString('utf8');
};

/** Accepts root/nested ciphertext and the observed decrypted `{data: ...}` envelope. */
export const decodeCoinigoBusinessResponse = <T>(response: unknown, merchantPrivateKeyPem?: string): T => {
  const root = asRecord(response);
  const nested = asRecord(root?.data);
  const ciphertext = typeof root?.dataEncrypted === 'string'
    ? root.dataEncrypted
    : typeof nested?.dataEncrypted === 'string'
      ? nested.dataEncrypted
      : undefined;
  if (ciphertext && !merchantPrivateKeyPem) {
    throw new Error('Merchant private key is required for encrypted Coinigo responses');
  }
  const decoded: unknown = ciphertext
    ? JSON.parse(decryptCoinigoPayload(merchantPrivateKeyPem as string, ciphertext))
    : response;
  return (asRecord(decoded)?.data ?? decoded) as T;
};

export const extractCoinigoAccessToken = (response: unknown): string => {
  const root = asRecord(response);
  const nested = asRecord(root?.data);
  for (const source of [root, nested]) {
    for (const key of ['token', 'accessToken', 'jwt']) {
      const value = source?.[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  throw new Error('Coinigo sign-in response did not contain a token');
};

export class CoinigoApi extends VendorApi {
  public constructor(client: AxiosInstance, executor?: VendorRequestExecutor) { super(client, executor); }

  signIn(clientId: string, clientSecret: string, digestSecret: string): Promise<AxiosResponse<unknown>> {
    const credentials = { clientId, clientSecret };
    const plaintext = JSON.stringify(credentials);
    return this.request('coinigo.auth.sign_in', {
      method: 'POST',
      url: '/ipg/sign-in',
      data: { data: credentials },
      headers: {
        'Content-Type': 'application/json',
        'X-Payload-Digest': createCoinigoPayloadDigest(digestSecret, plaintext),
      },
    });
  }

  getWallets(dataEncrypted: string, payloadDigest: string, currencyCode?: string): Promise<AxiosResponse<CoinigoWallet[]>> {
    return this.request('coinigo.wallet.experimental', {
      method: 'GET',
      url: '/ipg/crypto/wallets',
      params: { ...(currencyCode ? { currencyCode } : {}), dataEncrypted },
      headers: { 'X-Payload-Digest': payloadDigest },
    });
  }

  getPayouts(dataEncrypted: string, payloadDigest: string): Promise<AxiosResponse<CoinigoPayout[]>> {
    return this.request('coinigo.withdrawal.list', {
      method: 'GET',
      url: '/ipg/crypto/pay-outs',
      params: { dataEncrypted },
      headers: { 'X-Payload-Digest': payloadDigest },
    });
  }

  createWithdrawal(
    encryptedPayload: CoinigoEncryptedPayload,
    payloadDigest: string,
    vendorReference: string,
  ): Promise<AxiosResponse<CoinigoEncryptedPayload>> {
    return this.request('coinigo.withdrawal.create', {
      method: 'POST',
      url: '/ipg/crypto/pay-outs/requests',
      data: { data: encryptedPayload },
      headers: { 'X-Payload-Digest': payloadDigest },
    }, {
      isPaymentWrite: true,
      paymentReference: vendorReference,
      actionType: 'withdrawal',
    });
  }
}
