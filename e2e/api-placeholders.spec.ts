import { test, expect } from '@playwright/test';
import { users, authedContext, trpcMutation, trpcQuery, trpcResult, trpcError, createTestGroup } from './helpers';

test.describe('Placeholder Members', () => {
  test('add placeholder member to group', async () => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Placeholder Test',
    );

    const res = await trpcMutation(owner, 'groups.addPlaceholder', {
      groupId,
      name: 'Dave',
    });
    const body = await res.json();
    expect(body.result?.data?.json?.name).toBe('Dave');
    expect(body.result?.data?.json?.isPlaceholder).toBe(true);

    // Verify Dave shows up in group members
    const detailRes = await trpcQuery(owner, 'groups.get', { groupId });
    const group = await trpcResult(detailRes);
    const dave = group.members.find((m: { user: { placeholderName: string } }) => m.user.placeholderName === 'Dave');
    expect(dave).toBeDefined();
    expect(dave.user.isPlaceholder).toBe(true);

    await dispose();
  });

  test('placeholder member can be assigned expenses', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Placeholder Expense Test',
    );
    const aliceId = memberIds[users.alice.email];

    // Add placeholder
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', {
      groupId,
      name: 'Eve',
    });
    const eveId = (await phRes.json()).result?.data?.json?.id;

    // Create expense splitting between Alice and Eve
    const expRes = await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Shared lunch',
      amount: 2000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: eveId, amount: 1000 },
      ],
    });
    const expense = (await expRes.json()).result?.data?.json;
    expect(expense.amount).toBe(2000);
    expect(expense.shares.length).toBe(2);

    // Verify balance: Alice net +1000, Eve net -1000
    const balRes = await trpcQuery(owner, 'balances.getGroupBalances', { groupId });
    const balances = (await trpcResult(balRes)).balances;
    const aliceBal = balances.find((b: { userId: string }) => b.userId === aliceId);
    const eveBal = balances.find((b: { userId: string }) => b.userId === eveId);
    expect(aliceBal.net).toBe(1000);
    expect(eveBal.net).toBe(-1000);

    await dispose();
  });

  test('regular member cannot add placeholder', async () => {
    const { memberContexts, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Placeholder Permission Test',
    );

    // Bob (MEMBER) tries to add placeholder
    const res = await trpcMutation(memberContexts[0]!, 'groups.addPlaceholder', {
      groupId,
      name: 'Nope',
    });
    const err = await trpcError(res);
    expect(err?.data?.code).toBe('FORBIDDEN');

    await dispose();
  });

  test('merge placeholder into real user', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Merge Test',
    );
    const aliceId = memberIds[users.alice.email];

    // Add placeholder "Frank"
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', {
      groupId,
      name: 'Frank',
    });
    const frankId = (await phRes.json()).result?.data?.json?.id;

    // Create expense with Frank
    await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: "Frank's share",
      amount: 3000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1500 },
        { userId: frankId, amount: 1500 },
      ],
    });

    // Bob joins the group
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId });
    const token = (await invRes.json()).result?.data?.json?.token;
    const bob = await authedContext(users.bob.email, users.bob.password);
    await trpcMutation(bob, 'groups.joinByInvite', { token });

    // Get Bob's real user ID
    const detailRes = await trpcQuery(owner, 'groups.get', { groupId });
    const group = await trpcResult(detailRes);
    const bobMember = group.members.find((m: { user: { email: string } }) => m.user.email === users.bob.email);
    const bobId = bobMember.user.id;

    // Merge Frank into Bob
    const mergeRes = await trpcMutation(owner, 'groups.mergePlaceholder', {
      groupId,
      placeholderUserId: frankId,
      realUserId: bobId,
    });
    expect((await mergeRes.json()).result?.data?.json?.success).toBe(true);

    // Verify: Bob now has Frank's expense share
    const balRes = await trpcQuery(owner, 'balances.getGroupBalances', { groupId });
    const balances = (await trpcResult(balRes)).balances;
    const bobBal = balances.find((b: { userId: string }) => b.userId === bobId);
    expect(bobBal.net).toBe(-1500); // Bob now owes Alice

    // Frank should no longer be a member
    const detailAfter = await trpcQuery(owner, 'groups.get', { groupId });
    const groupAfter = await trpcResult(detailAfter);
    const frankMember = groupAfter.members.find((m: { user: { id: string } }) => m.user.id === frankId);
    expect(frankMember).toBeUndefined();

    await bob.dispose();
    await dispose();
  });

  test('auto-merge via linked invite', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Auto Merge Test',
    );
    const aliceId = memberIds[users.alice.email];

    // Add placeholder
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', {
      groupId,
      name: 'Charlie Placeholder',
    });
    const phId = (await phRes.json()).result?.data?.json?.id;

    // Create expense with placeholder
    await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Dinner',
      amount: 2000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: phId, amount: 1000 },
      ],
    });

    // Create invite linked to placeholder
    const invRes = await trpcMutation(owner, 'groups.createInvite', {
      groupId,
      placeholderUserId: phId,
    });
    const token = (await invRes.json()).result?.data?.json?.token;

    // Charlie joins via the linked invite, which names the placeholder he takes over
    const charlie = await authedContext(users.charlie.email, users.charlie.password);
    const invite = await trpcResult(await trpcQuery(charlie, 'groups.getInvite', { token }));
    expect(invite.placeholderName).toBe('Charlie Placeholder');
    const joinRes = await trpcMutation(charlie, 'groups.joinByInvite', { token });
    expect((await joinRes.json()).result?.data?.json?.alreadyMember).toBe(false);

    // Verify auto-merge: Charlie has the placeholder's expense
    const balRes = await trpcQuery(owner, 'balances.getGroupBalances', { groupId });
    const balances = (await trpcResult(balRes)).balances;
    const charlieBal = balances.find((b: { userId: string }) => b.userId !== aliceId);
    expect(charlieBal).toBeDefined();
    expect(charlieBal.net).toBe(-1000);

    await charlie.dispose();
    await dispose();
  });

  // #276: merging only added the amounts of a placeholder and a member who were
  // both in an expense, so the edit form opened on a different split, and a
  // payment between them became a payment to themselves.
  test('merging keeps the amounts of an expense both were in, and drops payments between them', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Merge Overlap Test',
    );
    const aliceId = memberIds[users.alice.email]!;
    const bobId = memberIds[users.bob.email]!;
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Hank' });
    const hankId = (await phRes.json()).result?.data?.json?.id;

    const created = await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Cabin',
      amount: 3000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: bobId, amount: 1000 },
        { userId: hankId, amount: 1000 },
      ],
    });
    const expense = (await created.json()).result?.data?.json;
    await trpcMutation(owner, 'settlements.create', { groupId, fromId: hankId, toId: bobId, amount: 500 });

    const mergeRes = await trpcMutation(owner, 'groups.mergePlaceholder', {
      groupId,
      placeholderUserId: hankId,
      realUserId: bobId,
    });
    expect((await mergeRes.json()).result?.data?.json?.success).toBe(true);

    // Bob holds both parts, kept as exact amounts so saving the expense unchanged moves nothing
    const after = await trpcResult(await trpcQuery(owner, 'expenses.get', { groupId, expenseId: expense.id }));
    expect(after.splitMode).toBe('EXACT');
    const shares = Object.fromEntries(
      after.shares.map((s: { userId: string; amount: number }) => [s.userId, s.amount]),
    );
    expect(shares).toEqual({ [aliceId]: 1000, [bobId]: 2000 });

    // The payment from Hank to Bob would now be Bob paying himself
    const payments = await trpcResult(await trpcQuery(owner, 'settlements.list', { groupId }));
    expect(payments.items).toEqual([]);
    const balances = (await trpcResult(await trpcQuery(owner, 'balances.getGroupBalances', { groupId }))).balances;
    expect(balances.find((b: { userId: string }) => b.userId === bobId).net).toBe(-2000);
    expect(balances.find((b: { userId: string }) => b.userId === aliceId).net).toBe(2000);

    await dispose();
  });

  // #276: someone who joined through a plain link first, then got the claim link
  test('a member who opens a claim link takes over the placeholder', async () => {
    const { owner, memberContexts, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.charlie.email, password: users.charlie.password }],
      'Member Claim Test',
    );
    const charlie = memberContexts[0]!;
    const aliceId = memberIds[users.alice.email]!;
    const charlieId = memberIds[users.charlie.email]!;
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Ivy' });
    const ivyId = (await phRes.json()).result?.data?.json?.id;
    await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Ivy owes half',
      amount: 2000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: ivyId, amount: 1000 },
      ],
    });
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId, placeholderUserId: ivyId });
    const token = (await invRes.json()).result?.data?.json?.token;

    const joinRes = await trpcMutation(charlie, 'groups.joinByInvite', { token });
    expect((await joinRes.json()).result?.data?.json).toEqual({ groupId, alreadyMember: true });

    const balances = (await trpcResult(await trpcQuery(owner, 'balances.getGroupBalances', { groupId }))).balances;
    expect(balances.find((b: { userId: string }) => b.userId === charlieId).net).toBe(-1000);
    expect(balances.find((b: { userId: string }) => b.userId === ivyId)).toBeUndefined();
    // The link is used up
    expect(await trpcResult(await trpcQuery(charlie, 'groups.getInvite', { token }))).toBeNull();

    await dispose();
  });

  // #276: a claim link is for its placeholder only, not a general way into the group
  test('a claim link stops working once its placeholder is merged', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [{ email: users.bob.email, password: users.bob.password }],
      'Stale Claim Link Test',
    );
    const bobId = memberIds[users.bob.email]!;
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Jo' });
    const joId = (await phRes.json()).result?.data?.json?.id;
    const invRes = await trpcMutation(owner, 'groups.createInvite', { groupId, placeholderUserId: joId });
    const token = (await invRes.json()).result?.data?.json?.token;
    await trpcMutation(owner, 'groups.mergePlaceholder', { groupId, placeholderUserId: joId, realUserId: bobId });

    const charlie = await authedContext(users.charlie.email, users.charlie.password);
    expect(await trpcResult(await trpcQuery(charlie, 'groups.getInvite', { token }))).toBeNull();
    const err = await trpcError(await trpcMutation(charlie, 'groups.joinByInvite', { token }));
    expect(err?.data?.code).toBe('NOT_FOUND');
    const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    expect(group.members.map((m: { user: { email: string } }) => m.user.email)).not.toContain(users.charlie.email);

    await charlie.dispose();
    await dispose();
  });

  // #260: removing a placeholder used to move their shares and payments onto
  // other people and delete their settlements, writing off what they owed or
  // were owed without saying so. #284: one who owes or is owed money stays.
  test('removing a placeholder who still owes money is refused', async () => {
    const { owner, groupId, memberIds, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Remove Used Placeholder',
    );
    const aliceId = memberIds[users.alice.email];
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Gina' });
    const ginaId = (await phRes.json()).result?.data?.json?.id;
    await trpcMutation(owner, 'expenses.create', {
      groupId,
      title: 'Gina owes half',
      amount: 2000,
      paidById: aliceId,
      splitMode: 'EQUAL',
      shares: [
        { userId: aliceId, amount: 1000 },
        { userId: ginaId, amount: 1000 },
      ],
    });

    const err = await trpcError(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: ginaId }));
    expect(err?.data?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe(
      "Gina still owes or is owed money in this group, so they can't be removed. Settle up first.",
    );

    const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    expect(group.members.some((m: { user: { id: string } }) => m.user.id === ginaId)).toBe(true);
    const { balances } = await trpcResult(await trpcQuery(owner, 'balances.getGroupBalances', { groupId }));
    expect(balances.find((b: { userId: string }) => b.userId === aliceId).net).toBe(1000);

    await dispose();
  });

  // #284: a placeholder at a zero balance can go, and their history stays theirs
  test.describe('a settled-up placeholder who is in expenses', () => {
    type Member = { user: { id: string } };
    const ids = (members: Member[]) => members.map((m) => m.user.id);
    // A mutation's result, failing with the server's error when there is none
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function ok(res: { json: () => Promise<any> }): Promise<any> {
      const body = await res.json();
      if (!body.result) throw new Error(`Expected a result, got ${JSON.stringify(body.error?.json ?? body)}`);
      return body.result.data.json;
    }

    // Hal owes Bob $5.00 and Alice owes Hal $5.00, so Hal's balance is zero
    async function groupWithSettledHal(name: string) {
      const group = await createTestGroup(
        users.alice.email,
        users.alice.password,
        [{ email: users.bob.email, password: users.bob.password }],
        name,
      );
      const { owner, groupId, memberIds } = group;
      const aliceId = memberIds[users.alice.email]!;
      const bobId = memberIds[users.bob.email]!;
      const halId: string = (await ok(await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Hal' }))).id;
      const bobPaid = await ok(
        await trpcMutation(owner, 'expenses.create', {
          groupId,
          title: 'Bob paid for Hal',
          amount: 1000,
          paidById: bobId,
          splitMode: 'EQUAL',
          shares: [
            { userId: bobId, amount: 500 },
            { userId: halId, amount: 500 },
          ],
        }),
      );
      const halPaid = await ok(
        await trpcMutation(owner, 'expenses.create', {
          groupId,
          title: 'Hal paid for Alice',
          amount: 1000,
          paidById: halId,
          splitMode: 'EQUAL',
          shares: [
            { userId: halId, amount: 500 },
            { userId: aliceId, amount: 500 },
          ],
        }),
      );
      const net = async (userId: string) => {
        const { balances } = await trpcResult(await trpcQuery(owner, 'balances.getGroupBalances', { groupId }));
        return balances.find((b: { userId: string }) => b.userId === userId)?.net ?? 0;
      };
      return { ...group, aliceId, bobId, halId, bobPaidId: bobPaid.id as string, halPaidId: halPaid.id as string, net };
    }

    test('is removed from the member list, keeping their history and every balance', async () => {
      const { owner, groupId, aliceId, bobId, halId, net, dispose } = await groupWithSettledHal('Remove Settled Hal');

      const res = await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId });
      expect((await ok(res)).success).toBe(true);

      const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
      expect(ids(group.members)).not.toContain(halId);
      expect(ids(group.removedMembers)).toEqual([halId]);
      expect(group.removedMembers[0].user.placeholderName).toBe('Hal');
      expect(await net(bobId)).toBe(500);
      expect(await net(aliceId)).toBe(-500);
      expect(await net(halId)).toBe(0);
      const { expenses } = await trpcResult(await trpcQuery(owner, 'expenses.list', { groupId }));
      expect(expenses).toHaveLength(2);

      // Removing them again finds nobody to remove
      const again = await trpcError(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId }));
      expect(again?.data?.code).toBe('NOT_FOUND');

      await dispose();
    });

    test('a balance that comes back after removal can be settled with them', async () => {
      const { owner, groupId, bobId, halId, halPaidId, net, dispose } = await groupWithSettledHal('Settle Removed Hal');
      await ok(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId }));

      // Without the expense Hal paid, Hal owes Bob $5.00 again
      await ok(await trpcMutation(owner, 'expenses.delete', { groupId, expenseId: halPaidId }));
      expect(await net(halId)).toBe(-500);

      // A payment can settle that, but not make Hal a new debt
      const overpaid = await trpcError(
        await trpcMutation(owner, 'settlements.create', {
          groupId,
          fromId: halId,
          toId: bobId,
          amount: 600,
          currency: 'USD',
        }),
      );
      expect(overpaid?.data?.code).toBe('BAD_REQUEST');
      expect(overpaid?.message).toBe(
        'A payment with someone removed from this group can only settle what they still owe or are owed.',
      );

      await ok(
        await trpcMutation(owner, 'settlements.create', {
          groupId,
          fromId: halId,
          toId: bobId,
          amount: 500,
          currency: 'USD',
        }),
      );
      expect(await net(halId)).toBe(0);
      expect(await net(bobId)).toBe(0);
      const another = await trpcError(
        await trpcMutation(owner, 'settlements.create', { groupId, toId: halId, amount: 100, currency: 'USD' }),
      );
      expect(another?.data?.code).toBe('BAD_REQUEST');

      await dispose();
    });

    test('stays in the expenses they were in, but is not put in new ones', async () => {
      const { owner, groupId, aliceId, bobId, halId, bobPaidId, net, dispose } =
        await groupWithSettledHal('Removed Hal In Expenses');
      await ok(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId }));

      const created = await trpcError(
        await trpcMutation(owner, 'expenses.create', {
          groupId,
          title: 'Hal again',
          amount: 1000,
          paidById: aliceId,
          splitMode: 'EQUAL',
          shares: [
            { userId: aliceId, amount: 500 },
            { userId: halId, amount: 500 },
          ],
        }),
      );
      expect(created?.data?.code).toBe('BAD_REQUEST');
      const paid = await trpcError(
        await trpcMutation(owner, 'expenses.create', {
          groupId,
          title: 'Hal paid again',
          amount: 1000,
          paidById: halId,
          splitMode: 'EQUAL',
          shares: [{ userId: aliceId, amount: 1000 }],
        }),
      );
      expect(paid?.data?.code).toBe('BAD_REQUEST');

      // Editing an expense Hal is in keeps his share there
      await ok(
        await trpcMutation(owner, 'expenses.update', {
          groupId,
          expenseId: bobPaidId,
          amount: 2000,
          splitMode: 'EQUAL',
          shares: [
            { userId: bobId, amount: 1000 },
            { userId: halId, amount: 1000 },
          ],
        }),
      );
      expect(await net(halId)).toBe(-500);
      // ...but only in the part he had: he had a share, not the payment
      const payer = await trpcError(
        await trpcMutation(owner, 'expenses.update', { groupId, expenseId: bobPaidId, paidById: halId }),
      );
      expect(payer?.data?.code).toBe('BAD_REQUEST');

      await dispose();
    });

    test('is not added to an expense they were not in', async () => {
      const { owner, groupId, aliceId, bobId, halId, dispose } = await groupWithSettledHal('Removed Hal Not Added');
      const other = await ok(
        await trpcMutation(owner, 'expenses.create', {
          groupId,
          title: 'Just Alice and Bob',
          amount: 1000,
          paidById: aliceId,
          splitMode: 'EQUAL',
          shares: [
            { userId: aliceId, amount: 500 },
            { userId: bobId, amount: 500 },
          ],
        }),
      );
      await ok(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId }));

      const err = await trpcError(
        await trpcMutation(owner, 'expenses.update', {
          groupId,
          expenseId: other.id,
          amount: 1500,
          splitMode: 'EQUAL',
          shares: [
            { userId: aliceId, amount: 500 },
            { userId: bobId, amount: 500 },
            { userId: halId, amount: 500 },
          ],
        }),
      );
      expect(err?.data?.code).toBe('BAD_REQUEST');
      const payer = await trpcError(
        await trpcMutation(owner, 'expenses.update', { groupId, expenseId: other.id, paidById: halId }),
      );
      expect(payer?.data?.code).toBe('BAD_REQUEST');

      await dispose();
    });

    test('comes back, history and all, when their name is added again', async () => {
      const { owner, groupId, halId, dispose } = await groupWithSettledHal('Restore Removed Hal');
      await ok(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId }));

      // Another placeholder can't take Hal's name while Hal is removed
      const ivy = await ok(await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Ivy' }));
      const renamed = await trpcError(
        await trpcMutation(owner, 'groups.renamePlaceholder', { groupId, placeholderUserId: ivy.id, name: 'hal' }),
      );
      expect(renamed?.data?.code).toBe('CONFLICT');

      const added = await ok(await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: ' hal ' }));
      expect(added.id).toBe(halId);
      expect(added.restored).toBe(true);
      const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
      expect(ids(group.members)).toContain(halId);
      expect(group.removedMembers).toEqual([]);

      await dispose();
    });

    test('a claim link made for them stops working, and they can still be merged', async () => {
      const { owner, groupId, aliceId, halId, net, dispose } = await groupWithSettledHal('Removed Hal Links');
      const invite = await ok(await trpcMutation(owner, 'groups.createInvite', { groupId, placeholderUserId: halId }));
      await ok(await trpcMutation(owner, 'groups.removeMember', { groupId, userId: halId }));

      const charlie = await authedContext(users.charlie.email, users.charlie.password);
      expect(await trpcResult(await trpcQuery(charlie, 'groups.getInvite', { token: invite.token }))).toBeNull();
      const joined = await trpcError(await trpcMutation(charlie, 'groups.joinByInvite', { token: invite.token }));
      expect(joined?.data?.code).toBe('NOT_FOUND');
      await charlie.dispose();
      const linked = await trpcError(
        await trpcMutation(owner, 'groups.createInvite', { groupId, placeholderUserId: halId }),
      );
      expect(linked?.data?.code).toBe('BAD_REQUEST');

      // Merging hands Alice Hal's expenses: Alice paid $5.00 of hers through Hal
      await ok(
        await trpcMutation(owner, 'groups.mergePlaceholder', {
          groupId,
          placeholderUserId: halId,
          realUserId: aliceId,
        }),
      );
      const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
      expect(group.removedMembers).toEqual([]);
      expect(await net(aliceId)).toBe(-500);

      await dispose();
    });
  });

  test('removing a placeholder who was never in an expense removes them', async () => {
    const { owner, groupId, dispose } = await createTestGroup(
      users.alice.email,
      users.alice.password,
      [],
      'Remove Unused Placeholder',
    );
    const phRes = await trpcMutation(owner, 'groups.addPlaceholder', { groupId, name: 'Ivy' });
    const ivyId = (await phRes.json()).result?.data?.json?.id;

    const res = await trpcMutation(owner, 'groups.removeMember', { groupId, userId: ivyId });
    expect((await res.json()).result?.data?.json?.success).toBe(true);

    const group = await trpcResult(await trpcQuery(owner, 'groups.get', { groupId }));
    expect(group.members.some((m: { user: { id: string } }) => m.user.id === ivyId)).toBe(false);

    await dispose();
  });
});
