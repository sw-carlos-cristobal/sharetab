import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./logger', () => ({ logger }));

import {
  checkOidcSignIn,
  decideOidcSignIn,
  gatherOidcFacts,
  mapOidcProfile,
  type OidcSignInFacts,
} from './oidc-sign-in';

const NEW_IDENTITY: OidcSignInFacts = {
  linkedUserId: null,
  sessionUserId: null,
  email: 'alice@example.com',
  emailVerified: null,
  userByEmail: null,
  autoRegister: true,
  allowEmailLinking: false,
  passwordRegistrationOpen: false,
};

const EXISTING_USER = { id: 'user-1', isPlaceholder: false, hasLinkedIdentity: false };

describe('decideOidcSignIn', () => {
  test('allows an identity that is already linked', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, linkedUserId: 'user-1' })).toEqual({ allow: true });
  });

  test('allows a linked identity when its own user is already signed in', () => {
    // The email matches that same user's account, as it does for every linked identity.
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        linkedUserId: 'user-1',
        sessionUserId: 'user-1',
        userByEmail: { ...EXISTING_USER, hasLinkedIdentity: true },
      }),
    ).toEqual({ allow: true });
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
        emailVerified: false,
        userByEmail: { id: 'user-3', isPlaceholder: true, hasLinkedIdentity: false },
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

  test('denies when the IdP sends no email, or a blank one', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, email: null })).toEqual({ allow: false, error: 'OidcEmailMissing' });
    expect(decideOidcSignIn({ ...NEW_IDENTITY, email: '' })).toEqual({ allow: false, error: 'OidcEmailMissing' });
    // Before the auto-register check, so the message names what the IdP must fix.
    expect(decideOidcSignIn({ ...NEW_IDENTITY, email: null, autoRegister: false })).toEqual({
      allow: false,
      error: 'OidcEmailMissing',
    });
  });

  test('never links to a placeholder user, even with linking enabled', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: { id: 'placeholder-1', isPlaceholder: true, hasLinkedIdentity: false },
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

  test('never links a second IdP identity to an account that already has an IdP or Google identity', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: { ...EXISTING_USER, hasLinkedIdentity: true },
        allowEmailLinking: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'already_linked' });
  });

  test('a placeholder is refused as such even when it has a linked identity', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: { id: 'placeholder-1', isPlaceholder: true, hasLinkedIdentity: true },
        allowEmailLinking: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'placeholder' });
  });

  test('linking off is the reason given even when the IdP says the email is unverified', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER, emailVerified: false })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
      reason: 'linking_disabled',
    });
  });

  test('gives already_linked, not linking_disabled, as the reason for an account with an identity while linking is off', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: { ...EXISTING_USER, hasLinkedIdentity: true } })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
      reason: 'already_linked',
    });
  });

  test('an unverified email is the reason given even while password registration is open', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        userByEmail: EXISTING_USER,
        allowEmailLinking: true,
        emailVerified: false,
        passwordRegistrationOpen: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'email_unverified' });
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

  test('refuses linking when the IdP says the email is unverified', () => {
    // The IdP itself doesn't vouch for the address, so it can't prove who owns the account.
    expect(
      decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER, allowEmailLinking: true, emailVerified: false }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'email_unverified' });
  });

  test('links when the IdP confirms the email or leaves email_verified out', () => {
    const linking = { ...NEW_IDENTITY, userByEmail: EXISTING_USER, allowEmailLinking: true };
    expect(decideOidcSignIn({ ...linking, emailVerified: true })).toEqual({ allow: true });
    expect(decideOidcSignIn({ ...linking, emailVerified: null })).toEqual({ allow: true });
  });

  test('an unverified email does not stop a brand-new identity or a linked one', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, emailVerified: false })).toEqual({ allow: true });
    expect(decideOidcSignIn({ ...NEW_IDENTITY, linkedUserId: 'user-1', emailVerified: false })).toEqual({
      allow: true,
    });
  });

  test('open password registration does not affect brand-new identities', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, passwordRegistrationOpen: true })).toEqual({ allow: true });
  });

  test('linking an existing user is allowed even with auto-register off', () => {
    expect(
      decideOidcSignIn({ ...NEW_IDENTITY, userByEmail: EXISTING_USER, allowEmailLinking: true, autoRegister: false }),
    ).toEqual({ allow: true });
  });

  // Most IdPs send email_verified: true. It must not turn a refusal into a link.
  test.each([true, null, false])(
    'the refusals that come before the email check hold with email_verified %s',
    (emailVerified) => {
      const linking = { ...NEW_IDENTITY, emailVerified, allowEmailLinking: true };
      expect(
        decideOidcSignIn({ ...linking, userByEmail: { id: 'p1', isPlaceholder: true, hasLinkedIdentity: false } }),
      ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'placeholder' });
      expect(decideOidcSignIn({ ...linking, userByEmail: { ...EXISTING_USER, hasLinkedIdentity: true } })).toEqual({
        allow: false,
        error: 'OidcAccountNotLinked',
        reason: 'already_linked',
      });
      expect(decideOidcSignIn({ ...linking, allowEmailLinking: false, userByEmail: EXISTING_USER })).toEqual({
        allow: false,
        error: 'OidcAccountNotLinked',
        reason: 'linking_disabled',
      });
    },
  );

  test.each([true, null])('open password registration refuses linking with email_verified %s', (emailVerified) => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        emailVerified,
        userByEmail: EXISTING_USER,
        allowEmailLinking: true,
        passwordRegistrationOpen: true,
      }),
    ).toEqual({ allow: false, error: 'OidcAccountNotLinked', reason: 'password_registration_open' });
  });

  test('a returning SSO user signs in to their own account while linking is on', () => {
    expect(
      decideOidcSignIn({
        ...NEW_IDENTITY,
        linkedUserId: 'user-1',
        allowEmailLinking: true,
        userByEmail: { ...EXISTING_USER, hasLinkedIdentity: true },
        passwordRegistrationOpen: true,
      }),
    ).toEqual({ allow: true });
  });

  test('denies a brand-new identity when auto-register is off, with linking on too', () => {
    expect(decideOidcSignIn({ ...NEW_IDENTITY, autoRegister: false, allowEmailLinking: true })).toEqual({
      allow: false,
      error: 'OidcRegistrationDisabled',
    });
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

  test("prefers the name claim over given and family name (it keeps the person's own order)", () => {
    expect(mapOidcProfile({ sub: 's', name: '山田 太郎', given_name: '太郎', family_name: '山田' }).name).toBe(
      '山田 太郎',
    );
  });

  test('prefers given and family name over preferred_username', () => {
    expect(
      mapOidcProfile({ sub: 's', given_name: 'Alice', family_name: 'Doe', preferred_username: 'alice' }).name,
    ).toBe('Alice Doe');
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

  test('lowercases the email (ADMIN_EMAIL and lookups compare lowercase)', () => {
    expect(mapOidcProfile({ sub: 's', email: 'Alice@Example.COM' }).email).toBe('alice@example.com');
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
  /** Account rows, which findFirst filters by every key in its `where`. */
  accounts?: { userId: string; provider: string }[];
  registrationMode?: string | null;
}) {
  const rows = overrides.usersByEmail ?? [];
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
    account: {
      findUnique: vi.fn().mockResolvedValue(overrides.account ?? null),
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const row = overrides.accounts?.find((account) =>
          Object.entries(where).every(([key, value]) => account[key as keyof typeof account] === value),
        );
        return row ? { id: `acc-${row.userId}-${row.provider}` } : null;
      }),
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
    emailVerified: null,
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
    const { db, client } = mockDb({
      usersByEmail: [{ id: 'u1', email: 'Alice@example.com', isPlaceholder: false }],
    });
    const facts = await gatherOidcFacts(client, INPUT);
    expect(facts.userByEmail).toEqual({ id: 'u1', isPlaceholder: false, hasLinkedIdentity: false });
    // findUsersByEmail's lower(email) = lower(...) query, with the address as its parameter
    expect(db.$queryRaw.mock.calls[0]?.join(' ')).toContain('lower(email) = lower(');
    expect(db.$queryRaw.mock.calls[0]).toContain('alice@example.com');
  });

  test('reports a placeholder or deleted user as such', async () => {
    const { client } = mockDb({
      usersByEmail: [{ id: 'p1', email: 'alice@example.com', isPlaceholder: true }],
    });
    expect((await gatherOidcFacts(client, INPUT)).userByEmail).toMatchObject({ id: 'p1', isPlaceholder: true });
  });

  test.each(['oidc', 'google'])('reports a matched user with a linked %s identity as linked', async (provider) => {
    const { db, client } = mockDb({
      usersByEmail: [{ id: 'u1', email: 'alice@example.com', isPlaceholder: false }],
      accounts: [{ userId: 'u1', provider }],
    });
    expect((await gatherOidcFacts(client, INPUT)).userByEmail).toEqual({
      id: 'u1',
      isPlaceholder: false,
      hasLinkedIdentity: true,
    });
    // Only whether a row exists: not the stored OAuth tokens.
    expect(db.account.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { id: true } });
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

  test('reports ambiguous email matches, however many case variants there are', async () => {
    const { client } = mockDb({
      usersByEmail: [
        { id: 'u1', email: 'Alice@example.com', isPlaceholder: false },
        { id: 'u2', email: 'ALICE@example.com', isPlaceholder: false },
        { id: 'u3', email: 'alice@EXAMPLE.com', isPlaceholder: false },
      ],
    });
    expect((await gatherOidcFacts(client, INPUT)).userByEmail).toBe('ambiguous');
  });

  test.each([null, ''])('skips the email lookup when the IdP sent the email %j', async (email) => {
    const { db, client } = mockDb({});
    const facts = await gatherOidcFacts(client, { ...INPUT, email });
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
    const facts = await gatherOidcFacts(client, {
      ...INPUT,
      autoRegister: false,
      allowEmailLinking: true,
      emailVerified: false,
    });
    expect(facts).toMatchObject({
      autoRegister: false,
      allowEmailLinking: true,
      email: 'alice@example.com',
      emailVerified: false,
    });
  });
});

describe('checkOidcSignIn', () => {
  const INPUT = {
    providerAccountId: 'sub-1',
    email: 'alice@example.com',
    emailVerified: null,
    sessionUserId: null,
    autoRegister: true,
    allowEmailLinking: false,
    passwordLogin: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each([
    ['the linked-identity lookup', 'account'],
    ['the signed-in user lookup', 'user'],
    ['the email lookup', 'email'],
    ["the matched account's identity lookup", 'identity'],
    ['the Registration setting', 'setting'],
  ] as const)('fails closed: a database error in %s refuses the sign-in instead of allowing it', async (_, lookup) => {
    const { db, client } = mockDb({
      sessionUser: { id: 'u9' },
      usersByEmail: [{ id: 'u1', email: 'alice@example.com', isPlaceholder: false }],
    });
    const lost = new Error('connection lost');
    if (lookup === 'account') db.account.findUnique.mockRejectedValue(lost);
    if (lookup === 'user') db.user.findUnique.mockRejectedValue(lost);
    if (lookup === 'email') db.$queryRaw.mockRejectedValue(lost);
    if (lookup === 'identity') db.account.findFirst.mockRejectedValue(lost);
    if (lookup === 'setting') db.systemSetting.findUnique.mockRejectedValue(lost);
    const input = { ...INPUT, sessionUserId: 'u9', allowEmailLinking: true };
    await expect(checkOidcSignIn(client, input)).rejects.toThrow('connection lost');
  });

  test('returns true for an allowed sign-in', async () => {
    expect(await checkOidcSignIn(mockDb({}).client, INPUT)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('redirects a denial to the login page with its code and logs it', async () => {
    const { client } = mockDb({ sessionUser: { id: 'u9' } });
    expect(await checkOidcSignIn(client, { ...INPUT, sessionUserId: 'u9' })).toBe('/login?error=OidcSessionActive');
    expect(logger.warn).toHaveBeenCalledWith('auth.oidc_denied', {
      error: 'OidcSessionActive',
      email: 'alice@example.com',
    });
  });

  test("logs why an existing account wasn't linked", async () => {
    const { client } = mockDb({ usersByEmail: [{ id: 'u1', email: 'alice@example.com', isPlaceholder: false }] });
    expect(await checkOidcSignIn(client, INPUT)).toBe('/login?error=OidcAccountNotLinked');
    expect(logger.warn).toHaveBeenCalledWith('auth.oidc_denied', {
      error: 'OidcAccountNotLinked',
      reason: 'linking_disabled',
      email: 'alice@example.com',
    });
  });

  test.each([
    ['OidcEmailMissing', { email: null }],
    ['OidcRegistrationDisabled', { autoRegister: false }],
  ])('redirects an %s denial to the login page', async (code, input) => {
    expect(await checkOidcSignIn(mockDb({}).client, { ...INPUT, ...input })).toBe(`/login?error=${code}`);
  });

  test('never links a placeholder or deleted user, with linking on', async () => {
    const { client } = mockDb({
      usersByEmail: [{ id: 'p1', email: 'alice@example.com', isPlaceholder: true }],
    });
    const input = { ...INPUT, allowEmailLinking: true, passwordLogin: false };
    expect(await checkOidcSignIn(client, input)).toBe('/login?error=OidcAccountNotLinked');
    expect(logger.warn).toHaveBeenCalledWith('auth.oidc_denied', {
      error: 'OidcAccountNotLinked',
      reason: 'placeholder',
      email: 'alice@example.com',
    });
  });

  test('logs already_linked for an account made through Google, with linking on', async () => {
    const { client } = mockDb({
      usersByEmail: [{ id: 'u1', email: 'alice@example.com', isPlaceholder: false }],
      accounts: [{ userId: 'u1', provider: 'google' }],
    });
    const input = { ...INPUT, allowEmailLinking: true, passwordLogin: false };
    expect(await checkOidcSignIn(client, input)).toBe('/login?error=OidcAccountNotLinked');
    expect(logger.warn).toHaveBeenCalledWith('auth.oidc_denied', {
      error: 'OidcAccountNotLinked',
      reason: 'already_linked',
      email: 'alice@example.com',
    });
  });
});

describe('decideOidcSignIn across the email_verified values IdPs send', () => {
  test.each([true, null, false])('email_verified %s', (emailVerified) => {
    const base = { ...NEW_IDENTITY, emailVerified, allowEmailLinking: true };
    const sessionActive = { allow: false, error: 'OidcSessionActive' };
    // Another user is signed in: nothing may be attached to them.
    expect(decideOidcSignIn({ ...base, sessionUserId: 'user-2' })).toEqual(sessionActive);
    expect(decideOidcSignIn({ ...base, sessionUserId: 'user-2', userByEmail: EXISTING_USER })).toEqual(sessionActive);
    expect(
      decideOidcSignIn({ ...base, sessionUserId: 'user-2', userByEmail: EXISTING_USER, autoRegister: false }),
    ).toEqual(sessionActive);
    expect(
      decideOidcSignIn({
        ...base,
        sessionUserId: 'user-2',
        passwordRegistrationOpen: true,
        userByEmail: EXISTING_USER,
      }),
    ).toEqual(sessionActive);
    expect(decideOidcSignIn({ ...NEW_IDENTITY, emailVerified, email: null })).toEqual({
      allow: false,
      error: 'OidcEmailMissing',
    });
    // Auto-register off: no new account.
    expect(decideOidcSignIn({ ...NEW_IDENTITY, emailVerified, autoRegister: false })).toEqual({
      allow: false,
      error: 'OidcRegistrationDisabled',
    });
    // Several case variants of the address: no way to pick one.
    expect(decideOidcSignIn({ ...base, userByEmail: 'ambiguous' })).toEqual({
      allow: false,
      error: 'OidcAccountNotLinked',
      reason: 'ambiguous_email',
    });
  });
});

test('gatherOidcFacts looks the signed-in user up by the session id', async () => {
  const { db, client } = mockDb({ sessionUser: { id: 'u9' } });
  const input = {
    providerAccountId: 'sub-1',
    email: 'alice@example.com',
    emailVerified: null,
    sessionUserId: 'u9',
    autoRegister: true,
    allowEmailLinking: false,
    passwordLogin: true,
  };
  await gatherOidcFacts(client, input);
  expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u9' } }));
});
