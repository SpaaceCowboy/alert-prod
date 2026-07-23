import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const input = process.argv[2] ?? '24h';
const match = /^(\d+)([hd])$/.exec(input);
const from = match
  ? new Date(Date.now() - Number(match[1]) * (match[2] === 'd' ? 86_400_000 : 3_600_000))
  : new Date(input);
if (Number.isNaN(from.getTime())) throw new Error('Window must be an ISO timestamp or a duration such as 24h or 7d');

const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await pool.query(
    `select
       vendor,
       endpoint,
       count(*)::int as call_count,
       round(100.0 * count(*) filter (where classification is distinct from 'OK') / nullif(count(*), 0), 2)::float as error_rate_pct,
       percentile_cont(0.50) within group (order by latency_ms) filter (where latency_ms is not null)::float as latency_p50_ms,
       percentile_cont(0.95) within group (order by latency_ms) filter (where latency_ms is not null)::float as latency_p95_ms,
       percentile_cont(0.99) within group (order by latency_ms) filter (where latency_ms is not null)::float as latency_p99_ms
     from vendor_calls
     where created_at >= $1
     group by vendor, endpoint
     order by vendor, endpoint`,
    [from],
  );
  console.log(`Vendor calls since ${from.toISOString()}`);
  console.table(result.rows);
} finally {
  await pool.end();
}
