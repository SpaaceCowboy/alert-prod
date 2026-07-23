export * from './types.js';
export * from './config/vendors.js';
export * from './core/classifire.js';
export * from './core/interceptor.js';
export * from './logging/call-log.js';
export * from './vendors/axis.js';
export * from './vendors/coinigo.js';
export * from './vendors/b2broker.js';

import type { AxiosRequestConfig } from 'axios';
import { getVendorConfig  } from './config/vendors.js';
import { createVendorClient } from './core/interceptor.js';
import type { CallLogger } from './logging/call-log.js';
import type { Vendor } from './types.js'

export const configuredVendorClient = (
    vendor: Vendor,
    authHeaders: AxiosRequestConfig['headers'] = {},
    logger?: CallLogger
) => {
    const config = getVendorConfig(vendor);
    return createVendorClient(
        vendor,
        { baseURL: config.baseURL, timeout: config.timeoutMs, headers: authHeaders as Record<string, string>},
        logger,
    )
}