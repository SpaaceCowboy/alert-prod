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
