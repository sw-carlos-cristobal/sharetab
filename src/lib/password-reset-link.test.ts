import { describe, expect, test } from 'vitest';
import { readResetToken, resetPasswordPath } from './password-reset-link';

const TOKEN = 'a'.repeat(21) + '_-' + 'B9'.repeat(10);

describe('resetPasswordPath', () => {
  test('puts the token in the fragment, which browsers never send to a server', () => {
    expect(resetPasswordPath('ja', TOKEN)).toBe(`/ja/reset-password#token=${TOKEN}`);
  });
});

describe('readResetToken', () => {
  test('reads the token from a reset link', () => {
    expect(readResetToken(`#token=${TOKEN}`)).toBe(TOKEN);
  });

  test('reads it without the leading #', () => {
    expect(readResetToken(`token=${TOKEN}`)).toBe(TOKEN);
  });

  test('is null without a token', () => {
    expect(readResetToken('')).toBeNull();
    expect(readResetToken('#')).toBeNull();
    expect(readResetToken('#token=')).toBeNull();
    expect(readResetToken('#me=abc')).toBeNull();
  });

  test('is null for a token that is not one ShareTab makes', () => {
    expect(readResetToken('#token=short')).toBeNull();
    expect(readResetToken(`#token=${TOKEN}x`)).toBeNull();
    expect(readResetToken(`#token=${TOKEN.slice(1)}%`)).toBeNull();
  });
});
