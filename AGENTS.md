# vendor-guardian

Failed-action detection, vendor resilience, and security alerting for three external vendors:
**Broctagon AXIS** (CRM), **Coinigo** (crypto payments), **B2BROKER** (payments).

## Before implementing anything

Read `BUILD-PLAN.md`. It contains the full phase-by-phase spec, exact SQL schemas, and the
definition of done for each phase. **Use the schemas in that file verbatim — do not invent or
rename columns.**

Implement **one phase per session**. Do not start the next phase unless explicitly asked.
Phases: 0 (measurement) → 1 (resilience + expectations) → 2 (dashboard + alerting) →
Security rule pack → 3 (runbooks).

## Non-negotiable rules

These apply to every change in this repository.

1. **Never retry a payment write without an idempotency key.** Default policy for any Coinigo or
   B2BROKER money-moving endpoint is `NEVER_RETRY`. Promotion to `RETRY_WITH_KEY` is explicit,
   per-endpoint, and only where the vendor honours idempotency keys.
2. **A timeout is not a failure.** Classify it as `UNKNOWN`, enqueue a verification job that asks
   the vendor for the real transaction status, then decide. Never assume success or failure, and
   never retry to "find out".
3. **Breaker/health state lives in Redis**, never in process memory. PM2 workers must agree on
   whether a vendor is down.
4. **Alerts fire on state transitions only** (breaker open, breaker recover, error-rate crossing,
   stalled expectation). Never alert per failed request. Always dedupe, tier by severity, rate limit.
5. **Log everything, alert on problems.** Successes are needed for the baseline; they never alert.
   No daily "all good" digest.
6. **PII discipline.** Never log or store raw wallet addresses, emails, phone numbers, full
   request/response bodies, tokens, or credentials. Hash anything used for history comparison.
   The dashboard sits behind Cloudflare Access — never build a public login.
7. **Suggestion, never automation.** The runbook layer suggests fixes; a human executes them.
   Nothing in this system automatically remediates a payment vendor.

## Stack

Node.js + TypeScript. Opossum (circuit breakers — do not hand-roll). BullMQ (jobs, retries,
schedules). PostgreSQL (call log, expectations, incidents, runbooks). Redis (shared breaker health
+ BullMQ backend). Telegram bot (alerts). Next.js (dashboard).

Opossum is the only new dependency. **Ask before adding any other package.** Prefer extending
Postgres (e.g. TimescaleDB) over introducing a new datastore.

## Conventions

- pnpm monorepo; see the repo layout in `BUILD-PLAN.md`.
- Vendor calls pass a **logical endpoint name** (e.g. `coinigo.withdrawal.create`), never a raw URL,
  so the call log groups correctly.
- Logging must never block or break a real vendor call — swallow logging errors.
- All credentials and base URLs come from env. Nothing hardcoded.
- Migrations are numbered SQL files in `migrations/`, applied in order.

## Testing

You cannot call live vendors. Write mocked tests for the interceptor, classifier, retry policy,
breaker behaviour, and runbook matching. Treat the first run against a real endpoint as manual
verification, and say so rather than claiming it is tested.

## Review habits

Lead with risks. Flag anywhere you had to guess at a vendor's real API shape, auth mechanism, or
response format — those are the places most likely to be wrong.
