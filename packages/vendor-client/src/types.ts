import type { AxiosRequestConfig } from 'axios';

export type Vendor = 'axios' | 'coinigo' | 'b2broker';
export type Phase0Classification = 'OK' | 'HARD_FAIL' | 'AUTH' | 'RATE_LIMIT' | 'UNKNOWN';

export interface VendorCallRecord {
    vendor: Vendor;
    endpoint: string;
    method: string;
    http_status: number | null;
    latency_ms: number;
    classification: Phase0Classification | null;
    error_class: string | null;
    idempotency_key_present: boolean;
    request_id: string;
    actor_id: string | null;
    action_type: string | null
}

export interface VendorRequestMetadata {
    endpoint: string;
    requestId?: string;
    actorId: string;
    actionType?: string;
}

export type VendorRequestConfig<D = unknown> = AxiosRequestConfig<D> & {
    vendorMetadata: VendorRequestMetadata;
}