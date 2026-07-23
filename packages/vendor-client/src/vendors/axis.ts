import type { AxiosInstance, AxiosResponse } from 'axios';
import { createHmac } from 'node:crypto';
import { VendorApi } from './base.js';

export interface AxisClient { id: string; [key: string]: unknown }
export interface AxisKycField { key: string; type: string; [key: string]: unknown }

export const createAxisAuthHeaders = (apiKey: string): Record<string, string> => ({ key: apiKey });

/** Signs the exact UTF-8 request body using Broctagon Authentication V2. */
export const createAxisSignature = (apiKey: string, serializedBody: string): string =>
  `sha256=${createHmac('sha256', apiKey).update(serializedBody, 'utf8').digest('hex')}`;

export class AxisApi extends VendorApi {
  public constructor(client: AxiosInstance) { super(client); }
  getClient(clientId: string): Promise<AxiosResponse<AxisClient>> {
    return this.request('axis.client.get', { method: 'GET', url: `/public/v1/users/${encodeURIComponent(clientId)}` });
  }
  getKycStatus(clientId: string): Promise<AxiosResponse<AxisKycField[]>> {
    return this.request('axis.kyc.status.get', { method: 'GET', url: `/public/v1/users/${encodeURIComponent(clientId)}/kyc` });
  }
}
