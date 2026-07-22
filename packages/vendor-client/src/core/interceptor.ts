import axios, { AxiosHeaders, type AxiosError, type AxiosInstance, type AxiosRequestHeaders, type InternalAxiosRequestConfig } from 'axios';
import { randomUUID } from 'node:crypto';
import { classifyHttpStatus, classifyNetworkError } from './classifire.js';
import { logVendorCall, type CallLogger } from '../logging/call-log.js';
import type { Vendor, VendorRequestMetadata } from '../types.js';

type InstrumentedConfig = InternalAxiosRequestConfig & {
  vendorMetadata?: VendorRequestMetadata;
  vendorTiming?: { startedAt: bigint; requestId: string };
};

const hasIdempotencyKey = (headers: AxiosRequestHeaders): boolean => {
  const normalized = AxiosHeaders.from(headers);
  return Boolean(normalized.get('idempotency-key') ?? normalized.get('x-idempotency-key'));
};

export const attachVendorInterceptors = (
  client: AxiosInstance,
  vendor: Vendor,
  logger: CallLogger = logVendorCall,
): AxiosInstance => {
  client.interceptors.request.use((config: InstrumentedConfig) => {
    if (!config.vendorMetadata?.endpoint) {
      throw new Error('vendorMetadata.endpoint (a logical endpoint name) is required');
    }
    config.vendorTiming = {
      startedAt: process.hrtime.bigint(),
      requestId: config.vendorMetadata.requestId ?? randomUUID(),
    };
    return config;
  });

  const record = (config: InstrumentedConfig, status: number | null, error?: AxiosError): void => {
    const timing = config.vendorTiming;
    const metadata = config.vendorMetadata;
    if (!timing || !metadata) return;
    const latencyMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - timing.startedAt) / 1_000_000));
    try {
      const logging = logger({
        vendor,
        endpoint: metadata.endpoint,
        method: (config.method ?? 'GET').toUpperCase(),
        http_status: status,
        latency_ms: latencyMs,
        classification: status === null && error ? classifyNetworkError(error) : status === null ? null : classifyHttpStatus(status),
        error_class: error?.code ?? (error ? error.name : null),
        idempotency_key_present: hasIdempotencyKey(config.headers),
        request_id: timing.requestId,
        actor_id: metadata.actorId ?? null,
        action_type: metadata.actionType ?? null,
      });
      if (logging && typeof logging.catch === 'function') void logging.catch(() => undefined);
    } catch {
      // Custom loggers are held to the same non-blocking/non-breaking boundary.
    }
  };

  client.interceptors.response.use(
    (response) => {
      record(response.config as InstrumentedConfig, response.status);
      return response;
    },
    (error: AxiosError) => {
      if (error.config) record(error.config as InstrumentedConfig, error.response?.status ?? null, error);
      return Promise.reject(error);
    },
  );
  return client;
};

export const createVendorClient = (
  vendor: Vendor,
  options: { baseURL: string; timeout: number; headers?: Record<string, string> },
  logger: CallLogger = logVendorCall,
): AxiosInstance => attachVendorInterceptors(axios.create(options), vendor, logger);
