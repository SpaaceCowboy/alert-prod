import type { AxiosInstance } from 'axios';
import { VendorApi } from './base.js';

/**
 * Reserved for the verified B2BROKER integration. No endpoint methods are exposed because
 * the official API contract has not been supplied; guessed payment endpoints are unsafe.
 */
export class B2BrokerApi extends VendorApi {
  public constructor(client: AxiosInstance) { super(client); }
}
