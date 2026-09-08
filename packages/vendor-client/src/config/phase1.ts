export const isPhase1Enabled = (): boolean => process.env.PHASE1_ENABLED === 'true';

const positiveNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
};

export const getPhase1Config = () => ({
  enabled: isPhase1Enabled(),
  breakerHealthTtlSeconds: positiveNumber('BREAKER_HEALTH_TTL_SECONDS', 30),
  breakerTimeoutMs: positiveNumber('BREAKER_TIMEOUT_MS', 10_000),
  breakerErrorThresholdPercentage: positiveNumber('BREAKER_ERROR_THRESHOLD_PERCENT', 50),
  breakerResetTimeoutMs: positiveNumber('BREAKER_RESET_TIMEOUT_MS', 30_000),
  breakerVolumeThreshold: positiveNumber('BREAKER_VOLUME_THRESHOLD', 10),
  paymentVerificationEscalateMs: positiveNumber('PAYMENT_VERIFICATION_ESCALATE_MS', 900_000),
});
