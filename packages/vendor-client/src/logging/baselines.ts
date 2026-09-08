import type { Queryable } from './call-log.js';

export class LatencyBaselineCache {
  private readonly values = new Map<string, number>();

  public constructor(private readonly database: Queryable) {}

  public getP95(vendor: string, endpoint: string): number | undefined {
    return this.values.get(`${vendor}:${endpoint}`);
  }

  public async refresh(since: Date): Promise<void> {
    const result = await this.database.query(
      `select vendor, endpoint,
              percentile_cont(0.95) within group (order by latency_ms)::float as p95
         from vendor_calls
        where created_at >= $1 and latency_ms is not null
        group by vendor, endpoint`,
      [since],
    );
    const next = new Map<string, number>();
    for (const row of result.rows as Array<{ vendor: string; endpoint: string; p95: number | null }>) {
      if (row.p95 !== null && Number.isFinite(row.p95)) next.set(`${row.vendor}:${row.endpoint}`, row.p95);
    }
    this.values.clear();
    for (const [key, value] of next) this.values.set(key, value);
  }
}
