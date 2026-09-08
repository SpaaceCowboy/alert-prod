import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { VendorRequestConfig, VendorRequestMetadata } from '../types.js';
import type { VendorRequestExecutor } from '../core/executor.js';

export class VendorApi {
  public constructor(
    protected readonly client: AxiosInstance,
    private readonly executor?: VendorRequestExecutor,
  ) {}

  protected request<TResponse, TBody = unknown>(
    endpoint: string,
    config: AxiosRequestConfig<TBody>,
    metadata: Omit<VendorRequestMetadata, 'endpoint'> = {},
  ): Promise<AxiosResponse<TResponse>> {
    if (this.executor) return this.executor.request<TResponse, TBody>(endpoint, config, metadata);
    const instrumented: VendorRequestConfig<TBody> = {
      ...config,
      vendorMetadata: { endpoint, ...metadata },
    };
    return this.client.request<TResponse, AxiosResponse<TResponse>, TBody>(instrumented);
  }
}
