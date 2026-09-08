import axios, { AxiosHeaders, type AxiosError, type AxiosInstance, type AxiosRequestHeaders, type InternalAxiosRequestConfig } from 'axios';
import { randomUUID } from 'node:crypto';
import { classifyVendorCall } from './classifier.js';
import { logVendorCall, type CallLogger } from '../logging/call-log.js';
import type { UnknownPaymentCall, Vendor, VendorRequestMetadata } from '../types.js';

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
  instrumentation: VendorInstrumentationOptions = {},
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
    const classification = classifyVendorCall({
      status,
      latencyMs,
      error,
      p95LatencyMs: instrumentation.getP95LatencyMs?.(vendor, metadata.endpoint),
    });
    try {
      const logging = logger({
        vendor,
        endpoint: metadata.endpoint,
        method: (config.method ?? 'GET').toUpperCase(),
        http_status: status,
        latency_ms: latencyMs,
        classification,
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
    if (
      classification === 'UNKNOWN' &&
      metadata.isPaymentWrite &&
      metadata.paymentReference &&
      (vendor === 'coinigo' || vendor === 'b2broker')
    ) {
      try {
        const handling = instrumentation.onUnknownPayment?.({
          vendor,
          endpoint: metadata.endpoint,
          requestId: timing.requestId,
          vendorReference: metadata.paymentReference,
          occurredAt: new Date().toISOString(),
        });
        if (handling && typeof handling.catch === 'function') void handling.catch(() => undefined);
      } catch {
        // Verification enqueue failures cannot alter the original payment response/error.
      }
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
  instrumentation: VendorInstrumentationOptions = {},
): AxiosInstance => attachVendorInterceptors(axios.create(options), vendor, logger, instrumentation);

export interface VendorInstrumentationOptions {
  getP95LatencyMs?: (vendor: Vendor, endpoint: string) => number | undefined;
  onUnknownPayment?: (call: UnknownPaymentCall) => void | Promise<void>;
}
