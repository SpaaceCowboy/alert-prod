import type { AxiosInstance, AxiosResponse } from 'axios';
import { constants, createCipheriv, createHmac, publicEncrypt, randomBytes } from 'node:crypto';
import { VendorApi } from './base.js';

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
    { key: coinigoPublicKeyPem, padding: constants.RSA_PKCS1_PADDING },
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

export class CoinigoApi extends VendorApi {
  public constructor(client: AxiosInstance) { super(client); }

  signIn(clientId: string, clientSecret: string, digestSecret: string): Promise<AxiosResponse<CoinigoApiResponse<CoinigoAccessToken>>> {
    const plaintext = JSON.stringify({ clientId, clientSecret });
    return this.request('coinigo.auth.sign_in', {
      method: 'POST',
      url: '/ipg/sign-in',
      data: plaintext,
      headers: {
        'Content-Type': 'application/json',
        'X-Payload-Digest': createCoinigoPayloadDigest(digestSecret, plaintext),
      },
    });
  }

  getWallets(dataEncrypted: string, payloadDigest: string, currencyCode?: string): Promise<AxiosResponse<CoinigoWallet[]>> {
    return this.request('coinigo.balance.get', {
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

  createWithdrawal(encryptedPayload: CoinigoEncryptedPayload, payloadDigest: string): Promise<AxiosResponse<CoinigoEncryptedPayload>> {
    return this.request('coinigo.withdrawal.create', {
      method: 'POST',
      url: '/ipg/crypto/pay-outs/requests',
      data: encryptedPayload,
      headers: { 'X-Payload-Digest': payloadDigest },
    });
  }
}
