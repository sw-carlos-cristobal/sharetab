import { describe, expect, test } from 'vitest';
import { decideOidcSignIn, mapOidcProfile, pickStoredEmail, type OidcSignInFacts } from './oidc-sign-in';

const NEW_IDENTITY: OidcSignInFacts = {
  linkedUserId: null,
  sessionUserId: null,
  email: 'alice@example.com',
  userByEmail: null,
  autoRegister: true,
  allowEmailLinking: false,
};

const EXISTING_USER = { id: 'user-1', isPlaceholder: false };

describe('decideOidcSignIn', () => {
  test('allows an identity that is already linked', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, linkedUserId: 'user-1' })).toEqual({ allow: true });
  });

  test('a linked identity wins over every later rule', () => {
    expect(
      decideOidcSignIn({
        linkedUserId: 'user-1',
        sessionUserId: 'user-2',
        email: null,
        userByEmail: { id: 'user-3', isPlaceholder: true },
        autoRegister: false,
        allowEmailLinking: false,
      }),
    ).toEqual({ allow: true });
  });

  test('denies an unlinked identity while another session is active', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, sessionUserId: 'user-2' })).toEqual({
      allow: false,
      error: 'OidcSessionActive',
    });
  });

  test('the active-session check runs before the email checks', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, sessionUserId: 'user-2', email: null })).toEqual({
      allow: false,
      error: 'OidcSessionActive',
    });
  });

  test('denies when the IdP sends no email', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, email: null })).toEqual({ allow: false, error: 'OidcEmailMissing' });
  });

  test('never links to a placeholder user, even with linking enabled', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: { id: 'placeholder-1', isPlaceholder: true },
        allowEmailLinking: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked' });
  });

  test('denies an existing email when linking is off', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
    });
  });

  test('allows linking an existing email when linking is on', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER, allowEmailLinking: true })).toEqual({
      allow: true,
    });
  });

  test('linking an existing user is allowed even with auto-register off', () => {
    expect(
      decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER, allowEmailLinking: true, autoRegister: false }),
    ).toEqual({ allow: true });
  });

  test('denies a brand-new identity when auto-register is off', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, autoRegister: false })).toEqual({
      allow: false,
      error: 'OidcRegistrationDisabled',
    });
  });

  test('allows a brand-new identity when auto-register is on', () => {
    expect(decideOidcSignIn(NEW_IDENTITY)).toEqual({ allow: true });
  });
});

describe('mapOidcProfile', () => {
  test('maps standard claims', () => {
    expect(
      mapOidcProfile({
        sub: 'abc-123',
        name: 'Alice Doe',
        email: 'alice@example.com',
        picture: 'https://auth.example.com/alice.png',
      }),
    ).toEqual({
      id: 'abc-123',
      name: 'Alice Doe',
      email: 'alice@example.com',
      image: 'https://auth.example.com/alice.png',
    });
  });

  test('builds the name from given and family name when name is absent', () => {
    expect(mapOidcProfile({ sub: 's', given_name: 'Alice', family_name: 'Doe' }).name).toBe('Alice Doe');
    expect(mapOidcProfile({ sub: 's', given_name: 'Alice' }).name).toBe('Alice');
  });

  test('falls back to preferred_username, then nickname, then null', () => {
    expect(mapOidcProfile({ sub: 's', name: '  ', preferred_username: 'alice', nickname: 'al' }).name).toBe('alice');
    expect(mapOidcProfile({ sub: 's', nickname: 'al' }).name).toBe('al');
    expect(mapOidcProfile({ sub: 's' }).name).toBeNull();
  });

  test('trims email and treats blank or non-string email as missing', () => {
    expect(mapOidcProfile({ sub: 's', email: '  alice@example.com ' }).email).toBe('alice@example.com');
    expect(mapOidcProfile({ sub: 's', email: '   ' }).email).toBeNull();
    expect(mapOidcProfile({ sub: 's', email: 42 }).email).toBeNull();
    expect(mapOidcProfile({ sub: 's' }).email).toBeNull();
  });

  test('ignores a non-string picture', () => {
    expect(mapOidcProfile({ sub: 's', picture: { url: 'x' } }).image).toBeNull();
  });

  test('throws when sub is missing or blank', () => {
    expect(() => mapOidcProfile({ email: 'alice@example.com' })).toThrow(/sub/);
    expect(() => mapOidcProfile({ sub: ' ' })).toThrow(/sub/);
  });
});

describe('pickStoredEmail', () => {
  test('keeps the email when an exact match exists', () => {
    expect(pickStoredEmail('alice@example.com', ['Alice@example.com', 'alice@example.com'])).toBe('alice@example.com');
  });

  test('returns the stored casing of a single case-insensitive match', () => {
    expect(pickStoredEmail('Alice@Example.com', ['alice@example.com'])).toBe('alice@example.com');
  });

  test('returns the email unchanged when nothing matches', () => {
    expect(pickStoredEmail('alice@example.com', [])).toBe('alice@example.com');
  });

  test('returns the email unchanged when several other casings match', () => {
    expect(pickStoredEmail('ALICE@example.com', ['alice@example.com', 'Alice@example.com'])).toBe('ALICE@example.com');
  });
});
