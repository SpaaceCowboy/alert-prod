import type { Vendor } from '../types.js';

export interface VendorConfig {
  baseURL: string;
  timeoutMs: number;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const timeout = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export const getVendorConfig = (vendor: Vendor): VendorConfig => {
  switch (vendor) {
    case 'axis':
      return { baseURL: required('AXIS_BASE_URL'), timeoutMs: timeout('AXIS_TIMEOUT_MS', 10_000) };
    case 'coinigo':
      return { baseURL: required('COINIGO_BASE_URL'), timeoutMs: timeout('COINIGO_TIMEOUT_MS', 15_000) };
    case 'b2broker':
      return { baseURL: required('B2BROKER_BASE_URL'), timeoutMs: timeout('B2BROKER_TIMEOUT_MS', 15_000) };
  }
};
