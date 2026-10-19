import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { TRPCError } from '@trpc/server';
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from '../init';
import { stripUndefined } from '../../lib/strip-undefined';
import { loadGroupBalances, lockGroupMembers } from '../../lib/group-balances';
import { mergePlaceholderIntoUser } from '../../lib/placeholder-merge';
import { checkRateLimit } from '../../lib/rate-limit';

// Invite tokens are cuids (25 characters); a defensive bound so oversized input never reaches the lookup.
const inviteTokenSchema = z.string().max(64);
// getInvite answers whether a token is live without using it up, so cap how fast one account can ask.
const INVITE_LOOKUP_LIMIT = 30;
const INVITE_LOOKUP_WINDOW_MS = 60 * 1000;

export const groupsRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: {
        members: { some: { userId: ctx.user.id } },
        archivedAt: null,
      },
      take: 200,
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true, isPlaceholder: true, placeholderName: true },
            },
          },
        },
        _count: { select: { expenses: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return groups;
  }),

  listArchived: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: {
        members: { some: { userId: ctx.user.id } },
        archivedAt: { not: null },
      },
      take: 200,
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true, isPlaceholder: true, placeholderName: true },
            },
          },
        },
        _count: { select: { expenses: true } },
      },
      orderBy: { archivedAt: 'desc' },
    });
    return groups;
  }),

  get: groupMemberProcedure.query(async ({ ctx, input }) => {
    const group = await ctx.db.group.findUnique({
      where: { id: input.groupId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                isPlaceholder: true,
                placeholderName: true,
                venmoUsername: true,
              },
            },
          },
        },
      },
    });
    if (!group) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
    }
    return group;
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(500).optional(),
        currency: z
          .string()
          .length(3)
          .regex(/^[a-zA-Z]{3}$/)
          .transform((c) => c.toUpperCase())
          .default('USD'),
        emoji: z.string().max(4).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.create({
        data: {
          ...stripUndefined(input),
          members: {
            create: {
              userId: ctx.user.id,
              role: 'OWNER',
            },
          },
        },
      });
      return group;
    }),

  update: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        currency: z
          .string()
          .length(3)
          .regex(/^[a-zA-Z]{3}$/)
          .transform((c) => c.toUpperCase())
          .optional(),
        emoji: z.string().max(4).optional(),
        simplifyDebts: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === 'MEMBER') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins and owners can update groups' });
      }
      const { groupId, ...data } = input;

      if (data.currency) {
        const existing = await ctx.db.group.findUnique({
          where: { id: groupId },
          select: { currency: true },
        });
        if (existing && data.currency.toUpperCase() !== existing.currency.toUpperCase()) {
          const [expenseCount, settlementCount] = await Promise.all([
            ctx.db.expense.count({ where: { groupId }, take: 1 }),
            ctx.db.settlement.count({ where: { groupId }, take: 1 }),
          ]);
          if (expenseCount > 0 || settlementCount > 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'Cannot change group currency after expenses or settlements have been recorded. Create a new group with the desired currency instead.',
            });
          }
        }
      }

      const group = await ctx.db.group.update({
        where: { id: groupId },
        data: stripUndefined(data),
      });
      return group;
    }),

  delete: groupMemberProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    if (ctx.membership.role !== 'OWNER') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner can delete a group' });
    }
    await ctx.db.group.delete({ where: { id: input.groupId } });
    return { success: true };
  }),

  archive: groupMemberProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    if (ctx.membership.role === 'MEMBER') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins and owners can archive groups' });
    }
    return ctx.db.$transaction(async (tx) => {
      // Archive first: the row lock this takes waits for every balance change
      // in flight and holds off new ones until this transaction ends (see
      // lockActiveGroup), so the balances read below are final (#289).
      const { count } = await tx.group.updateMany({
        where: { id: input.groupId, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      const group = await tx.group.findUnique({ where: { id: input.groupId } });
      if (!group) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }
      if (count === 0) {
        // Archived already
        return group;
      }
      // An archived group refuses settlements (and expenses), so an open balance
      // archived with it could only be settled by unarchiving the group first.
      // Throwing here rolls the archive back.
      const unsettled = (await loadGroupBalances(tx, input.groupId)).filter((b) => b.net !== 0);
      if (unsettled.length > 0) {
        // Settlements need both people to be members, so a balance with someone
        // who left can't be settled until they rejoin. An account an admin
        // deleted can't rejoin, so the expenses it's in have to change instead.
        const members = await tx.groupMember.findMany({
          where: { groupId: input.groupId },
          select: { userId: true },
        });
        const memberIds = new Set(members.map((m) => m.userId));
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: unsettled.some((b) => !memberIds.has(b.userId))
            ? "Someone who is no longer in this group still owes or is owed money, so it can't be archived. Invite them back to settle up, or edit the expenses they're in."
            : 'This group still has unsettled balances. Settle up before archiving it.',
        });
      }
      await tx.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: 'GROUP_ARCHIVED',
          metadata: { name: group.name },
        },
      });
      return group;
    });
  }),

  unarchive: groupMemberProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    if (ctx.membership.role === 'MEMBER') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins and owners can unarchive groups' });
    }
    const group = await ctx.db.group.update({
      where: { id: input.groupId },
      data: { archivedAt: null },
    });
    await ctx.db.activityLog.create({
      data: {
        groupId: input.groupId,
        userId: ctx.user.id,
        type: 'GROUP_UNARCHIVED',
        metadata: { name: group.name },
      },
    });
    return group;
  }),

  createInvite: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        email: z.string().email().optional(),
        placeholderUserId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.placeholderUserId) {
        // Linking an invite to a placeholder hands the redeemer that
        // placeholder's financial history, so gate it like the other
        // placeholder operations (create/rename/merge are owner/admin-only).
        if (ctx.membership.role !== 'OWNER' && ctx.membership.role !== 'ADMIN') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only admins and owners can create placeholder-linked invites',
          });
        }
        const placeholder = await ctx.db.user.findUnique({
          where: { id: input.placeholderUserId },
          select: { isPlaceholder: true, suspendedAt: true },
        });
        if (!placeholder?.isPlaceholder) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a placeholder user' });
        }
        // Accepting the link merges the placeholder, which refuses these two
        if (placeholder.suspendedAt) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: "A deleted account can't be merged" });
        }
        const group = await ctx.db.group.findUnique({
          where: { id: input.groupId },
          select: { archivedAt: true },
        });
        if (group?.archivedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This group is archived. Unarchive it to merge a placeholder.',
          });
        }
        const membership = await ctx.db.groupMember.findUnique({
          where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
        });
        if (!membership) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Placeholder is not a member of this group' });
        }
      }
      const invite = await ctx.db.groupInvite.create({
        data: {
          groupId: input.groupId,
          createdById: ctx.user.id,
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.placeholderUserId !== undefined ? { placeholderUserId: input.placeholderUserId } : {}),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        },
      });
      return { token: invite.token };
    }),

  // What the invite page shows before the person accepts. Anyone signed in who
  // holds the token sees it, which is less than the token already gives them
  // (joining the group). null when joinByInvite would refuse the token.
  getInvite: protectedProcedure.input(z.object({ token: inviteTokenSchema })).query(async ({ ctx, input }) => {
    if (!checkRateLimit(`invite-lookup:${ctx.user.id}`, INVITE_LOOKUP_LIMIT, INVITE_LOOKUP_WINDOW_MS).allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many invite lookups. Try again in a minute.' });
    }
    const invite = await ctx.db.groupInvite.findUnique({
      where: { token: input.token },
      select: {
        usedAt: true,
        expiresAt: true,
        groupId: true,
        placeholderUserId: true,
        group: { select: { name: true, _count: { select: { members: true } } } },
        createdBy: { select: { name: true, isPlaceholder: true, suspendedAt: true } },
      },
    });
    if (!invite || !isRedeemable(invite)) return null;
    // Name only an active account: a deleted one becomes a placeholder named "Deleted user",
    // and a suspended one shouldn't be vouching for anything.
    const inviter = invite.createdBy;
    const inviterName = inviter && !inviter.isPlaceholder && !inviter.suspendedAt ? inviter.name : null;
    // A link made for a placeholder hands over their expenses and payments, so
    // the page says whose (only while joinByInvite would still merge them).
    const placeholder = invite.placeholderUserId
      ? await findPlaceholderMember(ctx.db, invite.placeholderUserId, invite.groupId)
      : null;
    // A link made for a placeholder is for them only: once they're merged or
    // removed, joinByInvite refuses it.
    if (invite.placeholderUserId && !placeholder) return null;
    const placeholderName = placeholder ? (placeholder.placeholderName ?? placeholder.name) : null;
    return {
      groupName: invite.group.name,
      inviterName,
      memberCount: invite.group._count.members,
      placeholderName,
    };
  }),

  joinByInvite: protectedProcedure.input(z.object({ token: inviteTokenSchema })).mutation(async ({ ctx, input }) => {
    const invite = await ctx.db.groupInvite.findUnique({
      where: { token: input.token },
    });
    if (!invite) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
    }

    const existing = await ctx.db.groupMember.findUnique({
      where: {
        userId_groupId: { userId: ctx.user.id, groupId: invite.groupId },
      },
    });
    // A retry of this person's own redemption, whose answer was lost, finds
    // the invite already used by them.
    if (existing && invite.usedById === ctx.user.id) {
      return { groupId: invite.groupId, alreadyMember: true };
    }
    if (!isRedeemable(invite)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
    }
    if (existing) {
      // A link made for a placeholder hands them over to whoever accepts it,
      // including someone who joined through another link first.
      const placeholderUserId = invite.placeholderUserId;
      if (placeholderUserId) {
        await ctx.db.$transaction(async (tx) => {
          if (!(await findPlaceholderMember(tx, placeholderUserId, invite.groupId))) {
            // Done if this person's own earlier submit took them over; otherwise
            // they went to someone else, and the link is for nothing now.
            if (await isUsedBy(tx, invite.id, ctx.user.id)) return;
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
          }
          if (!(await claimInvite(tx, invite.id, ctx.user.id))) {
            // Fine if it was this person's own earlier submit; otherwise
            // someone else got there first and took the placeholder.
            if (await isUsedBy(tx, invite.id, ctx.user.id)) return;
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
          }
          if (!(await mergePlaceholderIntoUser(tx, placeholderUserId, ctx.user.id, invite.groupId))) {
            throw new TRPCError({ code: 'CONFLICT', message: 'This placeholder was already merged or removed' });
          }
        });
      }
      // Any other link opened by a member sends them to the group without using
      // it up: usedAt/usedById only track a redemption that joins or merges.
      return { groupId: invite.groupId, alreadyMember: true };
    }

    const joined = await ctx.db.$transaction(async (tx) => {
      // Claim the invite only while it's unused and unexpired, so two people
      // redeeming one link at once can't both join (and only one takes over a
      // placeholder).
      if (!(await claimInvite(tx, invite.id, ctx.user.id))) return false;
      // An invite made for a placeholder hands them over to whoever accepts it,
      // and is for that only: once the placeholder is merged or removed, it
      // doesn't let anyone into the group.
      if (invite.placeholderUserId && !(await findPlaceholderMember(tx, invite.placeholderUserId, invite.groupId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
      }
      await tx.groupMember.create({
        data: { userId: ctx.user.id, groupId: invite.groupId },
      });
      await tx.activityLog.create({
        data: {
          groupId: invite.groupId,
          userId: ctx.user.id,
          type: 'MEMBER_JOINED',
        },
      });

      if (invite.placeholderUserId) {
        // Lost to a merge that got there first since the check above
        if (!(await mergePlaceholderIntoUser(tx, invite.placeholderUserId, ctx.user.id, invite.groupId))) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This placeholder was already merged or removed' });
        }
      }
      return true;
    });
    if (!joined) {
      // Used or expired since the lookup. A second submit of this person's own
      // join ends up here too, once the first has used the invite for them.
      if (await isUsedBy(ctx.db, invite.id, ctx.user.id)) {
        return { groupId: invite.groupId, alreadyMember: true };
      }
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
    }

    return { groupId: invite.groupId, alreadyMember: false };
  }),

  removeMember: groupMemberProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const isSelf = input.userId === ctx.user.id;
      const isAdmin = ctx.membership.role === 'OWNER' || ctx.membership.role === 'ADMIN';

      if (!isSelf && !isAdmin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot remove other members' });
      }

      const targetMember = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.userId, groupId: input.groupId } },
      });
      if (!targetMember) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
      }
      if (targetMember.role === 'OWNER' && !isSelf) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot remove the owner' });
      }
      // Nobody else could manage or delete the group, and there's no handing
      // ownership over yet (#279)
      if (targetMember.role === 'OWNER') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: "The group's owner can't leave it. Delete the group instead if nobody needs it.",
        });
      }

      const targetUser = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { isPlaceholder: true, name: true, placeholderName: true },
      });

      await ctx.db.$transaction(async (tx) => {
        // Waits for balance changes in flight and holds off new ones, so the
        // checks below see every change, and a change that starts meanwhile
        // finds this person gone (#279)
        await lockGroupMembers(tx, input.groupId);

        // Someone who leaves no longer sees the group, so a debt in it would drop
        // out of their view. The owner removing a member isn't held up by one: they
        // still see it, and the archive check names it.
        if (isSelf) {
          const balance = (await loadGroupBalances(tx, input.groupId)).find((b) => b.userId === ctx.user.id);
          if (balance && balance.net !== 0) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'You still owe or are owed money in this group. Settle up before you leave.',
            });
          }
        }

        if (targetUser?.isPlaceholder) {
          // A placeholder can't log in to settle up, rejoin or be merged once
          // gone, so one who is in any expense or payment stays. Moving their part
          // onto other people writes off what they owe or are owed, and dropping
          // only the membership leaves a balance that comes back (say an old
          // expense is deleted) with nobody able to settle it.
          const [shares, expenses, settlements] = await Promise.all([
            tx.expenseShare.count({ where: { userId: input.userId } }),
            tx.expense.count({ where: { OR: [{ paidById: input.userId }, { addedById: input.userId }] } }),
            tx.settlement.count({ where: { OR: [{ fromId: input.userId }, { toId: input.userId }] } }),
          ]);
          if (shares + expenses + settlements > 0) {
            const name = targetUser.placeholderName ?? targetUser.name ?? 'This member';
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `${name} is in expenses or payments in this group, so they can't be removed. Take them out of those first.`,
            });
          }

          await tx.receiptItemAssignment.deleteMany({ where: { userId: input.userId } });
          await tx.activityLog.create({
            data: {
              groupId: input.groupId,
              userId: ctx.user.id,
              type: 'MEMBER_LEFT',
              metadata: { removedUserId: input.userId, wasPlaceholder: true },
            },
          });
          // Nothing refers to them: delete the user (GroupMember cascades; their
          // activity-log entries stay, with the user link cleared)
          await tx.user.delete({ where: { id: input.userId } });
        } else {
          // Real user — preserve financial history, just remove the membership
          await tx.groupMember.delete({ where: { id: targetMember.id } });
          await tx.activityLog.create({
            data: {
              groupId: input.groupId,
              userId: ctx.user.id,
              type: 'MEMBER_LEFT',
              metadata: { removedUserId: input.userId },
            },
          });
        }
      });

      return { success: true };
    }),

  addPlaceholder: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        name: z.string().trim().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === 'MEMBER') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins and owners can add placeholder members' });
      }

      const { randomUUID } = await import('crypto');
      const placeholderEmail = `placeholder-${randomUUID()}@placeholder.local`;

      const user = await ctx.db.user.create({
        data: {
          email: placeholderEmail,
          name: input.name,
          isPlaceholder: true,
          placeholderName: input.name,
          createdByUserId: ctx.user.id,
        },
      });

      await ctx.db.groupMember.create({
        data: { userId: user.id, groupId: input.groupId },
      });

      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: 'PLACEHOLDER_CREATED',
          metadata: { placeholderName: input.name, placeholderUserId: user.id },
        },
      });

      return { id: user.id, name: user.name, isPlaceholder: true };
    }),

  renamePlaceholder: groupMemberProcedure
    .input(z.object({ groupId: z.string(), placeholderUserId: z.string(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== 'OWNER' && ctx.membership.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only admins and owners can rename placeholder members' });
      }
      const user = await ctx.db.user.findUnique({ where: { id: input.placeholderUserId } });
      if (!user?.isPlaceholder) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'User is not a placeholder' });
      }
      const membership = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
      });
      if (!membership) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Placeholder is not a member of this group' });
      }
      return ctx.db.user.update({
        where: { id: input.placeholderUserId },
        data: { placeholderName: input.name, name: input.name },
      });
    }),

  mergePlaceholder: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        placeholderUserId: z.string(),
        realUserId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== 'OWNER' && ctx.membership.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      const placeholder = await ctx.db.user.findUnique({
        where: { id: input.placeholderUserId },
      });
      if (!placeholder?.isPlaceholder) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a placeholder user' });
      }

      const placeholderMember = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
      });
      if (!placeholderMember) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Placeholder is not a member of this group' });
      }

      const merged = await ctx.db.$transaction((tx) =>
        mergePlaceholderIntoUser(tx, input.placeholderUserId, input.realUserId, input.groupId),
      );
      if (!merged) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This placeholder was already merged or removed' });
      }

      return { success: true };
    }),
});

/** Whether an invite can still be used to join: not used yet and not expired. */
function isRedeemable(invite: { usedAt: Date | null; expiresAt: Date }) {
  return !invite.usedAt && invite.expiresAt >= new Date();
}

/** Mark an invite used by this user, if it's still unused and unexpired. */
async function claimInvite(tx: Prisma.TransactionClient, inviteId: string, userId: string) {
  const claimed = await tx.groupInvite.updateMany({
    where: { id: inviteId, usedAt: null, expiresAt: { gte: new Date() } },
    data: { usedAt: new Date(), usedById: userId },
  });
  return claimed.count === 1;
}

/** Whether this user is the one who used the invite. */
async function isUsedBy(db: Prisma.TransactionClient, inviteId: string, userId: string) {
  const invite = await db.groupInvite.findUnique({ where: { id: inviteId }, select: { usedById: true } });
  return invite?.usedById === userId;
}

/** The user if they're still a placeholder and a member of the group, else null. */
async function findPlaceholderMember(db: Prisma.TransactionClient, userId: string, groupId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isPlaceholder: true, placeholderName: true, name: true },
  });
  if (!user?.isPlaceholder) return null;
  const membership = await db.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
  });
  return membership ? user : null;
}
