import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from '../init';
import { stripUndefined } from '../../lib/strip-undefined';
import { loadGroupBalances, lockGroupMembers } from '../../lib/group-balances';
import { deleteGroupWithData } from '../../lib/group-delete';
import { removeReceiptFiles } from '../../lib/receipt-cleanup';
import { mergePlaceholderIntoUser } from '../../lib/placeholder-merge';
import { checkRateLimit } from '../../lib/rate-limit';
import { normalizeGuestName } from '@/lib/guest-session';

// Invite tokens are cuids (25 characters); a defensive bound so oversized input never reaches the lookup.
const inviteTokenSchema = z.string().max(64);
// getInvite answers whether a token is live without using it up, so cap how fast one account can ask.
const INVITE_LOOKUP_LIMIT = 30;
const INVITE_LOOKUP_WINDOW_MS = 60 * 1000;

// "Alice" and "alice" could both be added, and the expense pickers then showed two rows that
// look the same (#265). A placeholder's name is compared with every member's, ignoring case
// and surrounding spaces, as claim sessions compare names. The caller holds
// `lockGroupMembers`, so two people adding one name at the same moment can't both see it free.
async function assertPlaceholderNameFree(
  tx: Prisma.TransactionClient,
  groupId: string,
  name: string,
  exceptUserId?: string,
): Promise<void> {
  const members = await tx.groupMember.findMany({
    where: { groupId },
    select: { userId: true, user: { select: { name: true, placeholderName: true } } },
  });
  const wanted = normalizeGuestName(name);
  const taken = members.some(
    (m) =>
      m.userId !== exceptUserId &&
      [m.user.placeholderName, m.user.name].some((n) => n != null && normalizeGuestName(n) === wanted),
  );
  if (taken) {
    throw new AppError('CONFLICT', 'placeholderNameTaken');
  }
}

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
      throw new AppError('NOT_FOUND', 'groupNotFound');
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
        throw new AppError('FORBIDDEN', 'onlyAdminsUpdateGroup');
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
            throw new AppError('BAD_REQUEST', 'currencyLocked');
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
    const notOwner = new AppError('FORBIDDEN', 'onlyOwnerDeletesGroup');
    if (ctx.membership.role !== 'OWNER') {
      throw notOwner;
    }
    const imagePaths = await ctx.db.$transaction(async (tx) => {
      // A transfer of ownership takes the same lock, so the role read below is
      // current: a delete the old owner sent while handing the group over is
      // refused, rather than deleting a group someone else now owns (#309).
      await lockGroupMembers(tx, input.groupId);
      const owner = await tx.groupMember.findUnique({
        where: { userId_groupId: { userId: ctx.user.id, groupId: input.groupId } },
        select: { role: true },
      });
      if (owner?.role !== 'OWNER') {
        throw notOwner;
      }
      return deleteGroupWithData(tx, input.groupId);
    });
    await removeReceiptFiles(imagePaths);
    return { success: true };
  }),

  archive: groupMemberProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    if (ctx.membership.role === 'MEMBER') {
      throw new AppError('FORBIDDEN', 'onlyAdminsArchiveGroup');
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
        throw new AppError('NOT_FOUND');
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
        throw new AppError(
          'PRECONDITION_FAILED',
          unsettled.some((b) => !memberIds.has(b.userId)) ? 'archiveFormerMemberUnsettled' : 'archiveUnsettled',
        );
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
      throw new AppError('FORBIDDEN', 'onlyAdminsUnarchiveGroup');
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
          throw new AppError('FORBIDDEN', 'onlyAdminsPlaceholderInvite');
        }
        const placeholder = await ctx.db.user.findUnique({
          where: { id: input.placeholderUserId },
          select: { isPlaceholder: true, suspendedAt: true },
        });
        if (!placeholder?.isPlaceholder) {
          throw new AppError('BAD_REQUEST', 'notPlaceholderUser');
        }
        // Accepting the link merges the placeholder, which refuses these two
        if (placeholder.suspendedAt) {
          throw new AppError('BAD_REQUEST', 'mergeDeletedAccount');
        }
        const group = await ctx.db.group.findUnique({
          where: { id: input.groupId },
          select: { archivedAt: true },
        });
        if (group?.archivedAt) {
          throw new AppError('BAD_REQUEST', 'mergeArchivedGroup');
        }
        const membership = await ctx.db.groupMember.findUnique({
          where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
        });
        if (!membership) {
          throw new AppError('BAD_REQUEST', 'placeholderNotMember');
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
      throw new AppError('TOO_MANY_REQUESTS', 'inviteLookupRateLimited');
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
      throw new AppError('NOT_FOUND', 'inviteInvalid');
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
      throw new AppError('NOT_FOUND', 'inviteInvalid');
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
            throw new AppError('NOT_FOUND', 'inviteInvalid');
          }
          if (!(await claimInvite(tx, invite.id, ctx.user.id))) {
            // Fine if it was this person's own earlier submit; otherwise
            // someone else got there first and took the placeholder.
            if (await isUsedBy(tx, invite.id, ctx.user.id)) return;
            throw new AppError('NOT_FOUND', 'inviteInvalid');
          }
          if (!(await mergePlaceholderIntoUser(tx, placeholderUserId, ctx.user.id, invite.groupId))) {
            throw new AppError('CONFLICT', 'placeholderGone');
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
        throw new AppError('NOT_FOUND', 'inviteInvalid');
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
          throw new AppError('CONFLICT', 'placeholderGone');
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
      throw new AppError('NOT_FOUND', 'inviteInvalid');
    }

    return { groupId: invite.groupId, alreadyMember: false };
  }),

  removeMember: groupMemberProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const isSelf = input.userId === ctx.user.id;
      // Checked again under the lock below; this keeps a plain member's attempt from taking it
      if (!isSelf && ctx.membership.role === 'MEMBER') {
        throw new AppError('FORBIDDEN', 'cannotRemoveOthers');
      }

      await ctx.db.$transaction(async (tx) => {
        // Waits for balance changes in flight and holds off new ones, so the
        // checks below see every change, and a change that starts meanwhile
        // finds this person gone (#279). A transfer of ownership takes the same
        // lock, so the roles read below are current (#309).
        await lockGroupMembers(tx, input.groupId);

        if (!isSelf) {
          const caller = await tx.groupMember.findUnique({
            where: { userId_groupId: { userId: ctx.user.id, groupId: input.groupId } },
            select: { role: true },
          });
          if (caller?.role !== 'OWNER' && caller?.role !== 'ADMIN') {
            throw new AppError('FORBIDDEN', 'cannotRemoveOthers');
          }
        }

        const targetMember = await tx.groupMember.findUnique({
          where: { userId_groupId: { userId: input.userId, groupId: input.groupId } },
        });
        if (!targetMember) {
          throw new AppError('NOT_FOUND', 'memberNotFound');
        }
        if (targetMember.role === 'OWNER' && !isSelf) {
          throw new AppError('FORBIDDEN', 'cannotRemoveOwner');
        }
        // Nobody else could manage or delete the group (#279)
        if (targetMember.role === 'OWNER') {
          throw new AppError('FORBIDDEN', 'ownerCannotLeave');
        }

        const targetUser = await tx.user.findUnique({
          where: { id: input.userId },
          select: { isPlaceholder: true, name: true, placeholderName: true },
        });

        // Someone who leaves no longer sees the group, so a debt in it would drop
        // out of their view. The owner removing a member isn't held up by one: they
        // still see it, and the archive check names it.
        if (isSelf) {
          const balance = (await loadGroupBalances(tx, input.groupId)).find((b) => b.userId === ctx.user.id);
          if (balance && balance.net !== 0) {
            throw new AppError('PRECONDITION_FAILED', 'leaveWithBalance');
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
            const name = targetUser.placeholderName ?? targetUser.name;
            throw name
              ? new AppError('PRECONDITION_FAILED', 'placeholderInUse', { name })
              : new AppError('PRECONDITION_FAILED', 'memberInUse');
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

  // Hands the group to another member, so its owner can leave it (#309). The old
  // owner becomes a plain member: nothing assigns ADMIN, so the new owner would
  // have no way to take it back.
  transferOwnership: groupMemberProcedure
    .input(z.object({ groupId: z.string(), newOwnerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const notOwner = new AppError('FORBIDDEN', 'onlyOwnerTransfers');
      if (ctx.membership.role !== 'OWNER') {
        throw notOwner;
      }
      if (input.newOwnerId === ctx.user.id) {
        throw new AppError('BAD_REQUEST', 'alreadyOwner');
      }

      await ctx.db.$transaction(async (tx) => {
        // A removal or leave takes the same lock, so neither can take the new
        // owner out between the checks and the role change. The caller's role is
        // read again under it: of two transfers sent at once, the second finds
        // they no longer own the group, rather than making a second owner.
        await lockGroupMembers(tx, input.groupId);

        const [owner, newOwner] = await Promise.all([
          tx.groupMember.findUnique({
            where: { userId_groupId: { userId: ctx.user.id, groupId: input.groupId } },
          }),
          tx.groupMember.findUnique({
            where: { userId_groupId: { userId: input.newOwnerId, groupId: input.groupId } },
            include: { user: { select: { isPlaceholder: true, suspendedAt: true } } },
          }),
        ]);
        if (owner?.role !== 'OWNER') {
          throw notOwner;
        }
        if (!newOwner) {
          throw new AppError('NOT_FOUND', 'memberNotFound');
        }
        // Someone who can't sign in couldn't manage the group, or hand it on
        if (newOwner.user.isPlaceholder) {
          throw new AppError('BAD_REQUEST', 'ownerNeedsAccount');
        }
        if (newOwner.user.suspendedAt) {
          throw new AppError('BAD_REQUEST', 'ownerSuspended');
        }

        await tx.groupMember.update({ where: { id: newOwner.id }, data: { role: 'OWNER' } });
        await tx.groupMember.update({ where: { id: owner.id }, data: { role: 'MEMBER' } });
        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'OWNERSHIP_TRANSFERRED',
            metadata: { fromUserId: ctx.user.id, toUserId: input.newOwnerId },
          },
        });
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
        throw new AppError('FORBIDDEN', 'onlyAdminsAddPlaceholder');
      }

      const { randomUUID } = await import('crypto');
      const placeholderEmail = `placeholder-${randomUUID()}@placeholder.local`;

      const user = await ctx.db.$transaction(async (tx) => {
        await lockGroupMembers(tx, input.groupId);
        await assertPlaceholderNameFree(tx, input.groupId, input.name);
        // One write: if the group is deleted meanwhile, the membership can't be made
        // and the placeholder is rolled back with it, instead of staying with no group (#265)
        return tx.user.create({
          data: {
            email: placeholderEmail,
            name: input.name,
            isPlaceholder: true,
            placeholderName: input.name,
            createdByUserId: ctx.user.id,
            groupMembers: { create: { groupId: input.groupId } },
          },
        });
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
        throw new AppError('FORBIDDEN', 'onlyAdminsRenamePlaceholder');
      }
      const user = await ctx.db.user.findUnique({ where: { id: input.placeholderUserId } });
      if (!user?.isPlaceholder) {
        throw new AppError('BAD_REQUEST', 'userNotPlaceholder');
      }
      const membership = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
      });
      if (!membership) {
        throw new AppError('FORBIDDEN', 'placeholderNotMember');
      }
      return ctx.db.$transaction(async (tx) => {
        await lockGroupMembers(tx, input.groupId);
        await assertPlaceholderNameFree(tx, input.groupId, input.name, input.placeholderUserId);
        return tx.user.update({
          where: { id: input.placeholderUserId },
          data: { placeholderName: input.name, name: input.name },
        });
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
        throw new AppError('FORBIDDEN');
      }

      const placeholder = await ctx.db.user.findUnique({
        where: { id: input.placeholderUserId },
      });
      if (!placeholder?.isPlaceholder) {
        throw new AppError('BAD_REQUEST', 'notPlaceholderUser');
      }

      const placeholderMember = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
      });
      if (!placeholderMember) {
        throw new AppError('FORBIDDEN', 'placeholderNotMember');
      }

      const merged = await ctx.db.$transaction((tx) =>
        mergePlaceholderIntoUser(tx, input.placeholderUserId, input.realUserId, input.groupId),
      );
      if (!merged) {
        throw new AppError('CONFLICT', 'placeholderGone');
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
