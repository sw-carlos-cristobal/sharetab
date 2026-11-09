import { describe, expect, test } from 'vitest';
import bcrypt from 'bcryptjs';
import { MAX_PASSWORD_BYTES, passwordTooLong } from './password-length';

describe('passwordTooLong', () => {
  test('allows up to 72 bytes, the most bcrypt reads', () => {
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(passwordTooLong('x'.repeat(72))).toBe(false);
    expect(passwordTooLong('x'.repeat(73))).toBe(true);
  });

  test('counts UTF-8 bytes, not characters', () => {
    // 2 bytes each
    expect(passwordTooLong('é'.repeat(36))).toBe(false);
    expect(passwordTooLong('é'.repeat(37))).toBe(true);
    // 3 bytes each: 24 Japanese characters fill the limit
    expect(passwordTooLong('パ'.repeat(24))).toBe(false);
    expect(passwordTooLong('パ'.repeat(25))).toBe(true);
    // 4 bytes each, and two UTF-16 code units
    expect(passwordTooLong('🔑'.repeat(18))).toBe(false);
    expect(passwordTooLong('🔑'.repeat(19))).toBe(true);
    expect(passwordTooLong(`${'x'.repeat(71)}é`)).toBe(true);
  });

  test('agrees with bcryptjs on what it would cut short', () => {
    const samples = [
      'x'.repeat(72),
      'x'.repeat(73),
      'パ'.repeat(24),
      'パ'.repeat(25),
      `${'x'.repeat(70)}é`,
      `${'x'.repeat(71)}é`,
      '🔑'.repeat(18),
      `${'x'.repeat(69)}🔑`,
      // A lone surrogate: 3 bytes to both (TextEncoder writes U+FFFD in its place)
      `${'x'.repeat(69)}\uD83D`,
      `${'x'.repeat(70)}\uD83D`,
      `${'x'.repeat(69)}\uDC11`,
    ];
    for (const password of samples) {
      expect(passwordTooLong(password), JSON.stringify(password)).toBe(bcrypt.truncates(password));
    }
  });
});
