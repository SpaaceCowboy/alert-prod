import type { AxiosRequestConfig } from 'axios';

export type Vendor = 'axis' | 'coinigo' | 'b2broker';
export type VendorClassification = 'OK' | 'HARD_FAIL' | 'AUTH' | 'RATE_LIMIT' | 'UNKNOWN' | 'SLOW';
export type Phase0Classification = Exclude<VendorClassification, 'SLOW'>;

export interface VendorCallRecord {
  vendor: Vendor;
  endpoint: string;
  method: string;
  http_status: number | null;
  latency_ms: number;
  classification: VendorClassification | null;
  error_class: string | null;
  idempotency_key_present: boolean;
  request_id: string;
  actor_id: string | null;
  action_type: string | null;
}

export interface VendorRequestMetadata {
  endpoint: string;
  requestId?: string;
  actorId?: string;
  actionType?: string;
  isPaymentWrite?: boolean;
  paymentReference?: string;
}

export interface UnknownPaymentCall {
  vendor: Extract<Vendor, 'coinigo' | 'b2broker'>;
  endpoint: string;
  requestId: string;
  vendorReference: string;
  occurredAt: string;
}

export type VendorRequestConfig<D = unknown> = AxiosRequestConfig<D> & {
  vendorMetadata: VendorRequestMetadata;
};
