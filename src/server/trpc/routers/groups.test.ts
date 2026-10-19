import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  group: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  groupMember: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  groupInvite: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  expense: { count: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  expenseShare: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  settlement: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  receipt: { updateMany: vi.fn() },
  receiptItem: { findMany: vi.fn() },
  receiptItemAssignment: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller(userId = 'owner') {
  const { groupsRouter } = await import('./groups');
  const ctx = { session: { user: { id: userId } }, db: mockDb, headers: new Headers(), impersonating: null };
  return groupsRouter.createCaller(ctx as unknown as Parameters<typeof groupsRouter.createCaller>[0]);
}

beforeEach(() => {
  vi.resetAllMocks();
  // protectedProcedure looks the caller up; groupMemberProcedure checks membership.
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.groupMember.findUnique.mockResolvedValue({ role: 'OWNER', userId: 'owner', groupId: 'g1' });
  mockDb.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? arg(mockDb) : Promise.all(arg as Promise<unknown>[]),
  );
  // The merge locks the target's membership row; it's there unless a test says otherwise
  mockDb.$queryRaw.mockResolvedValue([{ id: 'gm-target' }]);
});

describe('group and placeholder names are trimmed', () => {
  test('create refuses a group name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.create({ name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.group.create).not.toHaveBeenCalled();
  });

  test('create stores the group name without surrounding whitespace', async () => {
    mockDb.group.create.mockResolvedValue({ id: 'g1', name: 'Trip' });
    const api = await caller();
    await api.create({ name: '  Trip  ' });
    expect(mockDb.group.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Trip' }) }),
    );
  });

  test('update refuses a group name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.update({ groupId: 'g1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.group.update).not.toHaveBeenCalled();
  });

  test('addPlaceholder refuses a name that is only whitespace', async () => {
    const api = await caller();
    await expect(api.addPlaceholder({ groupId: 'g1', name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  test('addPlaceholder stores the name without surrounding whitespace', async () => {
    mockDb.user.create.mockResolvedValue({ id: 'p1', name: 'Dave' });
    const api = await caller();
    await api.addPlaceholder({ groupId: 'g1', name: '  Dave  ' });
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Dave', placeholderName: 'Dave' }) }),
    );
  });

  test('renamePlaceholder refuses a name that is only whitespace', async () => {
    // The caller lookup, then the placeholder lookup: without the trim the rename would go through.
    mockDb.user.findUnique
      .mockResolvedValueOnce({ suspendedAt: null })
      .mockResolvedValueOnce({ id: 'p1', isPlaceholder: true });
    const api = await caller();
    await expect(api.renamePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', name: '   ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});

describe('invites', () => {
  const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const validInvite = () => ({
    usedAt: null,
    expiresAt: inAWeek(),
    group: { name: 'Ski Trip', _count: { members: 4 } },
    createdBy: { name: 'Alice', isPlaceholder: false, suspendedAt: null },
  });

  test('createInvite records who made the invite', async () => {
    mockDb.groupInvite.create.mockResolvedValue({ token: 't1' });
    const api = await caller();
    await api.createInvite({ groupId: 'g1' });
    expect(mockDb.groupInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: 'owner' }) }),
    );
  });

  test('getInvite returns the group name, inviter and member count', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue(validInvite());
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toEqual({
      groupName: 'Ski Trip',
      inviterName: 'Alice',
      memberCount: 4,
      placeholderName: null,
    });
    expect(mockDb.groupInvite.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { token: 't1' } }));
  });

  test('getInvite returns null for a token that matches no invite', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue(null);
    const api = await caller();
    await expect(api.getInvite({ token: 'nope' })).resolves.toBeNull();
  });

  test('getInvite returns null for an invite that was already used', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), usedAt: new Date() });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toBeNull();
  });

  test('getInvite returns null for an expired invite', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), expiresAt: new Date(Date.now() - 1000) });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toBeNull();
  });

  test('getInvite has no inviter for an invite made before inviters were recorded', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), createdBy: null });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ groupName: 'Ski Trip', inviterName: null });
  });

  test('getInvite has no inviter once the inviter is a placeholder (a deleted account)', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      ...validInvite(),
      // admin.deleteUser also suspends the account; leave that out to pin the placeholder check on its own
      createdBy: { name: 'Deleted user', isPlaceholder: true, suspendedAt: null },
    });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ inviterName: null });
  });

  test('getInvite has no inviter while the inviter is suspended', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      ...validInvite(),
      createdBy: { name: 'Mallory', isPlaceholder: false, suspendedAt: new Date() },
    });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ inviterName: null });
  });

  test('getInvite and joinByInvite refuse a token longer than 64 characters without a lookup', async () => {
    const api = await caller();
    const token = 'x'.repeat(65);
    await expect(api.getInvite({ token })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.joinByInvite({ token })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.groupInvite.findUnique).not.toHaveBeenCalled();
  });

  // #276: the link would only fail once someone accepted it
  test.each([
    ['a deleted account', { suspendedAt: new Date(), isPlaceholder: true }, null],
    ['a placeholder in an archived group', { suspendedAt: null, isPlaceholder: true }, new Date()],
  ])('createInvite refuses a claim link for %s', async (_, placeholder, archivedAt) => {
    mockDb.user.findUnique.mockResolvedValueOnce({ suspendedAt: null }).mockResolvedValueOnce(placeholder);
    mockDb.group.findUnique.mockResolvedValue({ archivedAt });
    const api = await caller();
    await expect(api.createInvite({ groupId: 'g1', placeholderUserId: 'p1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockDb.groupInvite.create).not.toHaveBeenCalled();
  });

  // #276: accepting a link made for a placeholder takes over their expenses and
  // payments, so the invite page says whose.
  test('getInvite names the placeholder a claim link hands over', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), groupId: 'g1', placeholderUserId: 'p1' });
    mockDb.user.findUnique
      .mockResolvedValueOnce({ suspendedAt: null })
      .mockResolvedValueOnce({ isPlaceholder: true, placeholderName: 'Bob', name: 'Bob' });
    mockDb.groupMember.findUnique.mockResolvedValue({ id: 'gm-p1', userId: 'p1', groupId: 'g1' });
    const api = await caller('bob');
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ placeholderName: 'Bob' });
  });

  // A claim link is for that placeholder only; once they're merged or removed it's dead
  test('getInvite treats a claim link whose placeholder is gone as invalid', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ ...validInvite(), groupId: 'g1', placeholderUserId: 'p1' });
    mockDb.user.findUnique.mockResolvedValueOnce({ suspendedAt: null }).mockResolvedValueOnce(null);
    const api = await caller('bob');
    await expect(api.getInvite({ token: 't1' })).resolves.toBeNull();
  });

  test('joinByInvite refuses a claim link whose placeholder is gone, without joining', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      id: 'i1',
      groupId: 'g1',
      usedAt: null,
      expiresAt: inAWeek(),
      placeholderUserId: 'p1',
    });
    // Merged into someone else through another link: the user row is gone
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? null : { suspendedAt: null, isPlaceholder: false },
    );
    mockDb.groupMember.findUnique.mockResolvedValue(null);
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: 1 });
    const api = await caller('mallory');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.groupMember.create).not.toHaveBeenCalled();
  });

  test('joinByInvite refuses an invite someone else redeemed first, without joining', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({ id: 'i1', groupId: 'g1', usedAt: null, expiresAt: inAWeek() });
    mockDb.groupMember.findUnique.mockResolvedValue(null);
    // Redeemed between the lookup and the claim
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: 0 });
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.groupInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'i1', usedAt: null, expiresAt: { gte: expect.any(Date) } } }),
    );
    expect(mockDb.groupMember.create).not.toHaveBeenCalled();
  });

  // Not a member when the invite is looked up; a member by the time the claim fails
  function claimFailsAfterJoining(usedById: string) {
    mockDb.groupInvite.findUnique
      .mockResolvedValueOnce({ id: 'i1', groupId: 'g1', usedAt: null, expiresAt: inAWeek(), placeholderUserId: 'p1' })
      .mockResolvedValue({ usedById });
    mockDb.groupMember.findUnique.mockResolvedValueOnce(null).mockResolvedValue({ id: 'gm-bob', userId: 'bob' });
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: 0 });
  }

  test('joinByInvite answers a second submit of the same join as already a member', async () => {
    claimFailsAfterJoining('bob');
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).resolves.toEqual({ groupId: 'g1', alreadyMember: true });
    expect(mockDb.groupMember.create).not.toHaveBeenCalled();
  });

  // They joined through another link meanwhile, and someone else took this one (and its placeholder)
  test('joinByInvite tells someone who lost the invite to another person that it is gone, even if they joined meanwhile', async () => {
    claimFailsAfterJoining('charlie');
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // An admin merged the placeholder between this request's check and its merge
  test('joinByInvite does not join a first-time claimant whose placeholder went to someone else', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      id: 'i1',
      groupId: 'g1',
      usedAt: null,
      expiresAt: inAWeek(),
      placeholderUserId: 'p1',
    });
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? { suspendedAt: null, isPlaceholder: true } : { suspendedAt: null, isPlaceholder: false },
    );
    mockDb.groupMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId_groupId: { userId: string } } }) =>
        where.userId_groupId.userId === 'p1' ? { id: 'gm-p1', userId: 'p1', groupId: 'g1' } : null,
    );
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: 1 });
    // The merge finds the placeholder's membership already gone
    mockDb.groupMember.deleteMany.mockResolvedValue({ count: 0 });
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('joinByInvite answers a retry of a join that already went through as already a member', async () => {
    // The first request joined them and used the invite; its answer never arrived
    mockDb.groupInvite.findUnique.mockResolvedValue({
      id: 'i1',
      groupId: 'g1',
      usedAt: new Date(),
      usedById: 'bob',
      expiresAt: inAWeek(),
    });
    mockDb.groupMember.findUnique.mockResolvedValue({ id: 'gm-bob', userId: 'bob' });
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).resolves.toEqual({ groupId: 'g1', alreadyMember: true });
    expect(mockDb.groupInvite.updateMany).not.toHaveBeenCalled();
  });

  function memberOpensClaimLink({ claimed, usedById }: { claimed: boolean; usedById?: string }) {
    mockDb.groupInvite.findUnique
      .mockResolvedValueOnce({ id: 'i1', groupId: 'g1', usedAt: null, expiresAt: inAWeek(), placeholderUserId: 'p1' })
      .mockResolvedValue({ usedById: usedById ?? null });
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? { suspendedAt: null, isPlaceholder: true } : { suspendedAt: null, isPlaceholder: false },
    );
    mockDb.groupMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId_groupId: { userId: string } } }) => ({
        id: `gm-${where.userId_groupId.userId}`,
        userId: where.userId_groupId.userId,
        groupId: 'g1',
      }),
    );
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: claimed ? 1 : 0 });
  }

  test('joinByInvite tells a member who lost a claim link to someone else that the link is gone', async () => {
    memberOpensClaimLink({ claimed: false, usedById: 'charlie' });
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
  });

  test('joinByInvite tells a member that a claim link is gone once its placeholder was merged elsewhere', async () => {
    memberOpensClaimLink({ claimed: true, usedById: 'charlie' });
    // The placeholder's user row is gone (merged through another link)
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? null : { suspendedAt: null, isPlaceholder: false },
    );
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.groupInvite.updateMany).not.toHaveBeenCalled();
  });

  test("joinByInvite answers a member's second submit of their own claim as done", async () => {
    memberOpensClaimLink({ claimed: false, usedById: 'bob' });
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).resolves.toEqual({ groupId: 'g1', alreadyMember: true });
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
  });

  test('joinByInvite does not hand a placeholder to a member who left before the claim went through', async () => {
    memberOpensClaimLink({ claimed: true });
    // In the group when the request starts; the merge's lock finds no membership row
    mockDb.$queryRaw.mockResolvedValue([]);
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    // A share lock, so a removal waits for the merge instead of slipping in after the check
    const [sql, ...values] = mockDb.$queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toMatch(/FROM "GroupMember" WHERE "userId" = \? AND "groupId" = \? FOR SHARE/);
    expect(values).toEqual(['bob', 'g1']);
  });

  // The person joined through a plain link first, then the admin sent them the claim link.
  test('joinByInvite with a claim link hands the placeholder to someone already in the group', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      id: 'i1',
      groupId: 'g1',
      usedAt: null,
      expiresAt: inAWeek(),
      placeholderUserId: 'p1',
    });
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? { suspendedAt: null, isPlaceholder: true } : { suspendedAt: null, isPlaceholder: false },
    );
    mockDb.groupMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId_groupId: { userId: string } } }) => ({
        id: `gm-${where.userId_groupId.userId}`,
        userId: where.userId_groupId.userId,
        groupId: 'g1',
      }),
    );
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: 1 });
    mockDb.groupMember.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.expenseShare.findMany.mockResolvedValue([]);
    mockDb.receiptItem.findMany.mockResolvedValue([]);
    mockDb.groupMember.count.mockResolvedValue(0);
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).resolves.toEqual({ groupId: 'g1', alreadyMember: true });
    expect(mockDb.groupInvite.updateMany).toHaveBeenCalled();
    expect(mockDb.groupMember.create).not.toHaveBeenCalled();
    expect(mockDb.expense.updateMany).toHaveBeenCalledWith({
      where: { paidById: 'p1', groupId: 'g1' },
      data: { paidById: 'bob' },
    });
  });

  test('joinByInvite with a claim link joins and takes over the placeholder in one transaction', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue({
      id: 'i1',
      groupId: 'g1',
      usedAt: null,
      expiresAt: inAWeek(),
      placeholderUserId: 'p1',
    });
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? { suspendedAt: null, isPlaceholder: true } : { suspendedAt: null, isPlaceholder: false },
    );
    // Bob isn't a member until the transaction adds him
    let bobJoined = false;
    mockDb.groupMember.create.mockImplementation(async () => (bobJoined = true));
    mockDb.groupMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId_groupId: { userId: string } } }) => {
        const userId = where.userId_groupId.userId;
        return userId === 'p1' || bobJoined ? { id: `gm-${userId}`, userId, groupId: 'g1' } : null;
      },
    );
    mockDb.groupInvite.updateMany.mockResolvedValue({ count: 1 });
    mockDb.groupMember.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.expenseShare.findMany.mockResolvedValue([]);
    mockDb.receiptItem.findMany.mockResolvedValue([]);
    mockDb.groupMember.count.mockResolvedValue(0);
    const api = await caller('bob');
    await expect(api.joinByInvite({ token: 't1' })).resolves.toEqual({ groupId: 'g1', alreadyMember: false });
    expect(mockDb.groupMember.create).toHaveBeenCalledWith({ data: { userId: 'bob', groupId: 'g1' } });
    expect(mockDb.expense.updateMany).toHaveBeenCalledWith({
      where: { paidById: 'p1', groupId: 'g1' },
      data: { paidById: 'bob' },
    });
    expect(mockDb.user.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  test('getInvite allows 30 lookups a minute per user, then refuses without a lookup', async () => {
    mockDb.groupInvite.findUnique.mockResolvedValue(null);
    const api = await caller('prober');
    for (let i = 0; i < 30; i++) await api.getInvite({ token: `guess-${i}` });
    await expect(api.getInvite({ token: 'guess-30' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockDb.groupInvite.findUnique).toHaveBeenCalledTimes(30);
    // Another user's budget is separate
    await expect((await caller('someone-else')).getInvite({ token: 'guess-0' })).resolves.toBeNull();
  });
});

// #260: removing a placeholder moved their shares onto each expense's payer,
// their expenses onto the acting admin, and deleted their settlements, so
// whatever they owed or were owed vanished from everyone else's balance.
describe('removing a placeholder', () => {
  function setUp({ shares = 0, expenses = 0, settlements = 0 } = {}) {
    // The caller lookup and membership check, then the target's membership and user rows.
    mockDb.groupMember.findUnique
      .mockResolvedValueOnce({ role: 'OWNER', userId: 'owner', groupId: 'g1' })
      .mockResolvedValueOnce({ id: 'gm-p1', role: 'MEMBER', userId: 'p1', groupId: 'g1' });
    mockDb.user.findUnique
      .mockResolvedValueOnce({ suspendedAt: null })
      .mockResolvedValueOnce({ isPlaceholder: true, name: 'Alice', placeholderName: 'Alice' });
    mockDb.expenseShare.count.mockResolvedValue(shares);
    mockDb.expense.count.mockResolvedValue(expenses);
    mockDb.settlement.count.mockResolvedValue(settlements);
    // Read by the old cleanup, which looked up the shares to move
    mockDb.expenseShare.findMany.mockResolvedValue([]);
  }

  function expectNothingChanged() {
    expect(mockDb.expenseShare.update).not.toHaveBeenCalled();
    expect(mockDb.expenseShare.create).not.toHaveBeenCalled();
    expect(mockDb.expenseShare.delete).not.toHaveBeenCalled();
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.groupMember.delete).not.toHaveBeenCalled();
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  }

  // Even at a zero balance: moving their part onto others shifts who owes
  // whom, and a removed member's balance can come back with nobody able to
  // settle it.
  test.each([
    ['has a share in an expense', { shares: 1 }],
    ['paid an expense', { expenses: 1 }],
    ['is in a settlement', { settlements: 1 }],
  ])('is refused when the placeholder %s', async (_, history) => {
    setUp(history);
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "Alice is in expenses or payments in this group, so they can't be removed. Take them out of those first.",
    });
    expectNothingChanged();
  });

  test('deletes a placeholder who was never in an expense or payment', async () => {
    setUp();
    const api = await caller();
    await expect(api.removeMember({ groupId: 'g1', userId: 'p1' })).resolves.toEqual({ success: true });
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
    // Their activity-log entries stay (the user link is cleared by the database)
    expect(mockDb.activityLog.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.receiptItemAssignment.deleteMany).toHaveBeenCalledWith({ where: { userId: 'p1' } });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'MEMBER_LEFT' }) }),
    );
    expect(mockDb.user.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });
});

// #276: merging a placeholder into the member it stands for moves their
// expenses, shares and payments over, so the balance follows them.
describe('merging a placeholder into a member', () => {
  const users: Record<string, { suspendedAt: null; isPlaceholder: boolean }> = {
    owner: { suspendedAt: null, isPlaceholder: false },
    bob: { suspendedAt: null, isPlaceholder: false },
    p1: { suspendedAt: null, isPlaceholder: true },
    p2: { suspendedAt: null, isPlaceholder: true },
  };
  // admin.deleteUser turns an account into a suspended placeholder that keeps its history in other groups
  const deletedAccount = { suspendedAt: new Date(), isPlaceholder: true };

  beforeEach(() => {
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => users[where.id] ?? null);
    mockDb.groupMember.findUnique.mockImplementation(
      async ({ where }: { where: { userId_groupId: { userId: string } } }) => {
        const userId = where.userId_groupId.userId;
        return { id: `gm-${userId}`, role: userId === 'owner' ? 'OWNER' : 'MEMBER', userId, groupId: 'g1' };
      },
    );
    mockDb.groupMember.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.expenseShare.findMany.mockResolvedValue([]);
    mockDb.receiptItem.findMany.mockResolvedValue([]);
    mockDb.groupMember.count.mockResolvedValue(0);
  });

  function expectNothingMoved() {
    expect(mockDb.expenseShare.update).not.toHaveBeenCalled();
    expect(mockDb.expense.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.updateMany).not.toHaveBeenCalled();
    expect(mockDb.settlement.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.user.delete).not.toHaveBeenCalled();
  }

  test('refuses to merge a placeholder into itself', async () => {
    const api = await caller();
    await expect(
      api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'p1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expectNothingMoved();
  });

  test('refuses to merge a placeholder into another placeholder', async () => {
    const api = await caller();
    await expect(
      api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'p2' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expectNothingMoved();
  });

  test('refuses to merge a deleted account', async () => {
    mockDb.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'p1' ? deletedAccount : (users[where.id] ?? null),
    );
    const api = await caller();
    await expect(
      api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expectNothingMoved();
  });

  // An archived group refuses changes to its expenses and payments, and a merge rewrites both.
  test('refuses to merge in an archived group', async () => {
    mockDb.group.findUnique.mockResolvedValue({ archivedAt: new Date() });
    const api = await caller();
    await expect(
      api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('archived') });
    expectNothingMoved();
  });

  // Two merges of one placeholder (an admin's merge and a claim link, say): the
  // second waits on the first's lock on the membership, then finds it gone.
  test('a merge that finds the placeholder already merged moves nothing', async () => {
    mockDb.groupMember.deleteMany.mockResolvedValue({ count: 0 });
    const api = await caller();
    await expect(
      api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expectNothingMoved();
  });

  test('moves the payer of a receipt saved for later to the member', async () => {
    const api = await caller();
    await api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' });
    expect(mockDb.receipt.updateMany).toHaveBeenCalledWith({
      where: { paidById: 'p1', OR: [{ groupId: 'g1' }, { expense: { groupId: 'g1' } }] },
      data: { paidById: 'bob' },
    });
  });

  test('moves a share only the placeholder had to the member', async () => {
    mockDb.expenseShare.findMany.mockResolvedValue([
      {
        id: 's-p1',
        expenseId: 'e1',
        userId: 'p1',
        amount: 500,
        shares: 1,
        percentage: null,
        expense: { splitMode: 'EQUAL' },
      },
    ]);
    mockDb.expenseShare.findUnique.mockResolvedValue(null);
    const api = await caller();
    await api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' });
    expect(mockDb.expenseShare.update).toHaveBeenCalledWith({ where: { id: 's-p1' }, data: { userId: 'bob' } });
    expect(mockDb.expense.update).not.toHaveBeenCalled();
  });

  // Recomputing units or percentages for the merged person can land a cent away
  // from what's stored, so the expense keeps the stored amounts as exact ones.
  test('an expense both were in becomes an exact split of the stored amounts', async () => {
    mockDb.expenseShare.findMany.mockResolvedValue([
      {
        id: 's-p1',
        expenseId: 'e1',
        userId: 'p1',
        amount: 333,
        shares: 1,
        percentage: null,
        expense: { splitMode: 'EQUAL' },
      },
    ]);
    mockDb.expenseShare.findUnique.mockResolvedValue({
      id: 's-bob',
      expenseId: 'e1',
      userId: 'bob',
      amount: 333,
      shares: 1,
      percentage: null,
    });
    const api = await caller();
    await api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' });
    expect(mockDb.expenseShare.delete).toHaveBeenCalledWith({ where: { id: 's-p1' } });
    expect(mockDb.expenseShare.update).toHaveBeenCalledWith({
      where: { id: 's-bob' },
      data: { amount: 666, shares: 1, percentage: null },
    });
    expect(mockDb.expense.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { splitMode: 'EXACT' } });
  });

  test('drops payments between the placeholder and the member, which would become payments to themselves', async () => {
    const api = await caller();
    await api.mergePlaceholder({ groupId: 'g1', placeholderUserId: 'p1', realUserId: 'bob' });
    expect(mockDb.settlement.deleteMany).toHaveBeenCalledWith({
      where: {
        groupId: 'g1',
        OR: [
          { fromId: 'p1', toId: 'bob' },
          { fromId: 'bob', toId: 'p1' },
        ],
      },
    });
    // Before the placeholder's other payments move over
    expect(mockDb.settlement.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.settlement.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(mockDb.settlement.updateMany).toHaveBeenCalledWith({
      where: { fromId: 'p1', groupId: 'g1' },
      data: { fromId: 'bob' },
    });
  });
});

// #275: archiving hid a group's open balances from the dashboard, and an
// archived group refuses settlements, so the debt was frozen out of sight.
describe('archiving a group', () => {
  const expense = (paidById: string, shares: { userId: string; amount: number }[]) => ({
    paidById,
    amount: shares.reduce((sum, s) => sum + s.amount, 0),
    baseCurrencyAmount: null,
    shares,
  });
  // The owner paid $10.00 split with Bob, so Bob owes the owner $5.00.
  const bobOwesHalf = [
    expense('owner', [
      { userId: 'owner', amount: 500 },
      { userId: 'bob', amount: 500 },
    ]),
  ];
  // Calls made inside the archive's transaction, in order
  let inTransaction: string[] | null = null;
  const track = (name: string) => () => inTransaction?.push(name);

  beforeEach(() => {
    inTransaction = null;
    mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => {
      inTransaction = [];
      return fn(mockDb);
    });
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'owner' }, { userId: 'bob' }]);
    mockDb.group.updateMany.mockImplementation(async () => (track('archive')(), { count: 1 }));
    mockDb.group.findUnique.mockResolvedValue({ id: 'g1', name: 'Trip', archivedAt: new Date() });
    mockDb.expense.findMany.mockImplementation(async () => (track('read expenses')(), bobOwesHalf));
    mockDb.settlement.findMany.mockImplementation(async () => (track('read payments')(), []));
  });

  test('is refused while anyone in the group owes money', async () => {
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'This group still has unsettled balances. Settle up before archiving it.',
    });
    expect(mockDb.expense.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: 'g1' } }));
    expect(mockDb.settlement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { groupId: 'g1' } }));
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  // Settlements need both people to be members, so "settle up" alone can't
  // clear a balance with someone who has left.
  test('says so when the open balance belongs to someone no longer in the group', async () => {
    mockDb.groupMember.findMany.mockResolvedValue([{ userId: 'owner' }]);
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "Someone who is no longer in this group still owes or is owed money, so it can't be archived. Invite them back to settle up, or edit the expenses they're in.",
    });
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });

  test('goes ahead once everyone is settled up', async () => {
    // Bob paid the owner back.
    mockDb.settlement.findMany.mockResolvedValue([
      { fromId: 'bob', toId: 'owner', amount: 500, baseCurrencyAmount: null },
    ]);
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).resolves.toMatchObject({ id: 'g1', name: 'Trip' });
    expect(mockDb.group.updateMany).toHaveBeenCalledWith({
      where: { id: 'g1', archivedAt: null },
      data: { archivedAt: expect.any(Date) },
    });
    expect(mockDb.activityLog.create).toHaveBeenCalledWith({
      data: { groupId: 'g1', userId: 'owner', type: 'GROUP_ARCHIVED', metadata: { name: 'Trip' } },
    });
  });

  // #289: the balances were read, then the group archived in a separate
  // statement, so an expense or payment written in between left the group
  // archived with a balance nobody could settle. Archiving first takes the
  // group's row lock, which waits for every balance change in flight (each holds
  // the row FOR SHARE) and holds off new ones, so the balances read after it are
  // final, and a refusal throws inside the transaction, undoing the archive.
  test('archives before reading the balances, all in one transaction', async () => {
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(inTransaction).toEqual(['archive', 'read expenses', 'read payments']);
  });

  test('leaves a group archived already as it is', async () => {
    mockDb.group.updateMany.mockResolvedValue({ count: 0 });
    const api = await caller();
    await expect(api.archive({ groupId: 'g1' })).resolves.toMatchObject({ id: 'g1' });
    expect(mockDb.expense.findMany).not.toHaveBeenCalled();
    expect(mockDb.activityLog.create).not.toHaveBeenCalled();
  });
});
