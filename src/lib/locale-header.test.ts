import { describe, test, expect } from 'vitest';
import { localeFromHeader } from './locale-header';

// #266: the page tells the server its language, so error messages come back in it
describe('localeFromHeader', () => {
  test('takes a supported locale', () => {
    expect(localeFromHeader('de')).toBe('de');
    expect(localeFromHeader('pt-BR')).toBe('pt-BR');
    expect(localeFromHeader('zh-CN')).toBe('zh-CN');
  });

  test('falls back to the default for a missing or unknown one', () => {
    expect(localeFromHeader(null)).toBe('en');
    expect(localeFromHeader('')).toBe('en');
    expect(localeFromHeader('xx')).toBe('en');
    expect(localeFromHeader('de-DE')).toBe('en');
  });
});
