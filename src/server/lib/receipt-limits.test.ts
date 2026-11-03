import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// rate-limit.ts starts a cleanup setInterval at load time, so fake timers go first
vi.useFakeTimers();

const { guestScanQuotas, hasBudget, receiptLimits, spendBudget, userScanQuotas, userUploadQuotas } =
  await import('./receipt-limits');

const HOUR = 60 * 60 * 1000;

let ipSeq = 0;
// A fresh client address per guest scan, so only the global caps can refuse it
function guestScan() {
  ipSeq += 1;
  return spendBudget(guestScanQuotas(`receipt-${ipSeq}`, `198.51.100.${ipSeq}`));
}

function spendMany(quotas: () => ReturnType<typeof userScanQuotas>, count: number) {
  return Array.from({ length: count }, () => spendBudget(quotas()) !== null);
}

beforeEach(() => {
  // Expire every window left over from the previous test
  vi.advanceTimersByTime(24 * HOUR);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('receiptLimits', () => {
  test('defaults: 30 uploads and 30 scans an hour per account, 100 guest scans and 200 scans in all', () => {
    expect(receiptLimits()).toEqual({ userUploads: 30, userScans: 30, guestScans: 100, allScans: 200 });
  });

  test('reads each limit from its environment variable', () => {
    vi.stubEnv('USER_UPLOAD_LIMIT', '5');
    vi.stubEnv('USER_AI_LIMIT', '6');
    vi.stubEnv('GUEST_AI_GLOBAL_LIMIT', '7');
    vi.stubEnv('AI_GLOBAL_LIMIT', '8');
    expect(receiptLimits()).toEqual({ userUploads: 5, userScans: 6, guestScans: 7, allScans: 8 });
  });

  // A NaN or negative limit would make every comparison refuse, or none
  test.each(['', 'abc', '0', '-5'])('falls back to the default for %j', (value) => {
    vi.stubEnv('USER_UPLOAD_LIMIT', value);
    vi.stubEnv('USER_AI_LIMIT', value);
    vi.stubEnv('GUEST_AI_GLOBAL_LIMIT', value);
    vi.stubEnv('AI_GLOBAL_LIMIT', value);
    expect(receiptLimits()).toEqual({ userUploads: 30, userScans: 30, guestScans: 100, allScans: 200 });
  });
});

describe('uploads by a signed-in user (#434)', () => {
  test('allows USER_UPLOAD_LIMIT uploads an hour, then refuses', () => {
    vi.stubEnv('USER_UPLOAD_LIMIT', '3');
    expect(spendMany(() => userUploadQuotas('upload-a'), 4)).toEqual([true, true, true, false]);
    expect(hasBudget(userUploadQuotas('upload-a'))).toBe(false);
  });

  test('counts each account separately', () => {
    vi.stubEnv('USER_UPLOAD_LIMIT', '1');
    expect(spendBudget(userUploadQuotas('upload-b'))).not.toBeNull();
    expect(spendBudget(userUploadQuotas('upload-b'))).toBeNull();
    expect(spendBudget(userUploadQuotas('upload-c'))).not.toBeNull();
  });

  test('allows uploads again once the hour is over', () => {
    vi.stubEnv('USER_UPLOAD_LIMIT', '1');
    expect(spendBudget(userUploadQuotas('upload-d'))).not.toBeNull();
    expect(hasBudget(userUploadQuotas('upload-d'))).toBe(false);

    vi.advanceTimersByTime(HOUR + 1);
    expect(hasBudget(userUploadQuotas('upload-d'))).toBe(true);
    expect(spendBudget(userUploadQuotas('upload-d'))).not.toBeNull();
  });

  test('checking the budget spends none of it', () => {
    vi.stubEnv('USER_UPLOAD_LIMIT', '1');
    expect(hasBudget(userUploadQuotas('upload-e'))).toBe(true);
    expect(hasBudget(userUploadQuotas('upload-e'))).toBe(true);
    expect(spendBudget(userUploadQuotas('upload-e'))).not.toBeNull();
  });
});

describe('AI scans by a signed-in user (#434)', () => {
  test('allows USER_AI_LIMIT scans an hour, then refuses', () => {
    vi.stubEnv('USER_AI_LIMIT', '2');
    expect(spendMany(() => userScanQuotas('scan-a'), 3)).toEqual([true, true, false]);
  });

  test('allows scans again once the hour is over', () => {
    vi.stubEnv('USER_AI_LIMIT', '1');
    expect(spendBudget(userScanQuotas('scan-b'))).not.toBeNull();
    expect(spendBudget(userScanQuotas('scan-b'))).toBeNull();

    vi.advanceTimersByTime(HOUR + 1);
    expect(spendBudget(userScanQuotas('scan-b'))).not.toBeNull();
  });

  test('a refund gives the scan back, for a scan that never ran', () => {
    vi.stubEnv('USER_AI_LIMIT', '1');
    const refund = spendBudget(userScanQuotas('scan-c'));
    expect(refund).not.toBeNull();
    refund?.();
    expect(spendBudget(userScanQuotas('scan-c'))).not.toBeNull();
  });
});

describe('the global AI scan cap counts every scan (#434)', () => {
  test('guest scans and signed-in scans share AI_GLOBAL_LIMIT', () => {
    vi.stubEnv('AI_GLOBAL_LIMIT', '3');
    expect(guestScan()).not.toBeNull();
    expect(guestScan()).not.toBeNull();
    expect(spendBudget(userScanQuotas('global-a'))).not.toBeNull();

    // Spent: neither a new account nor a new guest gets through
    expect(spendBudget(userScanQuotas('global-b'))).toBeNull();
    expect(guestScan()).toBeNull();
  });

  test('signing up does not get around the cap: every account spends the same budget', () => {
    vi.stubEnv('AI_GLOBAL_LIMIT', '4');
    const accounts = Array.from({ length: 6 }, (_, i) => spendBudget(userScanQuotas(`global-acct-${i}`)) !== null);
    expect(accounts).toEqual([true, true, true, true, false, false]);
  });

  test('within one shared window, a guest refused by the guest cap leaves the rest of the global budget to signed-in users', () => {
    vi.stubEnv('GUEST_AI_GLOBAL_LIMIT', '2');
    vi.stubEnv('AI_GLOBAL_LIMIT', '3');
    expect(guestScan()).not.toBeNull();
    expect(guestScan()).not.toBeNull();
    expect(guestScan()).toBeNull();

    expect(spendBudget(userScanQuotas('global-c'))).not.toBeNull();
    expect(spendBudget(userScanQuotas('global-d'))).toBeNull();
  });

  test('a scan refused by its own limit spends nothing from the global budget', () => {
    vi.stubEnv('USER_AI_LIMIT', '1');
    vi.stubEnv('AI_GLOBAL_LIMIT', '2');
    expect(spendBudget(userScanQuotas('global-e'))).not.toBeNull();
    // Over its own limit: refused, and the global budget keeps its last scan
    expect(spendBudget(userScanQuotas('global-e'))).toBeNull();
    expect(spendBudget(userScanQuotas('global-e'))).toBeNull();
    expect(spendBudget(userScanQuotas('global-f'))).not.toBeNull();
  });

  test('a scan refused by the global cap spends nothing from its own limit', () => {
    vi.stubEnv('USER_AI_LIMIT', '1');
    vi.stubEnv('AI_GLOBAL_LIMIT', '1');
    expect(spendBudget(userScanQuotas('global-g'))).not.toBeNull();
    expect(spendBudget(userScanQuotas('global-h'))).toBeNull();

    vi.stubEnv('AI_GLOBAL_LIMIT', '10');
    // global-h's refused attempt didn't count, so it still has its one scan
    expect(spendBudget(userScanQuotas('global-h'))).not.toBeNull();
  });

  test('the global cap resets on the hour like the others', () => {
    vi.stubEnv('AI_GLOBAL_LIMIT', '1');
    expect(spendBudget(userScanQuotas('global-i'))).not.toBeNull();
    expect(guestScan()).toBeNull();

    vi.advanceTimersByTime(HOUR + 1);
    expect(guestScan()).not.toBeNull();
  });
});

describe('guest scans keep their own limits', () => {
  test('3 scans an hour per receipt', () => {
    const quotas = () => guestScanQuotas('guest-receipt-a', `203.0.113.${(ipSeq += 1)}`);
    expect(spendMany(quotas, 4)).toEqual([true, true, true, false]);
  });

  test('20 scans an hour per client IP', () => {
    let receipt = 0;
    const quotas = () => guestScanQuotas(`guest-receipt-ip-${(receipt += 1)}`, '203.0.113.250');
    const results = spendMany(quotas, 21);
    expect(results.slice(0, 20).every(Boolean)).toBe(true);
    expect(results[20]).toBe(false);
  });

  test('GUEST_AI_GLOBAL_LIMIT scans an hour across all guests', () => {
    vi.stubEnv('GUEST_AI_GLOBAL_LIMIT', '2');
    expect([guestScan(), guestScan(), guestScan()].map((r) => r !== null)).toEqual([true, true, false]);
  });
});
