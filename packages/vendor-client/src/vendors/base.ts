import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { VendorRequestConfig } from '../types.js';

export class VendorApi {
  public constructor(protected readonly client: AxiosInstance) {}

  protected request<TResponse, TBody = unknown>(
    endpoint: string,
    config: AxiosRequestConfig<TBody>,
  ): Promise<AxiosResponse<TResponse>> {
    const instrumented: VendorRequestConfig<TBody> = {
      ...config,
      vendorMetadata: { endpoint },
    };
    return this.client.request<TResponse, AxiosResponse<TResponse>, TBody>(instrumented);
  }
}
