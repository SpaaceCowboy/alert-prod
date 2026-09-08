import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import type { Queryable, UnknownPaymentCall } from '@roco/vendor-client';

export const VERIFY_PAYMENT_QUEUE = 'verify-payment';

export interface VerifyPaymentJobData extends UnknownPaymentCall {
  firstUnknownAt: string;
}

export type PaymentResolution = 'succeeded' | 'failed' | 'pending';

export interface VerifyPaymentDependencies {
  lookupStatus(data: VerifyPaymentJobData): Promise<PaymentResolution>;
  recordResolution(data: VerifyPaymentJobData, resolution: Exclude<PaymentResolution, 'pending'> | 'unknown'): Promise<void>;
  escalateAfterMs: number;
  now?: () => number;
}

export class PaymentStillPendingError extends Error {
  public constructor() {
    super('Payment status remains non-terminal');
    this.name = 'PaymentStillPendingError';
  }
}

export const processVerifyPayment = async (
  job: Pick<Job<VerifyPaymentJobData>, 'data'>,
  dependencies: VerifyPaymentDependencies,
): Promise<{ resolution: 'succeeded' | 'failed' | 'unknown' }> => {
  const now = dependencies.now?.() ?? Date.now();
  const age = now - new Date(job.data.firstUnknownAt).getTime();
  const resolution = await dependencies.lookupStatus(job.data);
  if (resolution === 'succeeded' || resolution === 'failed') {
    await dependencies.recordResolution(job.data, resolution);
    return { resolution };
  }
  if (age >= dependencies.escalateAfterMs) {
    await dependencies.recordResolution(job.data, 'unknown');
    return { resolution: 'unknown' };
  }
  throw new PaymentStillPendingError();
};

export const createPaymentResolutionStore = (database: Queryable) =>
  async (
    data: VerifyPaymentJobData,
    resolution: 'succeeded' | 'failed' | 'unknown',
  ): Promise<void> => {
    const expectationStatus = resolution === 'succeeded' ? 'fulfilled' : resolution;
    await database.query(
      `update action_expectations
          set status = $1,
              fulfilled_at = case when $1 = 'fulfilled' then now() else fulfilled_at end
        where status = 'pending'
          and vendor_call_id = (
            select id from vendor_calls where request_id = $2 order by created_at desc limit 1
          )`,
      [expectationStatus, data.requestId],
    );
  };

export interface VerificationQueueLike {
  add(name: string, data: VerifyPaymentJobData, options?: JobsOptions): Promise<unknown>;
}

export const createUnknownPaymentEnqueuer = (queue: VerificationQueueLike) =>
  async (call: UnknownPaymentCall): Promise<void> => {
    const data: VerifyPaymentJobData = { ...call, firstUnknownAt: call.occurredAt };
    await queue.add('verify-payment', data, {
      jobId: `verify:${call.vendor}:${call.requestId}`,
      attempts: 12,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    });
  };

export const createVerifyPaymentQueue = (connection: ConnectionOptions): Queue<VerifyPaymentJobData> =>
  new Queue<VerifyPaymentJobData>(VERIFY_PAYMENT_QUEUE, { connection });

export const createVerifyPaymentWorker = (
  connection: ConnectionOptions,
  dependencies: VerifyPaymentDependencies,
): Worker<VerifyPaymentJobData> =>
  new Worker<VerifyPaymentJobData>(
    VERIFY_PAYMENT_QUEUE,
    (job) => processVerifyPayment(job, dependencies),
    { connection },
  );
