import { Pool, type QueryResult } from 'pg';
import type { VendorCallRecord } from '../types.js';

export interface Queryable {
  query(text: string, values: readonly unknown[]): Promise<QueryResult>;
}

let defaultPool: Pool | undefined;

const getDefaultPool = (): Pool => {
  if (!defaultPool) {
    defaultPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return defaultPool;
};

export type CallLogger = (record: VendorCallRecord) => void | Promise<void>;

export const createCallLogger = (database: Queryable = getDefaultPool()): CallLogger =>
  (record): void => {
    // Deliberately detached: database latency or failure must not affect the vendor response.
    void database.query(
      `insert into vendor_calls
        (vendor, endpoint, method, http_status, latency_ms, classification, error_class,
         idempotency_key_present, request_id, actor_id, action_type)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.vendor,
        record.endpoint,
        record.method,
        record.http_status,
        record.latency_ms,
        record.classification,
        record.error_class,
        record.idempotency_key_present,
        record.request_id,
        record.actor_id,
        record.action_type,
      ],
    ).catch(() => undefined);
  };

export const logVendorCall: CallLogger = (record) => {
  try {
    createCallLogger()(record);
  } catch {
    // Pool construction/configuration errors are also isolated from real calls.
  }
};
