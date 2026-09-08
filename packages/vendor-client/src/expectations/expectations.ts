import type { Queryable } from '../logging/call-log.js';

export type ExpectationActionType =
  | 'deposit'
  | 'withdrawal'
  | 'kyc_submission'
  | 'welcome_email'
  | 'reset_email';

export interface ExpectationInput {
  action_type: ExpectationActionType;
  subject_ref: string;
  amount_minor?: bigint;
  deadline: Date;
  expected_outcome: string;
  metadata?: Record<string, unknown>;
}

const forbiddenMetadataKey = /(wallet|address|email|phone|token|secret|credential|payload|body)/i;
const assertSafeMetadata = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenMetadataKey.test(key)) throw new Error(`Expectation metadata key is forbidden by PII policy: ${key}`);
    assertSafeMetadata(nested);
  }
};

export class ExpectationService {
  public constructor(private readonly database: Queryable) {}

  public async expect(input: ExpectationInput): Promise<string> {
    assertSafeMetadata(input.metadata);
    const result = await this.database.query(
      `insert into action_expectations
         (action_type, subject_ref, amount_minor, deadline_at, expected_outcome, metadata)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        input.action_type,
        input.subject_ref,
        input.amount_minor?.toString() ?? null,
        input.deadline,
        input.expected_outcome,
        input.metadata ?? null,
      ],
    );
    return String(result.rows[0]?.id);
  }

  public async fulfill(subjectRef: string, actionType: ExpectationActionType): Promise<boolean> {
    const result = await this.database.query(
      `update action_expectations
          set status = 'fulfilled', fulfilled_at = now()
        where subject_ref = $1 and action_type = $2 and status = 'pending'`,
      [subjectRef, actionType],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export interface ExpectationWindows {
  depositMs: number;
  withdrawalMs: number;
  kycMs: number;
  emailMs: number;
}

export class ExpectedActionProducer {
  public constructor(
    private readonly expectations: ExpectationService,
    private readonly windows: ExpectationWindows,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private deadline(milliseconds: number): Date {
    return new Date(this.now().getTime() + milliseconds);
  }

  public deposit(subjectRef: string, amountMinor?: bigint): Promise<string> {
    return this.expectations.expect({
      action_type: 'deposit',
      subject_ref: subjectRef,
      amount_minor: amountMinor,
      deadline: this.deadline(this.windows.depositMs),
      expected_outcome: 'balance_credited',
    });
  }

  public withdrawal(subjectRef: string, amountMinor?: bigint): Promise<string> {
    return this.expectations.expect({
      action_type: 'withdrawal',
      subject_ref: subjectRef,
      amount_minor: amountMinor,
      deadline: this.deadline(this.windows.withdrawalMs),
      expected_outcome: 'payout_completed',
    });
  }

  public kyc(subjectRef: string): Promise<string> {
    return this.expectations.expect({
      action_type: 'kyc_submission',
      subject_ref: subjectRef,
      deadline: this.deadline(this.windows.kycMs),
      expected_outcome: 'kyc_decision_recorded',
    });
  }

  public email(subjectRef: string, kind: 'welcome_email' | 'reset_email'): Promise<string> {
    return this.expectations.expect({
      action_type: kind,
      subject_ref: subjectRef,
      deadline: this.deadline(this.windows.emailMs),
      expected_outcome: 'delivery_confirmed',
    });
  }
}
