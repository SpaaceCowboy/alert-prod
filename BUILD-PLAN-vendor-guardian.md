# Vendor Guardian — Technical Build Plan & Claude Code Prompts

A failed-action detection, vendor-resilience, and security-monitoring system for Roco.
Watches every interaction with **Broctagon AXIS**, **Coinigo**, and **B2BROKER**, verifies
that critical actions actually completed, protects payment calls from double-execution, and
alerts on operational and security anomalies before a client does.

This document is written to be executed by **Claude Code**, one phase at a time. Each phase has
a spec (what and why) followed by a copy-pasteable prompt. Do not skip ahead — later phases
assume the schema and conventions from earlier ones.

---

## 0. Architecture in one screen

- **Shape:** a shared TypeScript library (`@roco/vendor-client`) imported in-process by existing
  services — **not** a gateway service. Plus three small companion apps: a BullMQ worker, a
  webhook receiver, and a Next.js dashboard.
- **Why a library:** a gateway would be a new single point of failure in a project whose purpose
  is removing them, and another thing to deploy and babysit. The library gives ~90% of the value
  with near-zero added ops surface; centralization comes from a shared Postgres log + Redis state.
- **Core behaviors:**
  - Every outbound vendor call is intercepted, timed, classified, and logged.
  - Retries are **policy-gated**. Payment writes default to *never retry*.
  - A timeout on a money call is an **UNKNOWN**, not a failure — it triggers reconciliation, not a retry.
  - Circuit breakers fail fast per-vendor (bulkheads) so one vendor can't drown the others.
  - Every critical business action registers an **expectation** with a deadline; a job verifies the
    outcome actually happened.
  - Alerts fire on **state transitions only** (anti-fatigue), ranked by severity.
  - Known failures carry their **fix** in the alert, via deterministic runbook lookup (no AI).

## 1. Stack

Everything here is already in Roco's stack except Opossum.

| Concern | Choice | Notes |
|---|---|---|
| Language | Node.js + TypeScript | matches existing services |
| Circuit breakers | **Opossum** | only new dependency; don't hand-roll |
| Queues / jobs / schedules | **BullMQ** | verification, health checks, expectation sweeps |
| Persistence | **PostgreSQL** | call log, expectations, incidents |
| Time-series scale (later) | **TimescaleDB** | Postgres *extension*, not a new DB — only if volume demands |
| Shared state | **Redis** | breaker health gate + BullMQ backend |
| Alerting | **Telegram bot** | existing |
| Dashboard | **Next.js** | behind **Cloudflare Access**, never public |
| Runbooks (Phase 3) | plain Postgres | deterministic lookup — no AI, no new dependency |

## 2. Repo layout (pnpm monorepo)

```
vendor-guardian/
  packages/
    vendor-client/          # the library services import
      src/
        config/
          vendors.ts        # base URLs, timeouts, per-vendor knobs (from env)
          retry-policy.ts   # endpoint -> SAFE_TO_RETRY | NEVER_RETRY | RETRY_WITH_KEY
        core/
          interceptor.ts    # axios interceptor: timing + logging + classification
          classifier.ts     # (status, error, latency, baseline) -> tag
          breaker.ts        # opossum wrapper + Redis health gate
          retry.ts          # backoff + jitter, policy-gated
          idempotency.ts    # key handling for payment writes
        logging/
          call-log.ts       # async, non-blocking write to Postgres
        vendors/
          axis.ts           # typed methods for Broctagon
          coinigo.ts
          b2broker.ts
        types.ts
        index.ts
  apps/
    worker/                 # BullMQ processors
      src/jobs/
        verify-payment.ts
        check-expectations.ts
        synthetic-health.ts
        state-diff.ts       # security: poll AXIS, diff sensitive fields
      src/alerting/
        telegram.ts
        severity.ts
        dedupe.ts
      src/runbooks/
        match.ts          # deterministic specificity-scored lookup (Phase 3)
    webhooks/               # receives AXIS webhooks, enqueues fast (<10s)
      src/
    dashboard/              # Next.js, Cloudflare Access
  seeds/                    # vendor error-code runbook entries (Phase 3)
  migrations/               # SQL, run in order
  docker-compose.yml        # local postgres + redis
  .env.example
```

## 3. Non-negotiable rules (put these in every Claude Code prompt)

1. **Never retry a payment write without an idempotency key.** Default policy for any Coinigo or
   B2BROKER money-moving endpoint is `NEVER_RETRY`. Promotion to `RETRY_WITH_KEY` is explicit and
   per-endpoint, only where the vendor honors idempotency keys.
2. **A timeout is not a failure.** Classify as `UNKNOWN`, enqueue a verification job that asks the
   vendor for the real transaction status, then decide. Never assume success or failure.
3. **Breaker/health state is shared in Redis**, never in process memory — PM2 workers must agree on
   whether a vendor is down.
4. **Alerts fire on state transitions only** (breaker open, breaker recover, error-rate crossing,
   stalled expectation). Never alert per failed request. Dedupe + severity tiers + rate limits.
5. **Log everything, alert on problems.** Successes are needed for the baseline; they never alert.
6. **PII discipline.** The call log and dashboard carry client IDs and transaction amounts. Never
   log raw wallet addresses, full payloads, credentials, or tokens. Hash wallet addresses for the
   history check. Dashboard is behind Cloudflare Access, never a public URL.

## 4. Classification tags (the vocabulary the whole system speaks)

| Tag | Meaning | Alerts? |
|---|---|---|
| `OK` | normal | no (baseline only) |
| `HARD_FAIL` | 5xx, connection reset, DNS failure | yes |
| `SOFT_FAIL` | 2xx but empty/garbage/invalid body | yes |
| `SLOW` | latency beyond p95 baseline | yes (before breaker trips) |
| `AUTH` | 401/403, expired token, IP-whitelist reject | yes (distinct from "down") |
| `RATE_LIMIT` | 429 | yes |
| `UNKNOWN` | timeout on a call whose outcome is indeterminate | **highest** |

---

# PHASE 0 — Measurement (≈2 days)

**Goal:** learn the truth before building anything. Wrap every outbound vendor call in a logging
interceptor and record it. Change no behavior. Run for a week to get real per-vendor, per-endpoint
baselines. This is the decision gate for the rest of the project.

**Definition of done:**
- `@roco/vendor-client` exists and can wrap axios calls to all three vendors.
- Every call writes a row to `vendor_calls` asynchronously (logging must never block or break the
  real call — swallow logging errors).
- A simple query produces: call volume, error rate, and latency p50/p95/p99 per vendor per endpoint.
- No retries, no breakers, no alerts yet. Just observation.

**Schema (migrations/0001_vendor_calls.sql):**
```sql
create table vendor_calls (
  id             bigint generated always as identity primary key,
  vendor         text        not null,          -- 'axis' | 'coinigo' | 'b2broker'
  endpoint       text        not null,          -- logical name, e.g. 'withdrawal.create'
  method         text        not null,
  http_status    int,                           -- null on timeout
  latency_ms     int,
  classification text,                          -- Phase 0: OK/HARD_FAIL/AUTH/RATE_LIMIT/UNKNOWN
  error_class    text,                           -- ETIMEDOUT, ECONNRESET, ...
  idempotency_key_present boolean not null default false,
  request_id     text,                           -- correlation id
  actor_id       text,                           -- nullable now; security layer fills later
  action_type    text,                           -- nullable now
  created_at     timestamptz not null default now()
);
create index on vendor_calls (vendor, created_at);
create index on vendor_calls (endpoint, created_at);
create index on vendor_calls (classification, created_at);
```
Note: `SLOW` is intentionally absent in Phase 0 — it needs a baseline that doesn't exist yet. It's
computed in Phase 1 once we have latency history.

### Claude Code prompt — Phase 0
```
Set up a pnpm monorepo called `vendor-guardian` and build ONLY Phase 0: passive measurement.

Stack: Node.js + TypeScript, PostgreSQL (pg), axios. Add a docker-compose.yml with postgres and
redis for local dev, and a .env.example.

Create packages/vendor-client with:
- config/vendors.ts: base URLs and default timeouts for three vendors ('axis','coinigo','b2broker'),
  all read from env. Do not hardcode secrets.
- core/interceptor.ts: an axios request/response interceptor that records start time, and on
  completion or error computes { vendor, endpoint (a logical name passed in per call, NOT the raw
  URL), method, http_status, latency_ms, error_class, classification }. Classification for Phase 0:
  2xx -> OK; 401/403 -> AUTH; 429 -> RATE_LIMIT; 5xx or connection error -> HARD_FAIL; timeout ->
  UNKNOWN. Attach a request_id (uuid) for correlation.
- logging/call-log.ts: writes each record to the vendor_calls table asynchronously. Logging MUST
  NOT block the real call and MUST swallow its own errors (a logging failure can never break a
  vendor call).
- vendors/axis.ts, coinigo.ts, b2broker.ts: thin typed wrappers exposing a few real methods each,
  every method passing its logical endpoint name to the interceptor.

Add migrations/0001_vendor_calls.sql exactly as specified in the build plan (I'll paste the schema).

CRITICAL for this phase:
- Change NO behavior. No retries, no circuit breakers, no alerts. Observation only.
- Include the nullable actor_id and action_type columns now so later phases don't need a migration.
- Never log raw wallet addresses, full request/response bodies, tokens, or credentials.

Finally, write a small script scripts/report.ts that queries vendor_calls and prints, per vendor
per endpoint: call count, error rate, and latency p50/p95/p99 over a given time window.

Give me clear instructions to run migrations and wire one existing axios call through the wrapper.
```

---

# PHASE 1 — Resilience core + expectation tracking + payment safety (≈1.5 weeks)

**Goal:** turn observation into protection. Add policy-gated retries, per-vendor circuit breakers
with shared Redis state, the reconcile-on-timeout flow for payments, and — the heart of the system
— expectation tracking that detects silent failures.

**Definition of done:**
- Retry policy registry enforced; payment writes never blind-retry.
- Opossum breakers per vendor; a Redis health gate all workers consult.
- `UNKNOWN` payment calls enqueue a verification job that queries real status and resolves.
- Critical actions register expectations; a sweep job flags stalled ones.
- `SLOW` classification now active, using p95 from Phase 0 data.

**Retry policy (packages/vendor-client/src/config/retry-policy.ts):**
```ts
export type RetryPolicy = 'SAFE_TO_RETRY' | 'NEVER_RETRY' | 'RETRY_WITH_KEY';
// Default for anything not listed is NEVER_RETRY.
export const RETRY_POLICY: Record<string, RetryPolicy> = {
  'axis.client.get':        'SAFE_TO_RETRY',
  'axis.balance.get':       'SAFE_TO_RETRY',
  'axis.kyc.status.get':    'SAFE_TO_RETRY',
  'coinigo.withdrawal.create': 'NEVER_RETRY',   // promote to RETRY_WITH_KEY only if idempotency confirmed
  'b2broker.withdrawal.create':'NEVER_RETRY',
  'coinigo.deposit.create':    'NEVER_RETRY',
  'b2broker.deposit.create':   'NEVER_RETRY',
};
```

**Expectations schema (migrations/0002_expectations.sql):**
```sql
create table action_expectations (
  id               bigint generated always as identity primary key,
  action_type      text        not null,   -- 'deposit','withdrawal','kyc_submission','welcome_email',...
  subject_ref      text        not null,   -- client id or transaction id
  amount_minor     bigint,                 -- optional, for severity ranking
  started_at       timestamptz not null default now(),
  deadline_at      timestamptz not null,
  expected_outcome text        not null,   -- machine-checkable key describing "done"
  status           text        not null default 'pending', -- pending|fulfilled|failed|unknown
  fulfilled_at     timestamptz,
  vendor_call_id   bigint references vendor_calls(id),
  metadata         jsonb,
  created_at       timestamptz not null default now()
);
create index on action_expectations (status, deadline_at);
create index on action_expectations (action_type, status);
```

**Breaker + Redis health gate:** Opossum keeps breaker state per-process. To make PM2 workers agree,
on every breaker open/close publish a health flag to Redis (`vendor:health:<vendor>` = up|down with
a short TTL), and have callers consult it before dialing. Per-process opossum handles the mechanics;
the Redis gate provides the shared truth.

**Reconcile-on-timeout:** when a payment call classifies `UNKNOWN`, do NOT retry. Enqueue
`verify-payment` with the request_id and vendor reference. The job polls the vendor's
transaction-status endpoint (with backoff) until it can assert succeeded/failed, then records the
resolution and closes or escalates.

### Claude Code prompt — Phase 1
```
Extend vendor-guardian with Phase 1: resilience core, payment safety, and expectation tracking.
Keep everything from Phase 0 working.

1) Retry policy registry (config/retry-policy.ts) exactly as in the build plan. Default for any
   unlisted endpoint is NEVER_RETRY. In core/retry.ts implement exponential backoff WITH jitter,
   applied ONLY to SAFE_TO_RETRY and RETRY_WITH_KEY endpoints, and ONLY on retryable errors
   (timeouts, connection resets, 5xx). Never retry 4xx. For RETRY_WITH_KEY, require an idempotency
   key to be present or refuse to retry.

2) Circuit breakers (core/breaker.ts) using Opossum, one per vendor (bulkheads: independent breaker
   and no shared failure). On breaker open/half-open/close, write a shared health flag to Redis
   (key vendor:health:<vendor>, short TTL) and have the call path consult it. Do NOT keep breaker
   truth only in process memory. Thresholds should be configurable and seeded from Phase 0 p95/error
   rates.

3) Reconcile-on-timeout: when a call to a payment vendor classifies UNKNOWN (timeout), DO NOT retry.
   Add a BullMQ queue and processor apps/worker/src/jobs/verify-payment.ts that takes the request_id
   and vendor reference, polls the vendor's transaction-status endpoint with backoff, and resolves
   the outcome to succeeded or failed, recording it. Anything unresolved past N minutes is escalated
   (mark for alert in Phase 2).

4) Expectation tracking:
   - Add migrations/0002_expectations.sql (I'll paste it).
   - Provide an API: expect({ action_type, subject_ref, amount_minor?, deadline, expected_outcome, metadata })
     that inserts a pending row, and fulfill(subject_ref, action_type) that marks it fulfilled.
   - Wire the obvious producers: on deposit initiated -> expect balance credited within a configurable
     window; on withdrawal approved -> expect payout within a window; on kyc submitted -> expect a
     decision within 48h; on welcome/reset email dispatched -> expect delivery confirmation.
   - Add apps/worker/src/jobs/check-expectations.ts as a BullMQ repeating job that finds pending
     expectations past deadline_at and marks them failed (these are the silent failures).

5) Turn on SLOW classification in core/classifier.ts using p95 baselines computed from vendor_calls.

Constraints (repeat, enforce): payment writes never blind-retry; a timeout is UNKNOWN not failure;
breaker state shared via Redis; no PII (hash wallet addresses, never log full bodies/tokens).
```

---

# PHASE 2 — Visibility: dashboard + alerting + synthetic checks (≈1 week)

**Goal:** make failures reach a human fast, without noise. Telegram alerts on state transitions,
a Next.js health dashboard behind Cloudflare Access, and synthetic health pings so you learn a
vendor is down at 3am without a client telling you.

**Definition of done:**
- `incidents` table records open/resolved incidents with a signature for dedupe.
- Telegram alerts fire on transitions only, ranked by severity; recovery also alerts.
- Synthetic health job pings a cheap read-only endpoint per vendor every minute.
- Dashboard shows per-vendor breaker state, latency percentiles, error rates, stalled expectations,
  and unresolved UNKNOWN transactions — behind Cloudflare Access, role-aware.

**Incidents schema (migrations/0003_incidents.sql):**
```sql
create table incidents (
  id              bigint generated always as identity primary key,
  vendor          text,
  kind            text        not null,  -- breaker_open|error_spike|slow|stalled_expectation|unknown_txn|security_*
  severity        text        not null,  -- critical|high|medium
  signature       text        not null,  -- for dedupe and grouping
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz,
  context         jsonb,
  resolution_note text,                  -- filled by human on close (institutional record)
  resolution_worked boolean
);
create unique index on incidents (signature) where resolved_at is null;
create index on incidents (vendor, opened_at);
```

**Severity model (worker/src/alerting/severity.ts):** rank by three inputs —
operation criticality (reset/credentials email + payout = critical), transaction amount (above a
configurable threshold = escalate immediately), and repetition (N similar failures in a window =
one root-cause incident, not N alerts).

### Claude Code prompt — Phase 2
```
Add Phase 2 to vendor-guardian: alerting, synthetic health checks, and a dashboard. Keep Phases 0-1.

1) Incidents: add migrations/0003_incidents.sql (I'll paste it). Create an incident manager that
   opens an incident on a state transition, dedupes via the partial unique index on signature while
   unresolved, and resolves it when the condition clears.

2) Telegram alerting (apps/worker/src/alerting/):
   - telegram.ts: send via the existing bot (token from env).
   - severity.ts: rank incidents by (a) operation criticality, (b) transaction amount vs a
     configurable threshold, (c) repetition — collapse N similar failures in a time window into ONE
     root-cause incident.
   - dedupe.ts + rate limiting: alerts fire ONLY on state transitions (open and recover), never per
     failed request. Include a clear recovery message when a breaker closes or a spike clears.
   - Alert triggers: breaker open/recover, error-rate crossing, sustained SLOW, stalled expectation
     past deadline, UNKNOWN payment unresolved past N minutes.

3) Synthetic health: apps/worker/src/jobs/synthetic-health.ts as a BullMQ repeating job (every ~60s)
   that pings one cheap read-only endpoint per vendor and records the result, so outages surface
   proactively.

4) Dashboard (apps/dashboard, Next.js):
   - Views: per-vendor breaker state, latency p50/p95/p99, error rate, list of stalled expectations,
     list of unresolved UNKNOWN transactions.
   - Role-aware: a support view (actionable failed operations only) and an infra view (breaker/latency
     internals).
   - Assume it sits behind Cloudflare Access — do NOT build your own public login. Document the
     Access setup in the README.
   - It carries client IDs and amounts: no wallet addresses or full payloads in the UI; add a note
     that viewing is access-controlled.

Constraint: no daily "all good" pings. Silence is success. Only problems and recoveries alert.
```

---

# SECURITY LAYER — rule pack on the same foundation (fits after Phase 2)

**Goal:** the five prioritized security alerts, as rules over data the system already collects plus
two new inputs (login events from our own stack, and state-diff polling for AXIS profile fields).
No separate system.

**The five alerts:**
1. **New/unfamiliar withdrawal wallet address** — keep a per-client history of address *hashes*; flag
   first-time addresses on withdrawal. Strongest takeover signal.
2. **Unusual transaction pattern** — amount / timing / velocity / sudden behavior change.
3. **Login from a new device** — from our own login flow (device fingerprint).
4. **Multi-account / bonus abuse** — device fingerprint + shared payment instrument + IP clustering.
5. **Profile change (email / phone / wallet)** — via state-diff polling, since AXIS pushes no webhook
   for these. First link in the takeover chain.

**Inputs:** AXIS withdrawal/KYC webhooks (via the webhook receiver), our own login/session events,
and periodic AXIS REST snapshots diffed for sensitive fields.

**Schema (migrations/0004_security.sql):**
```sql
create table client_wallet_history (
  client_ref   text not null,
  address_hash text not null,     -- hash, never the raw address
  first_seen   timestamptz not null default now(),
  primary key (client_ref, address_hash)
);
create table client_field_snapshots (
  client_ref  text not null,
  email_hash  text,
  phone_hash  text,
  wallet_hash text,
  snapshot_at timestamptz not null default now(),
  primary key (client_ref)        -- latest snapshot; diff on update
);
create table login_events (
  id           bigint generated always as identity primary key,
  client_ref   text not null,
  device_fp    text,
  ip           inet,
  country      text,
  created_at   timestamptz not null default now()
);
create index on login_events (client_ref, created_at);
```

### Claude Code prompt — Security layer
```
Add a security rule pack to vendor-guardian, reusing the Phase 0-2 infrastructure (call log,
incidents, Telegram alerting, severity model). Add migrations/0004_security.sql (I'll paste it).

Build a webhook receiver app (apps/webhooks) that verifies signatures, responds within 10 seconds,
and enqueues payloads to BullMQ for async processing (never process inline).

Implement five detection rules, each opening a security incident (kind = security_*) via the
existing incident manager so they flow through the same dedupe + Telegram path:

1) new_wallet_address: on a withdrawal event, hash the destination address and check
   client_wallet_history for that client. If unseen, alert (critical) and then record it.
2) unusual_transaction: flag amount/timing/velocity outliers and sudden deviations from a client's
   own history.
3) new_device_login: consume login_events from our own login flow; alert on a device fingerprint
   not seen before for that client.
4) multi_account_abuse: cluster by shared device fingerprint and shared payment instrument across
   clients; flag likely duplicates / bonus abuse.
5) profile_change: apps/worker/src/jobs/state-diff.ts polls AXIS client records on a schedule, hashes
   email/phone/wallet, compares to client_field_snapshots, and alerts on changes to these sensitive
   fields (critical). Update the snapshot after alerting.

PII rules: store only hashes of addresses, emails, phones. Never store or log raw values. These
rules must not depend on staff/actor identity (AXIS webhooks don't carry it) — they are event- and
client-behavior-based only.
```

---

# PHASE 3 — Runbooks: known fixes attached to alerts (≈3–4 days, after Phase 2)

**Goal:** stop re-investigating the same problem from scratch, and let support handle recurring issues
without escalating. Deterministic lookup — **no AI, no embeddings, no model calls**. Vendor failures
are repetitive and structured; the same handful of error codes recur, so matching is a keyed lookup,
not a language problem.

**How it works:**
1. Every incident already carries a `signature`. Decompose it into matchable parts:
   `vendor + kind + error_class + http_status + endpoint`.
2. A `runbooks` table stores known fixes keyed on those parts, with **nullable fields acting as
   wildcards** (a row with `endpoint = null` matches any endpoint for that vendor + error class).
3. On incident open, look up the best match by **specificity order**: exact → partial
   (vendor + error_class) → vendor-generic → none. Attach the winner to the Telegram alert.
4. If no runbook matched, prompt the human on incident close: *"create a runbook for this signature?"*
   That is the learning loop — explicit, human-written, auditable.
5. `worked` / `didn't work` feedback ranks entries; repeatedly-failing entries get demoted and flagged.

**Two seed sources:**
- **Vendor error-code tables** transcribed once from Broctagon / Coinigo / B2BROKER documentation.
  Static, finite, and high-value — covers a lot before a single incident has been resolved.
- **Our own resolutions**, accumulated from `incidents.resolution_note`.

**`who_can_do_it` is the field that delivers the business goal.** Tagging a runbook `support` means
the alert reaches support with steps they can execute themselves, without escalating to engineering.

**Definition of done:**
- `runbooks` table exists, seeded with vendor error codes.
- Incidents with a matching runbook include the fix, prior occurrence count, and who can action it.
- Incidents with no match say so plainly — never guess.
- Closing an unmatched incident prompts for a new runbook entry.
- Feedback counters update on worked / didn't-work.

**Schema (migrations/0005_runbooks.sql):**
```sql
create table runbooks (
  id             bigint generated always as identity primary key,
  vendor         text,                    -- null = any vendor
  kind           text,                    -- null = any incident kind
  error_class    text,                    -- null = any (e.g. 'AUTH', 'ETIMEDOUT')
  http_status    int,                     -- null = any
  endpoint       text,                    -- null = any endpoint
  title          text        not null,
  cause          text        not null,    -- plain-language explanation
  steps          text        not null,    -- ordered, executable steps
  who_can_do_it  text        not null default 'technical',  -- 'support' | 'technical'
  typical_fix_minutes int,
  source         text        not null default 'internal',   -- 'internal' | 'vendor_docs'
  times_matched  int         not null default 0,
  times_worked   int         not null default 0,
  times_failed   int         not null default 0,
  active         boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on runbooks (vendor, error_class, http_status);

-- link an incident to the runbook that was suggested, and whether it helped
alter table incidents add column suggested_runbook_id bigint references runbooks(id);
```

**Specificity scoring:** score each candidate by counting non-null matched fields (endpoint 8,
http_status 4, error_class 2, kind 1, vendor 1); reject any candidate where a non-null field
*disagrees* with the incident. Highest score wins; tie-break on `times_worked - times_failed`, then
most recently updated.

### Claude Code prompt — Phase 3
```
Add Phase 3 to vendor-guardian: a deterministic runbook system that attaches known fixes to alerts.
NO AI, NO embeddings, NO LLM calls — this is keyed lookup only. Keep Phases 0-2 and the security
layer working.

1) Add migrations/0005_runbooks.sql (I'll paste it). Note the nullable columns act as wildcards, and
   the alter table adding suggested_runbook_id to incidents.

2) Matching (packages/vendor-client or apps/worker, your call — keep it importable by the worker):
   Implement findRunbook(incident) that:
   - selects candidate runbooks where every NON-NULL runbook field equals the incident's
     corresponding value (null in the runbook = wildcard, always matches),
   - scores each candidate by specificity: endpoint 8, http_status 4, error_class 2, kind 1, vendor 1,
   - rejects any candidate with a conflicting non-null field,
   - returns the highest score; tie-break on (times_worked - times_failed) desc, then updated_at desc,
   - returns null if nothing matches. Never guess or approximate.

3) Alert integration: when an incident opens, call findRunbook. If matched, include in the Telegram
   message: the runbook title, plain-language cause, the ordered steps, typical_fix_minutes, how many
   times this signature has occurred before, and a clear "who can do this: support / technical" line.
   Increment times_matched and set incidents.suggested_runbook_id. If NOT matched, say plainly that
   there is no known fix and this needs investigation — do not fabricate a suggestion.

4) Feedback: add worked / didn't-work actions on the alert (Telegram inline buttons or a dashboard
   control). Increment times_worked or times_failed on the runbook. Auto-flag (do not auto-delete)
   any runbook whose times_failed exceeds times_worked by a configurable margin.

5) Capture loop: when a human closes an incident that had NO matching runbook, prompt them (dashboard
   form is fine) to create a runbook entry, pre-filled with the incident's vendor / kind / error_class
   / http_status / endpoint and their resolution_note as the starting steps text.

6) Seeding: add a seeds/ directory and a loader script that imports vendor error-code entries from a
   simple YAML or JSON file (source = 'vendor_docs'). Include a small starter file with a few example
   entries per vendor and clear instructions for me to fill in the rest from vendor documentation.

7) Dashboard: a runbooks CRUD view (list, create, edit, deactivate) with the match stats visible, so
   support and I can maintain entries without touching SQL.

Constraint: this layer only SUGGESTS. It never executes a fix and never takes any automated action on
payment vendors. A human always performs the steps.
```

---

# How to drive Claude Code

- Run phases **in order**, one Claude Code session per phase. Verify each phase's "definition of
  done" before moving on.
- Paste the exact schema blocks from this document when the prompt says "I'll paste it" — don't let
  the model invent columns, especially the nullable `actor_id`/`action_type` in Phase 0.
- After Phase 0, **actually run it for a week** before Phase 1. The baselines it produces are the
  inputs to breaker thresholds and SLOW detection. Skipping the wait means tuning on guesses.
- Keep the "Non-negotiable rules" (section 3) in front of the model in every session — they are the
  rules most likely to be silently violated under time pressure, and the payment ones are the ones
  that cause real damage if broken.
- Always write a `resolution_note` when you close an incident. Phase 3 pre-fills new runbook entries
  from it, so a good note today becomes an automatic suggestion tomorrow.

# Open items to resolve before or during the build

- **Do AXIS client emails send through Broctagon or our own stack?** Decides whether email delivery
  is observable at all (Phase 1 email expectations, security profile-change context).
- **Does Coinigo/B2BROKER support idempotency keys on withdrawals?** If yes, those endpoints move
  from `NEVER_RETRY` to `RETRY_WITH_KEY`.
- **Does AXIS expose an admin audit log (API or export)?** Deciding factor for any future
  actor-level (staff/insider) security monitoring — out of scope for the five rules above.
- **Is multi-step withdrawal approval enabled in AXIS today?** A config-level control that
  complements this system; verify independently.
