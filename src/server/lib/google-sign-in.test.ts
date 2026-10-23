import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./logger', () => ({ logger }));

import { checkGoogleSignIn, decideGoogleSignIn, gatherGoogleFacts, type GoogleSignInFacts } from './google-sign-in';

const NEW_ACCOUNT: GoogleSignInFacts = {
  linkedUserId: null,
  sessionUserId: null,
  email: 'alice@example.com',
  emailVerified: true,
  emailHostedByGoogle: false,
  isAdminEmail: false,
  emailTaken: false,
  registrationOpen: true,
};

describe('decideGoogleSignIn', () => {
  test('allows a new Google user with a verified email while registration is open', () => {
    expect(decideGoogleSignIn(NEW_ACCOUNT)).toEqual({ allow: true });
  });

  test('allows a linked Google account when nobody is signed in', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, linkedUserId: 'user-1', emailTaken: true })).toEqual({ allow: true });
  });

  test('allows a linked Google account when its own user is already signed in', () => {
    // Its email is taken (by that same user), as it is for every linked account.
    expect(
      decideGoogleSignIn({ ...NEW_ACCOUNT, linkedUserId: 'user-1', sessionUserId: 'user-1', emailTaken: true }),
    ).toEqual({ allow: true });
  });

  test('a linked Google account signs in whatever the email checks and the Registration setting say', () => {
    expect(
      decideGoogleSignIn({
        ...NEW_ACCOUNT,
        linkedUserId: 'user-1',
        email: null,
        emailVerified: false,
        isAdminEmail: true,
        registrationOpen: false,
      }),
    ).toEqual({ allow: true });
  });

  test('denies an unlinked Google account while someone is signed in, so it is not attached to them', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, sessionUserId: 'user-1' })).toEqual({
      allow: false,
      error: 'GoogleSessionActive',
    });
  });

  test('denies a Google account linked to someone else while a different user is signed in', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, linkedUserId: 'user-1', sessionUserId: 'user-2' })).toEqual({
      allow: false,
      error: 'GoogleSessionActive',
    });
  });

  test.each([
    ['unverified', { emailVerified: false }],
    ['without email_verified', { emailVerified: null }],
    ['without an email', { email: null }],
    ['with a blank email', { email: '' }],
  ])('creates no account for a Google user %s', (_, overrides) => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, ...overrides })).toEqual({
      allow: false,
      error: 'GoogleEmailUnverified',
    });
  });

  test('an unverified email is refused before saying whether an account has it', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, emailVerified: false, emailTaken: true })).toEqual({
      allow: false,
      error: 'GoogleEmailUnverified',
    });
  });

  test('the refusals hold at an address Google is authoritative for too: Google never links', () => {
    const hosted = { ...NEW_ACCOUNT, emailHostedByGoogle: true };
    expect(decideGoogleSignIn({ ...hosted, emailTaken: true })).toEqual({ allow: false, error: 'GoogleAccountExists' });
    expect(decideGoogleSignIn({ ...hosted, emailVerified: false })).toEqual({
      allow: false,
      error: 'GoogleEmailUnverified',
    });
    expect(decideGoogleSignIn({ ...hosted, emailVerified: null })).toEqual({
      allow: false,
      error: 'GoogleEmailUnverified',
    });
    expect(decideGoogleSignIn({ ...hosted, isAdminEmail: true, emailVerified: false })).toEqual({
      allow: false,
      error: 'GoogleEmailUnverified',
    });
  });

  test('denies an unlinked Google account whose email already has a ShareTab account', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, emailTaken: true })).toEqual({
      allow: false,
      error: 'GoogleAccountExists',
    });
  });

  test("creates the ADMIN_EMAIL account only at an address Google is authoritative for, since it can't vouch for who holds another provider's mailbox now", () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true })).toEqual({
      allow: false,
      error: 'GoogleAdminEmailNotHosted',
    });
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true, emailHostedByGoogle: true })).toEqual({
      allow: true,
    });
  });

  test('the ADMIN_EMAIL account needs registration open too, even at an address Google is authoritative for', () => {
    expect(
      decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true, emailHostedByGoogle: true, registrationOpen: false }),
    ).toEqual({ allow: false, error: 'GoogleRegistrationDisabled' });
  });

  test('an ADMIN_EMAIL address Google does not host is refused as such while registration is closed too', () => {
    // The admin rule comes first: opening registration wouldn't let this one in.
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true, registrationOpen: false })).toEqual({
      allow: false,
      error: 'GoogleAdminEmailNotHosted',
    });
  });

  test('an existing ADMIN_EMAIL account gets the sign-in-as-usual answer', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true, emailTaken: true })).toEqual({
      allow: false,
      error: 'GoogleAccountExists',
    });
  });

  test('creates no account while the Registration setting is closed or invite-only', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, registrationOpen: false })).toEqual({
      allow: false,
      error: 'GoogleRegistrationDisabled',
    });
  });

  test('a taken email gets the sign-in-as-usual answer even while registration is closed', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, emailTaken: true, registrationOpen: false })).toEqual({
      allow: false,
      error: 'GoogleAccountExists',
    });
  });
});

function mockDb(overrides: {
  account?: { userId: string } | null;
  sessionUser?: { id: string } | null;
  usersByEmail?: { id: string; email: string }[];
  registrationMode?: string;
}) {
  const rows = overrides.usersByEmail ?? [];
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(rows.map(({ id }) => ({ id }))),
    account: { findUnique: vi.fn().mockResolvedValue(overrides.account ?? null) },
    user: {
      findUnique: vi.fn().mockResolvedValue(overrides.sessionUser ?? null),
      findMany: vi.fn().mockResolvedValue(rows),
    },
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(overrides.registrationMode ? { value: overrides.registrationMode } : null),
    },
  };
  return { db, client: db as unknown as PrismaClient };
}

const INPUT = {
  providerAccountId: 'g-1',
  email: 'alice@example.com',
  claims: { sub: 'g-1', email: 'alice@example.com', email_verified: true },
  sessionUserId: null,
  adminEmail: null,
};

describe('gatherGoogleFacts', () => {
  test('reports the user linked to the Google account and the signed-in user', async () => {
    const { db, client } = mockDb({ account: { userId: 'u1' }, sessionUser: { id: 'u9' } });
    const facts = await gatherGoogleFacts(client, { ...INPUT, sessionUserId: 'u9' });
    expect(facts).toMatchObject({ linkedUserId: 'u1', sessionUserId: 'u9' });
    expect(db.account.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_providerAccountId: { provider: 'google', providerAccountId: 'g-1' } },
      }),
    );
  });

  test('reports nobody signed in when the session user row is gone, as Auth.js does', async () => {
    const facts = await gatherGoogleFacts(mockDb({ sessionUser: null }).client, { ...INPUT, sessionUserId: 'gone' });
    expect(facts.sessionUserId).toBeNull();
  });

  test("reads the email's verification from the ID token claims", async () => {
    const { client } = mockDb({});
    expect(await gatherGoogleFacts(client, { ...INPUT, claims: { ...INPUT.claims, email_verified: false } })).toEqual({
      linkedUserId: null,
      sessionUserId: null,
      email: 'alice@example.com',
      emailVerified: false,
      emailHostedByGoogle: false,
      isAdminEmail: false,
      emailTaken: false,
      registrationOpen: true,
    });
  });

  test.each([
    [undefined, null],
    ['true', true],
    [true, true],
  ])('reads email_verified %j as %j', async (emailVerified, expected) => {
    const claims: Record<string, unknown> = { sub: 'g-1', email: 'alice@example.com' };
    if (emailVerified !== undefined) claims['email_verified'] = emailVerified;
    expect((await gatherGoogleFacts(mockDb({}).client, { ...INPUT, claims })).emailVerified).toBe(expected);
  });

  test.each([
    ['a Gmail address', 'alice@gmail.com', {}, true],
    ['a Workspace account (hd claim)', 'alice@corp.example', { hd: 'corp.example' }, true],
    ['an address at another provider', 'alice@outlook.com', {}, false],
    ['an empty hd claim', 'alice@outlook.com', { hd: '' }, false],
    ['a Gmail address in capitals', 'Alice@GMAIL.com', {}, true],
    ['a lookalike domain', 'alice@notgmail.com', {}, false],
    ['gmail.com as a subdomain', 'alice@gmail.com.example', {}, false],
    ['a non-string hd claim', 'alice@outlook.com', { hd: true }, false],
    ['a numeric hd claim', 'alice@outlook.com', { hd: 123 }, false],
    // Legacy Gmail addresses aren't treated as hosted: the stricter answer.
    ['a googlemail.com address', 'alice@googlemail.com', {}, false],
    // hd isn't compared with the address's domain: a Workspace account's
    // address can be on any of its organization's domains, and hd names one.
    ['an hd claim for another domain', 'alice@other.example', { hd: 'corp.example' }, true],
  ])('%s (%s, extra claims %o) counts as hosted by Google: %s', async (_, email, extraClaims, hosted) => {
    const facts = await gatherGoogleFacts(mockDb({}).client, {
      ...INPUT,
      email,
      claims: { ...INPUT.claims, email, ...extraClaims },
    });
    expect(facts.emailHostedByGoogle).toBe(hosted);
  });

  test.each([
    // process.env.ADMIN_EMAIL when it's unset
    [undefined, false],
    [null, false],
    ['', false],
    ['bob@example.com', false],
    // An exact match, not a substring or a prefix.
    ['ice@example.com', false],
    ['alice@example.co', false],
    ['alice@example.com', true],
    [' Alice@Example.com ', true],
  ])('ADMIN_EMAIL %s is this email: %s', async (adminEmail, isAdmin) => {
    expect((await gatherGoogleFacts(mockDb({}).client, { ...INPUT, adminEmail })).isAdminEmail).toBe(isAdmin);
  });

  test('matches ADMIN_EMAIL whatever the letter case of the Google email', async () => {
    const facts = await gatherGoogleFacts(mockDb({}).client, {
      ...INPUT,
      email: 'Admin@Example.com',
      adminEmail: 'admin@example.com',
    });
    expect(facts.isAdminEmail).toBe(true);
  });

  test('looks the email up case-insensitively and reports it taken when a user has it', async () => {
    const { db, client } = mockDb({ usersByEmail: [{ id: 'u1', email: 'Alice@example.com' }] });
    expect((await gatherGoogleFacts(client, INPUT)).emailTaken).toBe(true);
    // findUsersByEmail's lower(email) = lower(...) query, with the address as its parameter
    expect(db.$queryRaw.mock.calls[0]?.join(' ')).toContain('lower(email) = lower(');
    expect(db.$queryRaw.mock.calls[0]).toContain('alice@example.com');
  });

  test('reports the email taken when several accounts have it in different letter cases', async () => {
    const { client } = mockDb({
      usersByEmail: [
        { id: 'u1', email: 'alice@example.com' },
        { id: 'u2', email: 'Alice@example.com' },
      ],
    });
    expect((await gatherGoogleFacts(client, INPUT)).emailTaken).toBe(true);
  });

  test.each([null, ''])('skips the email lookup when Google sent the email %j', async (email) => {
    const { db, client } = mockDb({});
    expect((await gatherGoogleFacts(client, { ...INPUT, email })).emailTaken).toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  test.each([
    [null, undefined],
    [null, ''],
    [null, 'bob@example.com'],
    ['', undefined],
    ['', ''],
  ])('with the email %j, ADMIN_EMAIL %j is not this email', async (email, adminEmail) => {
    expect((await gatherGoogleFacts(mockDb({}).client, { ...INPUT, email, adminEmail })).isAdminEmail).toBe(false);
  });

  // registration-mode.test.ts covers how each stored value reads.
  test.each([
    [undefined, true],
    ['invite-only', false],
  ])('Registration setting %s reads as open: %s', async (registrationMode, open) => {
    const { client } = mockDb(registrationMode === undefined ? {} : { registrationMode });
    expect((await gatherGoogleFacts(client, INPUT)).registrationOpen).toBe(open);
  });
});

describe('checkGoogleSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns true for an allowed sign-in', async () => {
    expect(await checkGoogleSignIn(mockDb({}).client, INPUT)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each([
    ['GoogleSessionActive', { sessionUser: { id: 'u9' } }, { sessionUserId: 'u9' }],
    ['GoogleEmailUnverified', {}, { claims: { ...INPUT.claims, email_verified: false } }],
    ['GoogleAccountExists', { usersByEmail: [{ id: 'u1', email: 'alice@example.com' }] }, {}],
    ['GoogleAdminEmailNotHosted', {}, { adminEmail: 'alice@example.com' }],
    ['GoogleRegistrationDisabled', { registrationMode: 'closed' }, {}],
  ])('redirects a %s denial to the login page with its code and logs it', async (code, db, input) => {
    const { client } = mockDb(db);
    expect(await checkGoogleSignIn(client, { ...INPUT, ...input })).toBe(`/login?error=${code}`);
    expect(logger.warn).toHaveBeenCalledWith('auth.google_denied', {
      error: code,
      email: 'alice@example.com',
      providerAccountId: 'g-1',
    });
  });

  test('refuses a Gmail address that already has an account (it never links, even for Gmail)', async () => {
    const email = 'alice@gmail.com';
    const { client } = mockDb({ usersByEmail: [{ id: 'u1', email }] });
    const input = { ...INPUT, email, claims: { ...INPUT.claims, email } };
    expect(await checkGoogleSignIn(client, input)).toBe('/login?error=GoogleAccountExists');
  });

  test('lets a new Google user in when ADMIN_EMAIL is unset', async () => {
    expect(await checkGoogleSignIn(mockDb({}).client, { ...INPUT, adminEmail: undefined })).toBe(true);
  });

  test('lets a new Google user in from a browser whose session user row is gone', async () => {
    const input = { ...INPUT, sessionUserId: 'gone' };
    expect(await checkGoogleSignIn(mockDb({ sessionUser: null }).client, input)).toBe(true);
  });

  test.each([
    ['the linked-account lookup', 'account'],
    ['the signed-in user lookup', 'user'],
    ['the email lookup', 'email'],
    ['the Registration setting', 'setting'],
  ] as const)('fails closed: a database error in %s refuses the sign-in instead of allowing it', async (_, lookup) => {
    const { db, client } = mockDb({ sessionUser: { id: 'u9' } });
    const lost = new Error('connection lost');
    if (lookup === 'account') db.account.findUnique.mockRejectedValue(lost);
    if (lookup === 'user') db.user.findUnique.mockRejectedValue(lost);
    if (lookup === 'email') db.$queryRaw.mockRejectedValue(lost);
    if (lookup === 'setting') db.systemSetting.findUnique.mockRejectedValue(lost);
    await expect(checkGoogleSignIn(client, { ...INPUT, sessionUserId: 'u9' })).rejects.toThrow('connection lost');
  });

  test.each([
    ['GoogleRegistrationDisabled', { registrationMode: 'closed' }, {}],
    ['GoogleAccountExists', { usersByEmail: [{ id: 'u1', email: 'admin@gmail.com' }] }, {}],
    ['GoogleEmailUnverified', {}, { claims: { sub: 'g-1', email: 'admin@gmail.com' } }],
  ])('refuses the ADMIN_EMAIL address Google hosts with %s, like any other', async (code, db, input) => {
    const email = 'admin@gmail.com';
    const base = { ...INPUT, email, claims: { ...INPUT.claims, email }, adminEmail: email };
    expect(await checkGoogleSignIn(mockDb(db).client, { ...base, ...input })).toBe(`/login?error=${code}`);
  });

  test('refuses a new account when Google sends no email_verified claim at all', async () => {
    const input = { ...INPUT, claims: { sub: 'g-1', email: 'alice@example.com' } };
    expect(await checkGoogleSignIn(mockDb({}).client, input)).toBe('/login?error=GoogleEmailUnverified');
  });

  test.each([
    ['a Gmail address', 'admin@gmail.com', {}],
    ['a Workspace account', 'admin@corp.example', { hd: 'corp.example' }],
  ])('lets %s create the ADMIN_EMAIL account', async (_, email, extraClaims) => {
    const input = { ...INPUT, email, claims: { ...INPUT.claims, email, ...extraClaims }, adminEmail: email };
    expect(await checkGoogleSignIn(mockDb({}).client, input)).toBe(true);
  });
});

describe('decideGoogleSignIn with someone signed in', () => {
  const overrides = [
    ['at an address Google hosts', { emailHostedByGoogle: true }],
    ['with an email that already has an account', { emailTaken: true }],
    ['with an email Google has not verified', { emailVerified: false }],
    ['with the ADMIN_EMAIL address Google hosts', { isAdminEmail: true, emailHostedByGoogle: true }],
    ['while registration is closed', { registrationOpen: false }],
  ] as const;
  test.each(overrides)('refuses an unlinked Google account %s', (_, extra) => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, ...extra, sessionUserId: 'user-2' })).toEqual({
      allow: false,
      error: 'GoogleSessionActive',
    });
  });
  test.each(overrides)('refuses a Google account linked to someone else %s', (_, extra) => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, ...extra, linkedUserId: 'user-1', sessionUserId: 'user-2' })).toEqual({
      allow: false,
      error: 'GoogleSessionActive',
    });
  });
});

test('gatherGoogleFacts looks the signed-in user up by the session id', async () => {
  const { db, client } = mockDb({ sessionUser: { id: 'u9' } });
  await gatherGoogleFacts(client, { ...INPUT, sessionUserId: 'u9' });
  expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u9' } }));
});

test('a new Gmail or Workspace user signs up while registration is open and is refused while it is closed', () => {
  const hosted = { ...NEW_ACCOUNT, emailHostedByGoogle: true };
  expect(decideGoogleSignIn(hosted)).toEqual({ allow: true });
  expect(decideGoogleSignIn({ ...hosted, registrationOpen: false })).toEqual({
    allow: false,
    error: 'GoogleRegistrationDisabled',
  });
});
