import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Queryable } from '@roco/vendor-client';

export const CHECK_EXPECTATIONS_QUEUE = 'check-expectations';

export interface FailedExpectation {
  id: string;
  action_type: string;
  subject_ref: string;
  amount_minor: string | null;
  deadline_at: Date;
}

export const failOverdueExpectations = async (
  database: Queryable,
  now: Date = new Date(),
): Promise<FailedExpectation[]> => {
  const result = await database.query(
    `update action_expectations
        set status = 'failed'
      where status = 'pending' and deadline_at < $1
      returning id, action_type, subject_ref, amount_minor, deadline_at`,
    [now],
  );
  return result.rows as FailedExpectation[];
};

export const processCheckExpectations = (
  _job: Pick<Job, 'data'>,
  database: Queryable,
): Promise<FailedExpectation[]> => failOverdueExpectations(database);

export const scheduleExpectationSweep = async (
  queue: Queue,
  everyMs = 60_000,
): Promise<void> => {
  await queue.upsertJobScheduler(
    'expectation-deadline-sweep',
    { every: everyMs },
    { name: 'check-expectations', data: {} },
  );
};

export const createCheckExpectationsWorker = (
  connection: ConnectionOptions,
  database: Queryable,
): Worker =>
  new Worker(
    CHECK_EXPECTATIONS_QUEUE,
    (job) => processCheckExpectations(job, database),
    { connection },
  );
