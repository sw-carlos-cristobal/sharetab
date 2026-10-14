import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));

const mockDb = {
  user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  group: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  groupMember: { findUnique: vi.fn(), create: vi.fn() },
  groupInvite: { findUnique: vi.fn(), create: vi.fn() },
  activityLog: { create: vi.fn() },
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function caller() {
  const { groupsRouter } = await import('./groups');
  const ctx = { session: { user: { id: 'owner' } }, db: mockDb, headers: new Headers(), impersonating: null };
  return groupsRouter.createCaller(ctx as unknown as Parameters<typeof groupsRouter.createCaller>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // protectedProcedure looks the caller up; groupMemberProcedure checks membership.
  mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
  mockDb.groupMember.findUnique.mockResolvedValue({ role: 'OWNER', userId: 'owner', groupId: 'g1' });
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
    createdBy: { name: 'Alice', isPlaceholder: false },
  });

  test('createInvite records who made the invite', async () => {
    mockDb.groupInvite.create.mockResolvedValue({ token: 't1' });
    const api = await caller();
    await api.createInvite({ groupId: 'g1' });
    expect(mockDb.groupInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: 'owner' }) }),
    );
  });

  test('getInvite returns the group name, inviter and member count to someone not in the group', async () => {
    mockDb.groupMember.findUnique.mockResolvedValue(null);
    mockDb.groupInvite.findUnique.mockResolvedValue(validInvite());
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toEqual({
      groupName: 'Ski Trip',
      inviterName: 'Alice',
      memberCount: 4,
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
      createdBy: { name: 'Deleted user', isPlaceholder: true },
    });
    const api = await caller();
    await expect(api.getInvite({ token: 't1' })).resolves.toMatchObject({ inviterName: null });
  });
});
