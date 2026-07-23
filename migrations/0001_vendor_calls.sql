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
