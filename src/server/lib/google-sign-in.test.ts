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
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, linkedUserId: 'user-1', sessionUserId: 'user-1' })).toEqual({
      allow: true,
    });
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

  test('denies an unlinked Google account whose email already has a ShareTab account', () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, emailTaken: true })).toEqual({
      allow: false,
      error: 'GoogleAccountExists',
    });
  });

  test("creates the ADMIN_EMAIL account only when Google hosts the address, since it can't vouch for who holds another provider's mailbox now", () => {
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true })).toEqual({
      allow: false,
      error: 'GoogleAdminEmailNotHosted',
    });
    expect(decideGoogleSignIn({ ...NEW_ACCOUNT, isAdminEmail: true, emailHostedByGoogle: true })).toEqual({
      allow: true,
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
    ['a Gmail address', 'alice@gmail.com', {}, true],
    ['a Workspace account (hd claim)', 'alice@corp.example', { hd: 'corp.example' }, true],
    ['an address at another provider', 'alice@outlook.com', {}, false],
    ['an empty hd claim', 'alice@outlook.com', { hd: '' }, false],
    ['a Gmail address in capitals', 'Alice@GMAIL.com', {}, true],
  ])('Google hosts %s: %s', async (_, email, extraClaims, hosted) => {
    const facts = await gatherGoogleFacts(mockDb({}).client, {
      ...INPUT,
      email,
      claims: { ...INPUT.claims, email, ...extraClaims },
    });
    expect(facts.emailHostedByGoogle).toBe(hosted);
  });

  test.each([
    [null, false],
    ['', false],
    ['bob@example.com', false],
    ['alice@example.com', true],
    [' Alice@Example.com ', true],
  ])('ADMIN_EMAIL %s is this email: %s', async (adminEmail, isAdmin) => {
    expect((await gatherGoogleFacts(mockDb({}).client, { ...INPUT, adminEmail })).isAdminEmail).toBe(isAdmin);
  });

  test('looks the email up case-insensitively and reports it taken when a user has it', async () => {
    const { db, client } = mockDb({ usersByEmail: [{ id: 'u1', email: 'Alice@example.com' }] });
    expect((await gatherGoogleFacts(client, INPUT)).emailTaken).toBe(true);
    // findUsersByEmail's lower(email) = lower(...) query, with the address as its parameter
    expect(db.$queryRaw.mock.calls[0]?.join(' ')).toContain('lower(email) = lower(');
    expect(db.$queryRaw.mock.calls[0]).toContain('alice@example.com');
  });

  test('skips the email lookup when Google sent no email', async () => {
    const { db, client } = mockDb({});
    expect((await gatherGoogleFacts(client, { ...INPUT, email: null })).emailTaken).toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
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
    expect(logger.warn).toHaveBeenCalledWith('auth.google_denied', { error: code, email: 'alice@example.com' });
  });

  test.each([
    ['a Gmail address', 'admin@gmail.com', {}],
    ['a Workspace account', 'admin@corp.example', { hd: 'corp.example' }],
  ])('lets %s create the ADMIN_EMAIL account', async (_, email, extraClaims) => {
    const input = { ...INPUT, email, claims: { ...INPUT.claims, email, ...extraClaims }, adminEmail: email };
    expect(await checkGoogleSignIn(mockDb({}).client, input)).toBe(true);
  });
});
