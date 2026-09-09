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

The Broctagon helpers use its documented `key` header and HMAC-SHA256 body signature. Coinigo's
helpers implement its confirmed hybrid format: a random AES-256-CBC key and IV are encrypted with
the supplied 2048-bit PEM RSA key using PKCS#1 v1.5, concatenated with the AES ciphertext, and the
complete result is Base64 encoded. The payload digest is HMAC-SHA1/Base64 over the exact plaintext
JSON. Coinigo does not document an idempotency header for payout creation, so no such header is sent
and payment writes must not be retried.

## Standalone Phase 0 measurement runner

When the calling middleware is not available, the standalone app provides operator-triggered,
read-only synthetic checks. It records those checks in vendor_calls, but it cannot passively observe
traffic made by another service. Apply 0001_vendor_calls.sql before using checks if measurements
must be retained.

The standalone app is a development shell around the same library that will later be imported by
the main middleware. It has no scheduler and performs calls only when explicitly requested. Set the
relevant values from `.env.example`, build, and start it:

```sh
npm run build
npm run start:standalone
```

It binds to `127.0.0.1:3001` by default. `/healthz` is a local liveness endpoint. Manual read-only
checks require `GUARDIAN_CONTROL_TOKEN` as a Bearer token:

```sh
curl http://127.0.0.1:3001/readyz
curl -X POST -H "Authorization: Bearer $GUARDIAN_CONTROL_TOKEN" http://127.0.0.1:3001/checks/axis/client
curl -X POST -H "Authorization: Bearer $GUARDIAN_CONTROL_TOKEN" http://127.0.0.1:3001/checks/axis/kyc
curl -X POST -H "Authorization: Bearer $GUARDIAN_CONTROL_TOKEN" http://127.0.0.1:3001/checks/coinigo/auth
curl -X POST -H "Authorization: Bearer $GUARDIAN_CONTROL_TOKEN" http://127.0.0.1:3001/checks/coinigo/wallets-experimental
```

The Coinigo wallet route is explicitly experimental: its path comes from vendor documentation, but
the working middleware has no retained wire capture proving its request/response envelope. Responses
expose only success and HTTP status—not vendor response bodies, client data, balances,
credentials, or wallet addresses. These calls are synthetic and do not replace production baseline
measurement. B2BROKER is intentionally absent until its official endpoint contract is verified.
It is disabled by default with `B2BROKER_ENABLED=false`, and its library wrapper exposes no guessed
endpoint methods. Keep it disabled until the official API paths, authentication, response formats,
transaction-status lookup, and idempotency guarantees have been reviewed.

## Ubuntu VPS deployment

The production Compose file exposes Guardian only on `127.0.0.1:3001`; PostgreSQL and Redis have no
host ports. Access it through SSH port forwarding until a private reverse proxy or Cloudflare Access
is configured.

On the VPS, install Docker Engine with the Compose plugin, copy this repository, then configure it:

```sh
cp .env.production.example .env.production
openssl rand -hex 32
```

Use separate generated values for `POSTGRES_PASSWORD` and `GUARDIAN_CONTROL_TOKEN`. If the database
password contains URL-special characters, URL-encode it in `DATABASE_URL`. Vendor values may remain
empty until issued; `/healthz` will still work, but vendor checks will not.

Build and start:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
docker compose --env-file .env.production -f docker-compose.production.yml ps
curl http://127.0.0.1:3001/healthz
```

From an administrator workstation, create an SSH tunnel without exposing the port publicly:

```sh
ssh -L 3001:127.0.0.1:3001 USER@VPS_IP
```

Then call `http://127.0.0.1:3001` locally. The migration is automatically applied only when the
PostgreSQL volume is first initialized. For an existing database, apply numbered migrations
explicitly rather than deleting the volume. Never commit `.env.production` or copy vendor secrets
into the image.

## Phase 1 development mode

Phase 1 is implemented with mocked tests but remains disabled by default with
`PHASE1_ENABLED=false`. It includes the exact `0002_expectations.sql` schema, policy-gated retry
executor, independent Opossum breakers with a Redis health gate, Phase 0 p95 baseline cache,
expectation producers/sweeper, and UNKNOWN-payment verification jobs.
The Phase 1 executor now refuses construction unless PHASE1_ENABLED=true; this is enforced at the
library boundary, not only by deployment convention.

For an existing Phase 0 PostgreSQL volume, apply the Phase 1 migration explicitly:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\"' \
  < migrations/0002_expectations.sql
```

Do not set `PHASE1_ENABLED=true` yet. The worker factories require real vendor status adapters,
and breaker/SLOW thresholds require Phase 0 measurements. Payment writes remain `NEVER_RETRY`;
timeouts are classified `UNKNOWN` and only status verification is permitted.

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
