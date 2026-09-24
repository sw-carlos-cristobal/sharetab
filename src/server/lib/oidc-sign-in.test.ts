import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { decideOidcSignIn, gatherOidcFacts, mapOidcProfile, type OidcSignInFacts } from './oidc-sign-in';

const NEW_IDENTITY: OidcSignInFacts = {
  linkedUserId: null,
  sessionUserId: null,
  email: 'alice@example.com',
  userByEmail: null,
  autoRegister: true,
  allowEmailLinking: false,
  passwordRegistrationOpen: false,
};

const EXISTING_USER = { id: 'user-1', isPlaceholder: false, hasOidcAccount: false };

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
        userByEmail: { id: 'user-3', isPlaceholder: true, hasOidcAccount: false },
        autoRegister: false,
        allowEmailLinking: false,
        passwordRegistrationOpen: true,
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
        userByEmail: { id: 'placeholder-1', isPlaceholder: true, hasOidcAccount: false },
        allowEmailLinking: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'placeholder' });
  });

  test('denies when several users match the email case-insensitively, even with linking on', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: 'ambiguous', allowEmailLinking: true })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
      reason: 'ambiguous_email',
    });
  });

  test('never links a second IdP identity to an account that already has one', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: { ...EXISTING_USER, hasOidcAccount: true },
        allowEmailLinking: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'already_linked' });
  });

  test('denies an existing email when linking is off', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
      reason: 'linking_disabled',
    });
  });

  test('allows linking an existing email when linking is on', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER, allowEmailLinking: true })).toEqual({
      allow: true,
    });
  });

  test('refuses linking while anyone can register a password account', () => {
    // Otherwise someone could register another person's address in advance
    // and receive their IdP identity on first SSO sign-in.
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: EXISTING_USER,
        allowEmailLinking: true,
        passwordRegistrationOpen: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'password_registration_open' });
  });

  test('open password registration does not affect brand-new identities', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, passwordRegistrationOpen: true })).toEqual({ allow: true });
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

  test('keeps only http(s) picture URLs', () => {
    expect(mapOidcProfile({ sub: 's', picture: 'http://idp.lan/a.png' }).image).toBe('http://idp.lan/a.png');
    expect(mapOidcProfile({ sub: 's', picture: 'javascript:alert(1)' }).image).toBeNull();
    expect(mapOidcProfile({ sub: 's', picture: 'data:image/png;base64,AAAA' }).image).toBeNull();
    expect(mapOidcProfile({ sub: 's', picture: 'not a url' }).image).toBeNull();
  });

  test('caps the name at 100 characters, like the register form', () => {
    expect(mapOidcProfile({ sub: 's', name: 'x'.repeat(150) }).name).toHaveLength(100);
  });

  test('throws when sub is missing or blank', () => {
    expect(() => mapOidcProfile({ email: 'alice@example.com' })).toThrow(/sub/);
    expect(() => mapOidcProfile({ sub: ' ' })).toThrow(/sub/);
  });
});

type MatchRow = { id: string; email: string; isPlaceholder: boolean };

function mockDb(overrides: {
  account?: { userId: string } | null;
  usersByEmail?: MatchRow[];
  sessionUser?: { id: string } | null;
  oidcAccountOf?: string[];
  registrationMode?: string | null;
}) {
  const rows = overrides.usersByEmail ?? [];
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
    account: {
      findUnique: vi.fn().mockResolvedValue(overrides.account ?? null),
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        overrides.oidcAccountOf?.includes(where.userId) ? { id: `acc-${where.userId}` } : null,
      ),
    },
    user: {
      findMany: vi.fn().mockResolvedValue(rows),
      findUnique: vi.fn().mockResolvedValue(overrides.sessionUser ?? null),
    },
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(overrides.registrationMode ? { value: overrides.registrationMode } : null),
    },
  };
  return { db, client: db as unknown as PrismaClient };
}

describe('gatherOidcFacts', () => {
  const INPUT = {
    providerAccountId: 'sub-1',
    email: 'alice@example.com',
    sessionUserId: null,
    autoRegister: true,
    allowEmailLinking: false,
    passwordLogin: true,
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
    expect(facts.userByEmail).toEqual({ id: 'u1', isPlaceholder: false, hasOidcAccount: false });
  });

  test('reports whether the matched user already has an IdP identity linked', async () => {
    const { client } = mockDb({
      usersByEmail: [{ id: 'u1', email: 'alice@example.com', isPlaceholder: false }],
      oidcAccountOf: ['u1'],
    });
    expect((await gatherOidcFacts(client, INPUT)).userByEmail).toEqual({
      id: 'u1',
      isPlaceholder: false,
      hasOidcAccount: true,
    });
  });

  test('several case variants are ambiguous even when one matches exactly', async () => {
    const { client } = mockDb({
      usersByEmail: [
        { id: 'u1', email: 'alice@example.com', isPlaceholder: false },
        { id: 'u2', email: 'Alice@example.com', isPlaceholder: false },
      ],
    });
    expect((await gatherOidcFacts(client, INPUT)).userByEmail).toBe('ambiguous');
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
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test('keeps a session whose user still exists', async () => {
    const { client } = mockDb({ sessionUser: { id: 'u9' } });
    expect((await gatherOidcFacts(client, { ...INPUT, sessionUserId: 'u9' })).sessionUserId).toBe('u9');
  });

  test('ignores a session whose user row no longer exists', async () => {
    const { client } = mockDb({ sessionUser: null });
    expect((await gatherOidcFacts(client, { ...INPUT, sessionUserId: 'gone' })).sessionUserId).toBeNull();
  });

  test('password registration counts as open when the setting is missing or open', async () => {
    const linking = { ...INPUT, allowEmailLinking: true };
    expect((await gatherOidcFacts(mockDb({}).client, linking)).passwordRegistrationOpen).toBe(true);
    expect((await gatherOidcFacts(mockDb({ registrationMode: 'open' }).client, linking)).passwordRegistrationOpen).toBe(
      true,
    );
  });

  test('an unrecognised registration mode counts as open, as auth.register treats it', async () => {
    const linking = { ...INPUT, allowEmailLinking: true };
    expect(
      (await gatherOidcFacts(mockDb({ registrationMode: 'something-else' }).client, linking)).passwordRegistrationOpen,
    ).toBe(true);
  });

  test('password registration is not open when closed, invite-only, or password login is off', async () => {
    const linking = { ...INPUT, allowEmailLinking: true };
    expect(
      (await gatherOidcFacts(mockDb({ registrationMode: 'closed' }).client, linking)).passwordRegistrationOpen,
    ).toBe(false);
    expect(
      (await gatherOidcFacts(mockDb({ registrationMode: 'invite-only' }).client, linking)).passwordRegistrationOpen,
    ).toBe(false);
    expect(
      (await gatherOidcFacts(mockDb({}).client, { ...linking, passwordLogin: false })).passwordRegistrationOpen,
    ).toBe(false);
  });

  test('skips the registration lookup when linking is off', async () => {
    const { db, client } = mockDb({});
    expect((await gatherOidcFacts(client, INPUT)).passwordRegistrationOpen).toBe(false);
    expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  test('passes the config flags through', async () => {
    const { client } = mockDb({});
    const facts = await gatherOidcFacts(client, { ...INPUT, autoRegister: false, allowEmailLinking: true });
    expect(facts).toMatchObject({ autoRegister: false, allowEmailLinking: true, email: 'alice@example.com' });
  });
});
