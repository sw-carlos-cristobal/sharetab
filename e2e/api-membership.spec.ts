import { test, expect } from '@playwright/test';
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, createTestGroup } from './helpers';

test.describe('Group Membership API (2.2)', () => {
  test('2.2.2 — get group as member returns details', async () => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Member Get Test',
    );

    const res = await trpcQuery(owner, 'groups.get', { groupId });
    const group = await trpcResult(res);
    expect(group.name).toBe('Member Get Test');
    expect(group.members.length).toBe(2);
    await dispose();
  });

  test('2.2.4 — remove self from group', async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Self Remove Test',
    );

    const bobId = memberIds[users.bob.email];
    const res = await trpcMutation(memberContexts[0]!, 'groups.removeMember', {
      groupId,
      userId: bobId,
    });
    const body = await res.json();
    expect(body.result?.data?.json?.success).toBe(true);

    // Verify Bob is no longer a member
    const detailRes = await trpcQuery(owner, 'groups.get', { groupId });
    const group = await trpcResult(detailRes);
    expect(group.members.length).toBe(1);
    await dispose();
  });

  test('2.2.5 — owner removes member', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Owner Remove Test',
    );

    const bobId = memberIds[users.bob.email];
    const res = await trpcMutation(owner, 'groups.removeMember', {
      groupId,
      userId: bobId,
    });
    const body = await res.json();
    expect(body.result?.data?.json?.success).toBe(true);
    await dispose();
  });

  test('2.2.6 — member tries to remove another returns FORBIDDEN', async () => {
    const { memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [
        { email: users.bob.email, password: users.bob.password },
        { email: users.charlie.email, password: users.charlie.password },
      ],
      'Member Remove Test',
    );

    const charlieId = memberIds[users.charlie.email];
    // Bob (MEMBER) tries to remove Charlie (MEMBER)
    const res = await trpcMutation(memberContexts[0]!, 'groups.removeMember', {
      groupId,
      userId: charlieId,
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe('FORBIDDEN');
    await dispose();
  });

  test('2.2.7 — cannot remove the owner', async () => {
    const { memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Remove Owner Test',
    );

    const aliceId = memberIds[users.alice.email];
    // Bob tries to remove Alice (OWNER) — even if Bob were admin this should fail
    const res = await trpcMutation(memberContexts[0]!, 'groups.removeMember', {
      groupId,
      userId: aliceId,
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe('FORBIDDEN');
    await dispose();
  });
});

test.describe('Invites API (2.4)', () => {
  test('2.4.2 — join via valid invite', async () => {
    const alice = await authedContext(users.alice.email, users.alice.password);
    const createRes = await trpcMutation(alice, 'groups.create', { name: 'Invite Join Test' });
    const groupId = (await createRes.json()).result?.data?.json?.id;

    const invRes = await trpcMutation(alice, 'groups.createInvite', { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    const bob = await authedContext(users.bob.email, users.bob.password);
    const joinRes = await trpcMutation(bob, 'groups.joinByInvite', { token });
    const joinBody = await joinRes.json();
    expect(joinBody.result?.data?.json?.groupId).toBe(groupId);
    expect(joinBody.result?.data?.json?.alreadyMember).toBe(false);

    // Verify Bob is now a member
    const detailRes = await trpcQuery(alice, 'groups.get', { groupId });
    const group = await trpcResult(detailRes);
    expect(group.members.length).toBe(2);

    await alice.dispose();
    await bob.dispose();
  });

  test('2.4.5 — join group already a member of', async () => {
    const { owner, memberContexts, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Already Member Test',
    );

    // Create another invite and have Bob try again
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    const joinRes = await trpcMutation(memberContexts[0]!, 'groups.joinByInvite', { token });
    const body = await joinRes.json();
    expect(body.result?.data?.json?.alreadyMember).toBe(true);
    await dispose();
  });

  test('2.4.7 — invite details show the group, inviter and member count until the invite is used', async () => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Invite Details Test',
    );
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;

    // Charlie isn't in the group yet and can still read what the invite is for
    const charlie = await authedContext(users.charlie.email, users.charlie.password);
    const details = await trpcResult(await trpcQuery(charlie, 'groups.getInvite', { token }));
    expect(details).toEqual({
      groupName: 'Invite Details Test',
      inviterName: users.alice.name,
      memberCount: 2,
      placeholderName: null,
    });

    await trpcMutation(charlie, 'groups.joinByInvite', { token });
    expect(await trpcResult(await trpcQuery(charlie, 'groups.getInvite', { token }))).toBeNull();

    await charlie.dispose();
    await dispose();
  });

  test('2.4.8 — invite details for an unknown token are null', async () => {
    const bob = await authedContext(users.bob.email, users.bob.password);
    const res = await trpcQuery(bob, 'groups.getInvite', { token: 'not-a-real-token' });
    expect(await trpcResult(res)).toBeNull();
    await bob.dispose();
  });
});
