# Coinigo + Broctagon Integration Technical Handoff

**Repository:** `https://github.com/SpaaceCowboy/Coinigo-integration`
**Branch:** `main`
**Runtime:** Node.js 20+, TypeScript, Express, PostgreSQL/Sequelize, Redis/Bull
**Sanitization:** All examples are synthetic. Credentials, tokens, keys, wallet
addresses, contract addresses, emails, phone numbers, client PII, and production
payloads are intentionally omitted or replaced with explicit redaction markers.

## 1. Evidence labels

Every claim in this handoff uses one of these labels:

- **[Vendor documented]**: stated in the supplied Coinigo v1.6 PDF or the
  Broctagon public documentation.
- **[Observed working]**: required by the deployed/tested integration or
  established during vendor debugging, but not treated as a contractual vendor
  guarantee.
- **[Implementation policy]**: a safety or lifecycle decision made by this
  middleware.

Vendor references:

- Coinigo: `CoiniGo API Documentation - Crypto Payment Gateway v1.6.0-1.pdf`
  (local, intentionally ignored by Git).
- Broctagon PSP:
  [introduction](https://open-api-docs.broctagon.com/psp/introduction.html),
  [get payment URL](https://open-api-docs.broctagon.com/psp/api/get-payment-url.html),
  [payment callback](https://open-api-docs.broctagon.com/psp/api/payment-callback.html).
- Broctagon REST/Open API: endpoint behavior encoded in
  `src/services/broctagon/requests.ts`; verify against the tenant's current
  Broctagon Open API version before changing signatures.

## 2. System boundary

The middleware bridges:

1. Broctagon CRM deposit requests to Coinigo's hosted pay-in UI.
2. Coinigo pay-in webhooks to Broctagon's PSP payment callback.
3. Broctagon approved-withdrawal webhooks to Coinigo pay-out requests.
4. Coinigo pay-out webhooks to Broctagon withdrawal approve/reject calls.

The service supports one configured asset/network. Exact address-like values
are deliberately excluded from this handoff; see `src/config/asset.ts` in the
secured repository.

## 3. Endpoint inventory

### 3.1 Middleware inbound

| Method | Path | Caller | Authentication | Success |
|---|---|---|---|---|
| `GET` | `/health` | Load balancer/operator | None | `200 {"status":"ok","service":"coinigo-middleware"}` |
| `POST` | `/pay/url` | Broctagon CRM | `crm-pay-token` header | HTTP 200 with PSP result envelope |
| `POST` | `/webhooks/coinigo/payin` | Coinigo | Encrypted body; optional/configured digest validation | `200 {"received":true}` after persistence and enqueue |
| `POST` | `/webhooks/coinigo/payout` | Coinigo | Encrypted body; optional/configured digest validation | `200 {"received":true}` after persistence and enqueue |
| `POST` | `/webhooks/broctagon/withdrawal` | Broctagon CRM | `X-Crm-Signature` HMAC | `200 {"received":true}` after persistence and enqueue |

The Express JSON limit is 1 MiB. Raw request bytes are retained for Broctagon
webhook signature verification.

### 3.2 Coinigo outbound

Paths are relative to `COINIGO_BASE_URL`.

| Method | Path | Purpose | Security/serialization |
|---|---|---|---|
| `POST` | `/ipg/sign-in` | Obtain JWT | Plain JSON wrapper `{data: credentials}` plus digest over inner credentials |
| `POST` | `/ipg/b2p/crypto/token` | Obtain hosted UI token | Plain JSON wrapper `{data: request}` plus JWT and digest over inner request |
| Browser | `/?token=<url-encoded-token>` | Hosted pay-in UI | Token in query string |
| `POST` | `/ipg/crypto/pay-outs/requests` | Submit pay-out | JWT, digest, hybrid encrypted business JSON, outer `{data:{dataEncrypted}}` |
| `GET` | `/ipg/crypto/pay-outs` | Query pay-out status | JWT, digest, encrypted `dataEncrypted` query parameter |

### 3.3 Broctagon outbound

| Method | Path | Purpose | Security |
|---|---|---|---|
| `POST` | `{CRM_Callback_URL}/pay/callback` | Deposit result | `crm-pay-token` plus PSP `sign` field |
| `POST` | `{BROCTAGON_API_BASE_URL}/public/v1/requests/withdrawal/approve` | Finalize successful withdrawal | Open API `key` and `signature` headers |
| `POST` | `{BROCTAGON_API_BASE_URL}/public/v1/requests/withdrawal/reject` | Reject failed/invalid withdrawal | Open API `key` and `signature` headers |

## 4. Coinigo protocol

### 4.1 Authentication and JWT handling

**[Observed working]**

Sign-in body:

```json
{
  "data": {
    "clientId": "<REDACTED_CLIENT_ID>",
    "clientSecret": "<REDACTED_CLIENT_SECRET>"
  }
}
```

`X-Payload-Digest` is computed over only the serialized inner credentials,
not the outer `{data: ...}` wrapper.

The response parser accepts a token named `token`, `accessToken`, or `jwt`,
either at the root or under `data`. The JWT is cached in memory. Its `exp` claim
is used when decodable; otherwise the implementation assumes a 12-hour lifetime.
Refresh begins 60 minutes before expiry, concurrent sign-ins are coalesced, and
a scheduled refresh runs every six hours. A downstream 401 invalidates the
cache and causes one fresh-auth retry.

### 4.2 UI token request

**[Observed working]**

The inner request type is:

```ts
interface CoinigoUiTokenRequest {
  clientId: string;
  clientSecretKey: string;
  customerIdentifier: string; // Broctagon user_id
  returnUrl: string;
  customerUserAgent?: string;
  customerIp?: string;
  paymentTracker: {
    paymentTrackingId: string; // Broctagon order_no
    paymentExpirationTime?: string; // ISO-8601 UTC
  };
}
```

The working HTTP body wraps that request as `{ "data": <request> }`. The digest
is computed over `JSON.stringify(request)`.

`customerIp` and `customerUserAgent` are deliberately omitted because
`/pay/url` is server-to-server; values available there were the CRM HTTP
client/proxy rather than the end-user browser. Sending a loopback IP was
observed to produce a Coinigo 500.

`paymentExpirationTime` is derived from the deposit intent creation time plus
`DEPOSIT_PENDING_TIMEOUT_MINUTES`. This keeps Coinigo tracker validity aligned
with CRM pending-order expiration.

The token parser accepts `token`, `uiToken`, or `accessToken`, at root or under
`data`.

### 4.3 Encryption, encoding, and digest

The following describes the **working implementation**, not a general Coinigo
cryptographic guarantee.

**[Observed working]**

| Parameter | Value |
|---|---|
| RSA key type | RSA PEM |
| Configured modulus | 2048 bits |
| RSA padding | PKCS#1 v1.5 (`RSA_PKCS1_PADDING` / `RSAES-PKCS1-V1_5`) |
| OAEP/MGF parameters | Not applicable |
| Symmetric cipher | AES-256-CBC |
| AES key | 32 random bytes |
| IV | 16 random bytes |
| Plaintext | UTF-8 `JSON.stringify` output |
| Ciphertext transport | Base64 |
| Digest | HMAC-SHA1 |
| Digest input | Exact plaintext JSON, updated as ASCII by current code |
| Digest output | Base64 |

Outbound hybrid layout:

```text
Base64(
  RSA_PKCS1_v1_5_Encrypt(coinigo_public_key, aes_key_32 || iv_16)
  ||
  AES_256_CBC_Encrypt(aes_key_32, iv_16, utf8_json)
)
```

Node's AES API applies standard PKCS#7-compatible block padding.

Inbound decryption dynamically derives the RSA block size from the configured
private key. It first attempts direct RSA PKCS#1 v1.5 block decryption. If that
does not parse, it falls back to the hybrid format above for compatibility with
observed callbacks/responses.

The public/private PEM strings may contain real newlines or literal `\n`
sequences. They are normalized at startup; malformed keys fail startup.

### 4.4 Response handling

**[Observed working]**

Coinigo response shapes have varied. The decoder accepts:

- root `{dataEncrypted: "..."}`
- nested `{data: {dataEncrypted: "..."}}`
- decrypted `{data: <business response>}`
- already-decoded business data

Pay-out submission extracts `RequestId`, `requestId`, or `id`. Status queries
accept common PascalCase/camelCase variants for status, request ID, and
transaction hash.

### 4.5 Coinigo errors and retry behavior

**[Observed working]**

- All Coinigo HTTP clients use a 20-second timeout.
- Network/no-response errors and HTTP 5xx responses are retried up to three
  total attempts.
- Backoff before attempts 2 and 3 is 300 ms and 600 ms.
- Ordinary 4xx responses are not retried.
- A 401 triggers JWT invalidation, sign-in, and one immediate retry.
- Sign-in 400 bodies contain useful rejection details; the integration logs the
  HTTP status and vendor response body, then rethrows.
- Missing token fields produce local errors:
  `Coinigo sign-in response did not contain a token` or
  `Coinigo UI token response did not contain a token`.

Never copy logged vendor bodies into a handoff without re-sanitizing them.

## 5. Broctagon protocol

### 5.1 PSP get-payment-URL

**[Vendor documented]** Broctagon sends:

```ts
interface BroctagonPayUrlRequest {
  merchant_id: string;
  order_no: string;
  amount: number;
  currency: string;
  user_id: string;
  user_name?: string;
  email?: string;
  // Additional tenant-configured fields may be present.
}
```

**[Observed working]** Authentication is the `crm-pay-token` header, compared
in constant time. The handler accepts additional body fields and does not
validate the body-level `sign`, because the working CRM call did not supply a
usable PSP body signature for this endpoint.

Success:

```json
{
  "data": {"url": "https://vendor.invalid/?token=<REDACTED>"},
  "result": true,
  "msg": "success"
}
```

Business/validation failure is intentionally HTTP 200:

```json
{"data": {}, "result": false, "msg": "Sanitized failure message"}
```

Missing/invalid `crm-pay-token` returns HTTP 401 with the same PSP envelope
shape and `result:false`.

The handler is idempotent by unique `order_no`: a retry reuses the existing
deposit intent but requests a new UI token for that same intent.

### 5.2 PSP payment callback

**[Vendor documented]**

```ts
interface BroctagonPaymentCallback {
  merchant_id: string;
  order_no: string;
  transaction_id?: string;
  amount: string;
  currency: string;
  time: number; // Unix milliseconds
  status: 0 | 1 | 2; // failed, success, processing
  user_id?: string;
  sign: string;
}
```

The expected success HTTP status is 204.

PSP signature:

1. Remove `sign`, null, undefined, and empty-string fields.
2. Sort remaining keys using normal ASCII key ordering.
3. Join as `key=value&key=value`.
4. Append the shared pay token directly.
5. SHA-1 hash as UTF-8.
6. Encode as uppercase hexadecimal.

**[Observed working]** HTTP 400 with
`type: "payment_status_not_pending"` is treated as idempotent success because
the CRM order is already terminal. Other errors are rethrown for Bull retry.

### 5.3 Broctagon Open API withdrawal decisions

**[Observed working]**

Approve body:

```json
{"id": "REQ-MOCK-001"}
```

Reject body:

```json
{"id": "REQ-MOCK-001", "comment": "Sanitized reason"}
```

Reject comments are truncated to 500 characters.

REST signature:

1. Sort all body keys.
2. Include every value (unlike the PSP signature, empties are not dropped).
3. Join as `key=value&key=value`.
4. Append the Open API key.
5. SHA-1 hash as UTF-8.
6. Encode as uppercase hexadecimal.

Headers are `key` and `signature`. Calls use a 20-second timeout and do not have
an internal HTTP retry loop; Bull retries the surrounding webhook job.

HTTP 400 with `type: "request_status_not_pending"` is treated as idempotent
approve success. Other approve errors and all reject errors are rethrown.

### 5.4 Broctagon withdrawal webhook

**[Observed working]**

`X-Crm-Signature` is HMAC-SHA256 of the exact raw JSON body using the configured
webhook secret, encoded as lowercase hexadecimal. Both bare hex and a
case-insensitive `sha256=` prefix are accepted. Comparison is constant-time.

Missing or invalid signatures return HTTP 401:

```json
{"received": false, "msg": "Missing signature"}
```

or:

```json
{"received": false, "msg": "Invalid signature"}
```

Only the configured withdrawal method is processed. Other methods are logged,
persisted as ignored, and acknowledged with HTTP 200.

Only a case-insensitive final `approved` status can submit an irreversible
Coinigo pay-out. Pending, rejected, cancelled, or missing statuses are
acknowledged without submission.

## 6. Transaction lifecycles

### 6.1 Deposit/pay-in

```text
Broctagon /pay/url
  -> local pending
  -> Coinigo Accepted/Processing
  -> local accepted (no CRM credit)
  -> Coinigo Completed/Success/Confirmed
  -> validate confirmed deposit
  -> local completed
  -> Broctagon callback status=1
  -> set idempotency marker after callback succeeds
```

**[Vendor documented]** Coinigo `Accepted` means detected but not finalized;
only `Completed` should trigger credit.

**[Implementation policy]**

- Completed aliases accepted by the parser: `completed`, `success`,
  `confirmed`.
- Failure aliases: `failed`, `expired`, `cancelled`, `rejected`.
- All other statuses are intermediate and stored locally as `accepted`.
- A completed deposit is not credited unless confirmed amount is positive.
- When present, customer, currency, network, and contract must match the local
  intent/configuration, case-insensitively.
- Missing optional validation fields are not currently treated as mismatches.
- Pending intents older than `DEPOSIT_PENDING_TIMEOUT_MINUTES` are failed in
  Broctagon and then marked locally `expired`. Accepted intents are preserved.

**[Vendor documented]** Coinigo supports FIFO, LIFO, and Restricted-ID tracker
mapping modes. Which mode is active is a Coinigo terminal configuration and is
not controlled by this code. Operational ownership must confirm the configured
mode with Coinigo.

### 6.2 Withdrawal/pay-out

```text
Broctagon approved webhook
  -> local received
  -> validate method, amount, and destination format
  -> Coinigo submit
  -> local submitted
  -> Coinigo New/Accepted/Broadcast/Processing
  -> forward-only local status
  -> Coinigo Completed -> Broctagon approve -> local completed
     OR
  -> Coinigo Failed -> Broctagon reject -> local failed
```

Mapping:

| Coinigo input | Local status | Terminal action |
|---|---|---|
| `new` | `submitted` | None |
| `accepted` | `accepted` | None |
| `broadcast`, `broadcasted` | `broadcast` | None |
| `processing`, `pending` | `processing` | None |
| `completed`, `success`, `confirmed` | `completed` | Approve Broctagon |
| `failed`, `rejected`, `cancelled`, `declined` | `failed` | Reject Broctagon |
| Unknown | unchanged | Log only |

Status updates are forward-only. A terminal local record ignores duplicate or
late webhooks.

## 7. Webhook durability and validation

### Coinigo

Expected HTTP body:

```json
{"dataEncrypted": "<REDACTED_BASE64_CIPHERTEXT>"}
```

1. Require non-empty string `dataEncrypted`; otherwise 400.
2. Decrypt with the merchant private key; failure returns 400.
3. When `WEBHOOK_VERIFY_DIGEST=true`, require and verify
   `X-Payload-Digest` with the direction-specific pay-in/pay-out webhook
   secret; failure returns 401.
4. Parse decrypted JSON; malformed JSON returns 400.
5. Persist the decrypted payload and enqueue it. Production webhook rows can
   contain sensitive transaction/customer data and must remain access-controlled;
   never export them into tickets or handoffs without redaction.
6. Return 200 only after persistence/enqueue succeeds; otherwise return 500 so
   the vendor can retry.

### Broctagon

1. Verify raw-body HMAC before routing.
2. Ignore unrelated withdrawal methods safely.
3. Persist and enqueue relevant webhooks.
4. Return 500 when persistence/enqueue fails.

### Queue behavior

Bull jobs use three attempts with exponential backoff starting at two seconds.
Completed jobs retain the latest 1,000 entries; failed jobs are retained.
Webhook logs move from `pending` to `processed` or `failed`, with error messages
truncated to 2,000 characters.

## 8. Idempotency and concurrency findings

### Deposits

- `order_no` and `payment_tracking_id` are unique.
- `payment_tracking_id` equals Broctagon `order_no`.
- The processor finds the intent by webhook tracking ID.
- `transactionHash` is the preferred idempotency key; `requestId` is fallback.
- The marker is written only after Broctagon acknowledges the success callback.
  If callback delivery fails, the job retries rather than silently losing CRM
  credit.
- A pre-existing marker skips all duplicate work.
- The stale-pending callback rechecks the row before expiring it, but external
  callback/database transitions cannot be fully atomic; monitor boundary-time
  deposits operationally.

### Withdrawals

- `broctagon_request_id` and generated `reference_number` are unique.
- Duplicate approval webhooks reuse the existing row.
- Anything beyond local `received` is not submitted again.
- Terminal pay-out handling calls Broctagon before committing the local
  terminal state, allowing a failed CRM call to be retried.
- Unknown Coinigo pay-out references are acknowledged without action; this
  prevents infinite retries for terminal-level/manual Coinigo transactions.
- Stuck `received` withdrawals are rechecked at Coinigo and automatically
  requeued at most twice. In-flight stale withdrawals are flagged for manual
  review rather than automatically finalized.

## 9. Debugging discoveries

These are **[Observed working]**, not vendor guarantees:

1. Coinigo sign-in required credentials under `{data: credentials}`. An
   unwrapped attempt produced a 400 indicating an empty body.
2. Coinigo UI-token calls work with `{data: request}` while digesting only the
   inner request.
3. Coinigo secured pay-out submission works with encrypted business JSON under
   `{data:{dataEncrypted}}`.
4. Digesting the wrapper rather than the bare business JSON caused request
   rejection.
5. Pay-out encryption had to match the hybrid RSA/AES sample; direct RSA cannot
   carry realistic payload sizes with RSA-2048.
6. Loopback/proxy `customerIp` caused a Coinigo 500, so server-side proxy
   metadata is omitted.
7. Coinigo uses PascalCase and camelCase across payloads/responses; tolerant
   field extraction is intentional.
8. Broctagon returns structured terminal-state errors
   (`payment_status_not_pending`, `request_status_not_pending`) that are safe to
   interpret idempotently.
9. Coinigo tracker-selection mode is external terminal configuration. Code can
   align tracker expiration, but cannot select FIFO/LIFO/Restricted-ID.

## 10. Sanitized fixtures and test coverage

Synthetic fixtures are in `tests/fixtures/vendor/`:

- `broctagon-pay-url-request.json`
- `broctagon-withdrawal-webhook.json`
- `coinigo-payin-accepted.json`
- `coinigo-payin-completed.json`
- `coinigo-payout-completed.json`

They contain explicit redaction markers and no usable destination, credential,
token, key, or PII. `tests/unit/fixtures/vendorFixtures.test.ts` verifies their
safe shape and exercises the production parsers.

Existing focused tests cover:

- HMAC and PSP signatures.
- RSA/AES encryption round trips and digest scope.
- Broctagon token and webhook verification.
- Pay URL validation and tracker expiration.
- Pay-in credit validation and callback idempotency.
- Withdrawal parsing, validation, duplicate suppression, and submission.
- Pay-out forward-only lifecycle and terminal actions.
- Stale pending-deposit reconciliation.

Run:

```bash
npm test -- --runInBand
npm run typecheck
npm run build
```

## 11. Operational handoff checklist

- Confirm Coinigo terminal tracker mode: FIFO, LIFO, or Restricted ID.
- Confirm `COINIGO_RETURN_URL` exactly matches terminal configuration.
- Keep all `.env` and PEM material outside version control with restrictive
  filesystem permissions.
- Verify PostgreSQL migrations and Redis connectivity before starting workers.
- Run `npm run health:production` using valid read-only operational access.
- Review failed webhook logs without copying unsanitized payloads.
- Perform a low-value end-to-end deposit and withdrawal test after any vendor
  configuration or cryptographic change.
- Never infer a terminal payment outcome from an initial API response; wait for
  the final webhook.

## 12. Requested evidence extension

This section records the evidence requested for Vendor Guardian. An explicit
`NOT VERIFIED` is intentional: it means the repository cannot prove the claim
and no production/vendor fact has been invented to fill the gap.

### 12.1 Exact deployed commit

**[Repository fact]**

```text
Local HEAD:  1fc26964f0d4d3fd52e41fe17fdbe97fba43e51d
origin/main: 1fc26964f0d4d3fd52e41fe17fdbe97fba43e51d
```

**Deployment status: NOT VERIFIED.** This checkout contains no running process,
release manifest, build metadata, health-response SHA, or deployment record
that proves production is running that commit. The SHA above is the current
repository candidate, not a claim about the deployed server.

Required evidence: obtain `git rev-parse HEAD` from the deployment checkout or
expose an immutable build SHA through release metadata/a protected diagnostic
endpoint.

### 12.2 Sanitized Coinigo response/error shapes

`tests/fixtures/vendor/coinigo-response-shapes.json` contains safe structural
examples for:

- sign-in success and HTTP 400 failure;
- encrypted pay-out submission response before decryption;
- pay-out submission response after decryption;
- pay-out status-query response;
- wallet-query response;
- HTTP 400, 401, 429, and 503 errors.

Every entry includes:

```json
{
  "_evidence": "synthetic-shape-not-production-capture"
}
```

**Capture status: NOT AVAILABLE.** No sanitized production captures for these
responses exist in this checkout. The fixture shapes are derived from tolerant
production parsers, vendor examples, and historical debugging notes. They are
useful for schema discussion and tests but must not be represented as captured
wire evidence.

Specific evidence:

| Shape | Evidence available |
|---|---|
| Sign-in success | Parser accepts token/accessToken/jwt at root or under data; vendor example exists; no retained production capture |
| Sign-in failure | Historical debugging observed HTTP 400 for an unwrapped/empty body; exact safe body was not retained |
| Pay-out submission, encrypted | Decoder supports root or nested `dataEncrypted`; no retained production capture |
| Pay-out submission, decrypted | Parser extracts `RequestId`/`requestId`/`id`; no retained production capture |
| Status query | Parser accepts status/request/hash naming variants; no retained production capture |
| Wallet query | Not implemented by this repository; fixture is vendor-shape-only |
| 400/401/429/5xx | Generic Axios/vendor-envelope shapes only; exact safe Coinigo bodies are not retained |

### 12.3 `referenceNumber` duplicate-payout guarantee

**[Vendor documented]** Coinigo documents `referenceNumber` as a pay-out field
and states that it validates the field before broadcast.

**Explicit idempotency guarantee: NOT FOUND.** The supplied Coinigo material
does not state that repeated submissions with the same `referenceNumber` are
deduplicated or rejected. Its idempotency guidance instead refers to
`RequestId` and/or `TransactionHash` for webhook processing.

Therefore this integration must not claim that `referenceNumber` prevents
duplicate pay-outs. Vendor confirmation is required in writing, including:

- deduplication scope (terminal, merchant, or global);
- retention window;
- response returned for an identical retry;
- behavior when the original request succeeded but its HTTP response was lost;
- behavior when the repeated payload differs in amount or destination.

### 12.4 Active tracker mode

**Active Coinigo terminal mode: NOT VERIFIED.**

The code cannot choose or discover FIFO, LIFO, or Restricted ID. No terminal
configuration response or written Coinigo confirmation exists in this
checkout. Ask Coinigo to identify the mode for the specific terminal and retain
their written response as deployment evidence.

### 12.5 Endpoint latency

**Aggregated latency measurements: NOT AVAILABLE.**

No metrics, access logs, tracing spans, or sanitized timing captures are
present in this checkout. The current logger does not record request duration.
It would be misleading to infer latency from timeout values or retry backoff.

Required collection, without payloads or identifiers:

| Endpoint label | Minimum aggregates |
|---|---|
| `coinigo.sign_in` | count, success/error count, p50/p95/p99, max |
| `coinigo.ui_token` | count, success/error count, p50/p95/p99, max |
| `coinigo.payout_submit` | count, status-class counts, p50/p95/p99, max |
| `coinigo.payout_status` | count, status-class counts, p50/p95/p99, max |
| `coinigo.wallet_query` | count, status-class counts, p50/p95/p99, max |

Record only endpoint labels, duration, status class, timeout flag, and attempt
number. Do not record URLs containing tokens, query ciphertext, payloads,
headers, identifiers, or response bodies.

### 12.6 Twenty-second timeout rationale

**[Repository history]** The 20-second Coinigo timeout was present in the
initial integration commit (`1369302`). No commit message, code
comment, vendor passage, latency report, or debugging record explains why that
number was selected.

**Conclusion:** treat 20 seconds as an implementation assumption/default. It is
not proven vendor-directed and cannot be described as empirically tuned from
the evidence in this repository.

### 12.7 Direct RSA versus hybrid RSA/AES by response

| Message class | Evidence |
|---|---|
| Sign-in response | Plain JSON; no RSA |
| UI-token response | Plain JSON; no RSA |
| Coinigo webhook | Historical implementation/debugging supports hybrid; current decoder also accepts direct RSA |
| Pay-out submission response | Decoder accepts direct RSA or hybrid, but no retained capture identifies the active format |
| Pay-out status response | Decoder accepts direct RSA or hybrid, but no retained capture identifies the active format |
| Wallet response | No implementation/capture in this repository |

**Per-endpoint confirmation: NOT AVAILABLE.** The decoder's successful
fallback is not logged, so historical operation cannot be aggregated by
encryption mode. Vendor confirmation or sanitized ciphertext-length/mode
telemetry is required. Do not log ciphertext itself.

### 12.8 Broctagon authentication version

**[Observed implementation]** Withdrawal approve/reject currently sends:

- `key: <Open API key>`;
- `signature: SHA1(sorted key=value body + API key)`, uppercase hex.

This matches Broctagon's published legacy **Authentication** page.

**[Vendor documented, current alternative]** Broctagon also publishes
**Authentication V2**, which signs the UTF-8 JSON body with HMAC-SHA256 and
uses a `sha256=`-prefixed signature.

**Tenant mode: NOT VERIFIED.** Working source/history suggests the tenant
accepted the legacy SHA-1 scheme during integration, but there is no
tenant-configuration export or recent sanitized request/response proving that
it remains active. Confirm with Broctagon before migrating or changing the
signature. The two schemes are not interchangeable.

References:

- [Broctagon legacy Authentication](https://open-api-docs.broctagon.com/api/authentication.html)
- [Broctagon Authentication V2](https://open-api-docs.broctagon.com/api/authentication-v2.html)

### 12.9 Known unresolved issues and incidents

1. **Critical ambiguity: lost pay-out submission response.** If Coinigo accepts
   a pay-out but the HTTP response is lost/times out, the local withdrawal
   remains `received`. Bull retries and submits the same pay-out again. Safety
   currently depends on an unconfirmed Coinigo deduplication behavior or later
   reconciliation timing.
2. **Tracker mode unknown.** Multiple pending deposit trackers can map
   differently under FIFO/LIFO/Restricted ID.
3. **No per-endpoint latency telemetry.** Timeout and capacity decisions are
   not evidence-based.
4. **Encryption mode is auto-detected but not observed.** Per-endpoint direct
   RSA versus hybrid use cannot be confirmed retrospectively.
5. **Broctagon auth version is unverified.** Code uses legacy SHA-1 while V2 is
   also published.
6. **Wallet API is absent.** There is no working wallet-query implementation or
   response capture in this repository.
7. **Production database access failed during diagnosis.** The configured
   database credential returned password authentication failure, preventing
   correlation of live deposit intents and webhook logs.
8. **Deposit expiration boundary race.** A Coinigo webhook can advance near the
   same time as CRM expiration; the row is rechecked, but an external callback
   and database transition cannot be fully atomic.
9. **Historical tracker mismatch incident.** A deposit was observed against a
   previous CRM order while the latest order remained pending. Coinigo's active
   tracker mode was not available to confirm the selection cause.

### 12.10 Lost-response pay-out test

`tests/unit/processors/withdrawalProcessor.test.ts` includes a mocked test for
the ambiguous outcome:

```text
Coinigo accepts request internally
  -> client receives timeout/no response
  -> local status remains received
  -> Bull invokes processor again
  -> submitPayout is called again with the same referenceNumber
```

The test intentionally documents current unsafe behavior; it is not proof that
Coinigo creates a duplicate. Resolution requires either an explicit
`referenceNumber` idempotency guarantee or a design that queries by reference
before any ambiguous retry.
