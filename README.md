# Vendor Guardian — Phase 0

This repository currently implements passive measurement only. It adds no retries, circuit
breakers, alerts, or behavior changes to vendor calls.

## Local setup

1. With Node.js 20 or newer installed, run `npm install`.
2. Copy `.env.example` to `.env` and replace every placeholder URL. Credentials should be supplied
   by the calling service as headers; never commit them.
3. Start local infrastructure with `docker compose up -d`.
4. Apply the migration:

   ```sh
   psql "$DATABASE_URL" -f migrations/0001_vendor_calls.sql
   ```

5. Run `npm run build` and `npm test`.

Redis is provisioned for later phases but Phase 0 does not use it.

## Wire an existing axios call

The smallest change is to replace creation of the axios instance while leaving request and response
handling unchanged. Every request must supply a stable logical endpoint name, never the raw URL:

```ts
import { configuredVendorClient, type VendorRequestConfig } from '@roco/vendor-client';

const axis = configuredVendorClient('axis', {
  Authorization: `Bearer ${process.env.AXIS_TOKEN}`,
});

const response = await axis.request({
  method: 'GET',
  url: `/clients/${encodeURIComponent(clientId)}`,
  vendorMetadata: {
    endpoint: 'axis.client.get',
    actorId: clientId,
    actionType: 'client_lookup',
  },
} as VendorRequestConfig);
```

Alternatively, construct `AxisApi`, `CoinigoApi`, or `B2BrokerApi` with the configured client and
use their typed convenience methods. Authentication remains owned by the caller.

Logging is fire-and-forget and all logger failures are swallowed. Neither request/response bodies
nor raw wallet addresses, tokens, or credentials are written to `vendor_calls`.

## Baseline report

With `DATABASE_URL` exported, print the last 24 hours or seven days:

```sh
npm run report -- 24h
npm run report -- 7d
```

An ISO timestamp is also accepted. The report groups by vendor and logical endpoint and prints call
count, error rate, and latency p50/p95/p99.

## Manual verification

Vendor API paths, authentication, and response formats must be checked against each vendor's actual
contract before using the convenience wrappers. Live vendor calls are intentionally not part of the
automated tests.
