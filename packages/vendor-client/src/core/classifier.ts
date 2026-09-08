import type { Phase0Classification, VendorClassification } from '../types.js';

export const classifyHttpStatus = (status: number): Phase0Classification | null => {
  if (status >= 200 && status < 300) return 'OK';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'HARD_FAIL';
  return null;
};

export const isTimeoutError = (error: { code?: string; message?: string }): boolean =>
  error.code === 'ECONNABORTED' ||
  error.code === 'ETIMEDOUT' ||
  /timeout/i.test(error.message ?? '');

export const classifyNetworkError = (error: { code?: string; message?: string }): Phase0Classification =>
  isTimeoutError(error) ? 'UNKNOWN' : 'HARD_FAIL';

export interface ClassificationInput {
  status: number | null;
  latencyMs: number;
  error?: { code?: string; message?: string };
  p95LatencyMs?: number;
}

export const classifyVendorCall = (input: ClassificationInput): VendorClassification | null => {
  const base = input.status === null && input.error
    ? classifyNetworkError(input.error)
    : input.status === null
      ? null
      : classifyHttpStatus(input.status);
  if (
    base === 'OK' &&
    input.p95LatencyMs !== undefined &&
    input.p95LatencyMs > 0 &&
    input.latencyMs > input.p95LatencyMs
  ) {
    return 'SLOW';
  }
  return base;
};
