import { checkRateLimit, parsePositiveInt, peekRateLimit, refundRateLimit } from './rate-limit';

/**
 * Receipt upload and AI scan limits (#434). Every limit counts per hour, in the main rate-limit store
 * (so they reset when ShareTab restarts):
 * - a signed-in user's uploads (`USER_UPLOAD_LIMIT`) and AI scans (`USER_AI_LIMIT`), for the group
 *   scan path (`/api/upload` without `?guest=true`, `receipts.processReceipt`, `retryProcessing`);
 * - guest scans (Quick Split, signed in or not): per receipt, per client IP, and `GUEST_AI_GLOBAL_LIMIT`
 *   across all guests;
 * - every receipt scan, guest or signed in, against `AI_GLOBAL_LIMIT`: a signed-in scan skips the
 *   guest cap but still stops at this one, so it bounds the instance's AI spend (the admin provider
 *   test isn't counted). It caps guest scans too. Each key's window starts at its own first spend,
 *   so guests can take up to twice `GUEST_AI_GLOBAL_LIMIT`, less one, of a single `AI_GLOBAL_LIMIT`
 *   window: signed-in users are sure only of what's left above that.
 * Guest uploads keep their own limiter in `/api/upload`.
 */
export const RECEIPT_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type Quota = { key: string; max: number };

/** The limits as configured, read on every call so a test can change them */
export function receiptLimits() {
  return {
    userUploads: parsePositiveInt(process.env.USER_UPLOAD_LIMIT, 30),
    userScans: parsePositiveInt(process.env.USER_AI_LIMIT, 30),
    guestScans: parsePositiveInt(process.env.GUEST_AI_GLOBAL_LIMIT, 100),
    allScans: parsePositiveInt(process.env.AI_GLOBAL_LIMIT, 200),
  };
}

const allScansQuota = (): Quota => ({ key: 'ai-scan-global', max: receiptLimits().allScans });

/** A signed-in user's receipt uploads on the group scan path */
export function userUploadQuotas(userId: string): Quota[] {
  return [{ key: `user-upload:${userId}`, max: receiptLimits().userUploads }];
}

/** A signed-in user's AI scans on the group scan path, and the instance's */
export function userScanQuotas(userId: string): Quota[] {
  return [{ key: `user-process:${userId}`, max: receiptLimits().userScans }, allScansQuota()];
}

/**
 * A guest scan's limits: per receipt (bounds rescanning one receipt), per client IP (spoofable
 * without a trusted proxy), all guests, and the instance's
 */
export function guestScanQuotas(receiptId: string, ip: string): Quota[] {
  return [
    { key: `guest-process:${receiptId}`, max: 3 },
    { key: `guest-process-ip:${ip}`, max: 20 },
    { key: 'guest-process-global', max: receiptLimits().guestScans },
    allScansQuota(),
  ];
}

/** Whether every quota has an attempt left, spending none */
export function hasBudget(quotas: Quota[]): boolean {
  return quotas.every((quota) => peekRateLimit(quota.key, quota.max).allowed);
}

/**
 * Spend one attempt from every quota, or from none when any is used up: a caller over its own limit
 * mustn't drain the global budget, and a full global budget mustn't use up the caller's. Returns a
 * function that gives the attempts back (for a scan that never ran, e.g. a receipt already being
 * scanned), or null when refused. Synchronous, so concurrent requests can't all pass the check
 * before any of them spends.
 */
export function spendBudget(quotas: Quota[]): (() => void) | null {
  if (!hasBudget(quotas)) return null;
  for (const quota of quotas) checkRateLimit(quota.key, quota.max, RECEIPT_LIMIT_WINDOW_MS);
  return () => {
    for (const quota of quotas) refundRateLimit(quota.key);
  };
}
