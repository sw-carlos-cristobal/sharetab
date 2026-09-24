import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import {
  decideOidcSignIn,
  findUserByEmail,
  gatherOidcFacts,
  mapOidcProfile,
  matchUserByEmail,
  type OidcSignInFacts,
} from './oidc-sign-in';

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

  test('allows a linked identity when its own user is already signed in', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, linkedUserId: 'user-1', sessionUserId: 'user-1' })).toEqual({
      allow: true,
    });
  });

  test('denies a linked identity while a different user is signed in', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, linkedUserId: 'user-1', sessionUserId: 'user-2' })).toEqual({
      allow: false,
      error: 'OidcSessionActive',
    });
  });

  test('a linked identity wins over the email and registration rules', () => {
    expect(
      decideOidcSignIn({
        linkedUserId: 'user-1',
        sessionUserId: null,
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

  test('denies when several users match the email case-insensitively, even with linking on', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: 'ambiguous', allowEmailLinking: true })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
    });
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

describe('matchUserByEmail', () => {
  const user = (id: string, email: string) => ({ id, email });

  test('no candidates means no match', () => {
    expect(matchUserByEmail('alice@example.com', [])).toBeNull();
  });

  test('matches a single user regardless of case', () => {
    expect(matchUserByEmail('alice@example.com', [user('u1', 'Alice@Example.com')])).toEqual(
      user('u1', 'Alice@Example.com'),
    );
  });

  test('prefers the exact match when several casings exist', () => {
    expect(
      matchUserByEmail('alice@example.com', [user('u1', 'Alice@example.com'), user('u2', 'alice@example.com')]),
    ).toEqual(user('u2', 'alice@example.com'));
  });

  test('several other-case matches are ambiguous', () => {
    expect(
      matchUserByEmail('alice@example.com', [user('u1', 'Alice@example.com'), user('u2', 'ALICE@example.com')]),
    ).toBe('ambiguous');
  });

  test('ignores candidates that only match as a SQL pattern', () => {
    // `_` and `%` are LIKE wildcards; the DB query may over-match.
    expect(matchUserByEmail('a_ice@example.com', [user('u1', 'alice@example.com')])).toBeNull();
    expect(matchUserByEmail('%@example.com', [user('u1', 'alice@example.com')])).toBeNull();
  });
});

function mockDb(overrides: {
  account?: { userId: string } | null;
  usersByEmail?: { id: string; email: string; isPlaceholder: boolean }[];
  sessionUser?: { id: string } | null;
}) {
  const db = {
    account: { findUnique: vi.fn().mockResolvedValue(overrides.account ?? null) },
    user: {
      findMany: vi.fn().mockResolvedValue(overrides.usersByEmail ?? []),
      findUnique: vi.fn().mockResolvedValue(overrides.sessionUser ?? null),
    },
  };
  return { db, client: db as unknown as PrismaClient };
}

describe('findUserByEmail', () => {
  test('queries case-insensitively and returns the matching row', async () => {
    const { db, client } = mockDb({
      usersByEmail: [{ id: 'u1', email: 'Alice@example.com', isPlaceholder: false }],
    });
    await expect(findUserByEmail(client, 'alice@example.com')).resolves.toEqual({
      id: 'u1',
      email: 'Alice@example.com',
      isPlaceholder: false,
    });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { equals: 'alice@example.com', mode: 'insensitive' } } }),
    );
  });
});

describe('gatherOidcFacts', () => {
  const INPUT = {
    providerAccountId: 'sub-1',
    email: 'alice@example.com',
    sessionUserId: null,
    autoRegister: true,
    allowEmailLinking: false,
  };

  test('reports the linked user for a known (provider, sub)', async () => {
    const { db, client } = mockDb({ account: { userId: 'u1' } });
    const facts = await gatherOidcFacts(client, INPUT);
    expect(facts.linkedUserId).toBe('u1');
    expect(db.account.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_providerAccountId: { provider: 'oidc', providerAccountId: 'sub-1' } },
      }),
    );
  });

  test('resolves the email match case-insensitively', async () => {
    const { client } = mockDb({
      usersByEmail: [{ id: 'u1', email: 'Alice@example.com', isPlaceholder: false }],
    });
    const facts = await gatherOidcFacts(client, INPUT);
    expect(facts.userByEmail).toEqual({ id: 'u1', isPlaceholder: false });
  });

  test('reports ambiguous email matches', async () => {
    const { client } = mockDb({
      usersByEmail: [
        { id: 'u1', email: 'Alice@example.com', isPlaceholder: false },
        { id: 'u2', email: 'ALICE@example.com', isPlaceholder: false },
      ],
    });
    expect((await gatherOidcFacts(client, INPUT)).userByEmail).toBe('ambiguous');
  });

  test('skips the email lookup when the IdP sent no email', async () => {
    const { db, client } = mockDb({});
    const facts = await gatherOidcFacts(client, { ...INPUT, email: null });
    expect(facts.userByEmail).toBeNull();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  test('keeps a session whose user still exists', async () => {
    const { client } = mockDb({ sessionUser: { id: 'u9' } });
    expect((await gatherOidcFacts(client, { ...INPUT, sessionUserId: 'u9' })).sessionUserId).toBe('u9');
  });

  test('ignores a session whose user was deleted', async () => {
    const { client } = mockDb({ sessionUser: null });
    expect((await gatherOidcFacts(client, { ...INPUT, sessionUserId: 'gone' })).sessionUserId).toBeNull();
  });

  test('passes the config flags through', async () => {
    const { client } = mockDb({});
    const facts = await gatherOidcFacts(client, { ...INPUT, autoRegister: false, allowEmailLinking: true });
    expect(facts).toMatchObject({ autoRegister: false, allowEmailLinking: true, email: 'alice@example.com' });
  });
});
