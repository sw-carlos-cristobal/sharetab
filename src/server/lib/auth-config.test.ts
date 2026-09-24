import { describe, expect, test } from 'vitest';
import { parseAuthConfig } from './auth-config';

const OIDC_ENV = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/sharetab/',
  OIDC_CLIENT_ID: 'sharetab',
  OIDC_CLIENT_SECRET: 's3cret',
};

describe('parseAuthConfig', () => {
  test('empty env keeps password login and enables nothing else', () => {
    expect(parseAuthConfig({})).toEqual({
      passwordLogin: true,
      magicLink: false,
      oidc: null,
      warnings: [],
    });
  });

  test('issuer, client id and secret enable OIDC with defaults', () => {
    const config = parseAuthConfig(OIDC_ENV);
    expect(config.oidc).toEqual({
      issuer: 'https://auth.example.com/application/o/sharetab/',
      clientId: 'sharetab',
      clientSecret: 's3cret',
      displayName: 'SSO',
      autoRegister: true,
      allowEmailLinking: false,
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(config.warnings).toEqual([]);
  });

  test('keeps the issuer trailing slash exactly as given', () => {
    expect(parseAuthConfig({ ...OIDC_ENV, OIDC_ISSUER: 'https://auth.example.com/realms/home' }).oidc?.issuer).toBe(
      'https://auth.example.com/realms/home',
    );
  });

  test('trims values and honours OIDC_DISPLAY_NAME', () => {
    const config = parseAuthConfig({
      OIDC_ISSUER: '  https://auth.example.com/  ',
      OIDC_CLIENT_ID: ' sharetab ',
      OIDC_CLIENT_SECRET: ' s3cret ',
      OIDC_DISPLAY_NAME: ' Authentik ',
    });
    expect(config.oidc).toMatchObject({
      issuer: 'https://auth.example.com/',
      clientId: 'sharetab',
      clientSecret: 's3cret',
      displayName: 'Authentik',
    });
  });

  test('blank display name falls back to SSO', () => {
    expect(parseAuthConfig({ ...OIDC_ENV, OIDC_DISPLAY_NAME: '   ' }).oidc?.displayName).toBe('SSO');
  });

  test('partial OIDC config disables OIDC and names the missing vars', () => {
    const config = parseAuthConfig({ OIDC_ISSUER: OIDC_ENV.OIDC_ISSUER, OIDC_CLIENT_SECRET: '  ' });
    expect(config.oidc).toBeNull();
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('OIDC_CLIENT_ID');
    expect(config.warnings[0]).toContain('OIDC_CLIENT_SECRET');
    expect(config.warnings[0]).not.toContain('OIDC_ISSUER');
  });

  test('never echoes the client secret in warnings', () => {
    const config = parseAuthConfig({ OIDC_CLIENT_SECRET: 'super-secret-value' });
    expect(config.warnings.join(' ')).not.toContain('super-secret-value');
  });

  test.each(['auth.example.com', 'ftp://auth.example.com/', 'not a url'])(
    'issuer %s that is not an http(s) URL disables OIDC with a warning',
    (issuer) => {
      const config = parseAuthConfig({ ...OIDC_ENV, OIDC_ISSUER: issuer });
      expect(config.oidc).toBeNull();
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain('OIDC_ISSUER');
    },
  );

  test.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    [' on ', true],
    ['false', false],
    ['False', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('boolean %s parses as %s', (value, expected) => {
    const config = parseAuthConfig({ ...OIDC_ENV, OIDC_AUTO_REGISTER: value, OIDC_ALLOW_EMAIL_LINKING: value });
    expect(config.oidc?.autoRegister).toBe(expected);
    expect(config.oidc?.allowEmailLinking).toBe(expected);
    expect(config.warnings).toEqual([]);
  });

  test('blank booleans use their defaults', () => {
    const config = parseAuthConfig({ ...OIDC_ENV, OIDC_AUTO_REGISTER: '', OIDC_ALLOW_EMAIL_LINKING: ' ' });
    expect(config.oidc?.autoRegister).toBe(true);
    expect(config.oidc?.allowEmailLinking).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  test('unrecognised booleans use their defaults and warn', () => {
    const config = parseAuthConfig({ ...OIDC_ENV, OIDC_AUTO_REGISTER: 'nope', OIDC_ALLOW_EMAIL_LINKING: 'sure' });
    expect(config.oidc?.autoRegister).toBe(true);
    expect(config.oidc?.allowEmailLinking).toBe(false);
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings[0]).toContain('OIDC_AUTO_REGISTER');
    expect(config.warnings[1]).toContain('OIDC_ALLOW_EMAIL_LINKING');
  });

  test('OIDC_TOKEN_AUTH_METHOD accepts client_secret_post in any case', () => {
    const config = parseAuthConfig({ ...OIDC_ENV, OIDC_TOKEN_AUTH_METHOD: ' Client_Secret_Post ' });
    expect(config.oidc?.tokenAuthMethod).toBe('client_secret_post');
    expect(config.warnings).toEqual([]);
  });

  test('unknown OIDC_TOKEN_AUTH_METHOD falls back to client_secret_basic and warns', () => {
    const config = parseAuthConfig({ ...OIDC_ENV, OIDC_TOKEN_AUTH_METHOD: 'private_key_jwt' });
    expect(config.oidc?.tokenAuthMethod).toBe('client_secret_basic');
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('OIDC_TOKEN_AUTH_METHOD');
  });

  test('DISABLE_PASSWORD_LOGIN turns password login off when OIDC is configured', () => {
    const config = parseAuthConfig({ ...OIDC_ENV, DISABLE_PASSWORD_LOGIN: 'true' });
    expect(config.passwordLogin).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  test('DISABLE_PASSWORD_LOGIN turns password login off when only magic link is configured', () => {
    const config = parseAuthConfig({ EMAIL_SERVER_HOST: 'smtp.example.com', DISABLE_PASSWORD_LOGIN: 'true' });
    expect(config.passwordLogin).toBe(false);
  });

  test('DISABLE_PASSWORD_LOGIN is ignored when only Google is configured (no Google button on the login page)', () => {
    const config = parseAuthConfig({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      DISABLE_PASSWORD_LOGIN: 'true',
    });
    expect(config.passwordLogin).toBe(true);
    expect(config.warnings).toHaveLength(1);
  });

  test('DISABLE_PASSWORD_LOGIN is ignored with a warning when no other sign-in method exists', () => {
    const config = parseAuthConfig({ DISABLE_PASSWORD_LOGIN: 'true' });
    expect(config.passwordLogin).toBe(true);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('DISABLE_PASSWORD_LOGIN');
  });

  test('DISABLE_PASSWORD_LOGIN is ignored when OIDC is only partially configured', () => {
    const config = parseAuthConfig({ OIDC_ISSUER: OIDC_ENV.OIDC_ISSUER, DISABLE_PASSWORD_LOGIN: 'true' });
    expect(config.passwordLogin).toBe(true);
    expect(config.warnings).toHaveLength(2);
  });

  test('magicLink requires a non-blank EMAIL_SERVER_HOST', () => {
    expect(parseAuthConfig({ EMAIL_SERVER_HOST: 'smtp.example.com' }).magicLink).toBe(true);
    expect(parseAuthConfig({ EMAIL_SERVER_HOST: '  ' }).magicLink).toBe(false);
  });
});
