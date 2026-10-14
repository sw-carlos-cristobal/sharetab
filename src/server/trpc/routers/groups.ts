import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from '../init';
import { stripUndefined } from '../../lib/strip-undefined';
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
    const group = await ctx.db.group.update({
      where: { id: input.groupId },
      data: { archivedAt: new Date() },
    });
    await ctx.db.activityLog.create({
      data: {
        groupId: input.groupId,
        userId: ctx.user.id,
        type: 'GROUP_ARCHIVED',
        metadata: { name: group.name },
      },
    });
    return group;
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
          select: { isPlaceholder: true },
        });
        if (!placeholder?.isPlaceholder) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a placeholder user' });
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
        group: { select: { name: true, _count: { select: { members: true } } } },
        createdBy: { select: { name: true, isPlaceholder: true, suspendedAt: true } },
      },
    });
    if (!invite || !isRedeemable(invite)) return null;
    // Name only an active account: a deleted one becomes a placeholder named "Deleted user",
    // and a suspended one shouldn't be vouching for anything.
    const inviter = invite.createdBy;
    const inviterName = inviter && !inviter.isPlaceholder && !inviter.suspendedAt ? inviter.name : null;
    return {
      groupName: invite.group.name,
      inviterName,
      memberCount: invite.group._count.members,
    };
  }),

  joinByInvite: protectedProcedure.input(z.object({ token: inviteTokenSchema })).mutation(async ({ ctx, input }) => {
    const invite = await ctx.db.groupInvite.findUnique({
      where: { token: input.token },
    });
    if (!invite || !isRedeemable(invite)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or expired invite' });
    }

    const existing = await ctx.db.groupMember.findUnique({
      where: {
        userId_groupId: { userId: ctx.user.id, groupId: invite.groupId },
      },
    });
    if (existing) {
      // A member opening an unused link is sent to the group without using it up:
      // usedAt/usedById only track the redemption that creates a membership. Once
      // someone has redeemed it, the isRedeemable check above refuses it for everyone.
      return { groupId: invite.groupId, alreadyMember: true };
    }

    await ctx.db.$transaction([
      ctx.db.groupMember.create({
        data: { userId: ctx.user.id, groupId: invite.groupId },
      }),
      ctx.db.groupInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date(), usedById: ctx.user.id },
      }),
      ctx.db.activityLog.create({
        data: {
          groupId: invite.groupId,
          userId: ctx.user.id,
          type: 'MEMBER_JOINED',
        },
      }),
    ]);

    // Auto-merge placeholder if invite was linked to one. Re-validate at
    // redemption: the linked user must still be a placeholder member of this
    // group (it may have been merged, removed, or never have been valid).
    if (invite.placeholderUserId) {
      const placeholder = await ctx.db.user.findUnique({
        where: { id: invite.placeholderUserId },
        select: { isPlaceholder: true },
      });
      const placeholderMembership = placeholder?.isPlaceholder
        ? await ctx.db.groupMember.findUnique({
            where: {
              userId_groupId: { userId: invite.placeholderUserId, groupId: invite.groupId },
            },
          })
        : null;
      if (placeholder?.isPlaceholder && placeholderMembership) {
        await mergePlaceholderIntoUser(ctx.db, invite.placeholderUserId, ctx.user.id, invite.groupId);
      }
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

      const targetUser = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { isPlaceholder: true, name: true, placeholderName: true },
      });

      if (targetUser?.isPlaceholder) {
        // A placeholder can't log in to settle up, rejoin or be merged once
        // gone, so one who is in any expense or payment stays. Moving their part
        // onto other people writes off what they owe or are owed, and dropping
        // only the membership leaves a balance that comes back (say an old
        // expense is deleted) with nobody able to settle it.
        const [shares, expenses, settlements] = await Promise.all([
          ctx.db.expenseShare.count({ where: { userId: input.userId } }),
          ctx.db.expense.count({ where: { OR: [{ paidById: input.userId }, { addedById: input.userId }] } }),
          ctx.db.settlement.count({ where: { OR: [{ fromId: input.userId }, { toId: input.userId }] } }),
        ]);
        if (shares + expenses + settlements > 0) {
          const name = targetUser.placeholderName ?? targetUser.name ?? 'This member';
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `${name} is in expenses or payments in this group, so they can't be removed. Take them out of those first.`,
          });
        }

        await ctx.db.$transaction(async (tx) => {
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
        });
      } else {
        // Real user — preserve financial history, just remove the membership
        await ctx.db.$transaction([
          ctx.db.groupMember.delete({ where: { id: targetMember.id } }),
          ctx.db.activityLog.create({
            data: {
              groupId: input.groupId,
              userId: ctx.user.id,
              type: 'MEMBER_LEFT',
              metadata: { removedUserId: input.userId },
            },
          }),
        ]);
      }

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

      // Verify realUserId is a member of the same group
      const realUserMember = await ctx.db.groupMember.findUnique({
        where: {
          userId_groupId: { userId: input.realUserId, groupId: input.groupId },
        },
      });
      if (!realUserMember) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Target user is not a member of this group',
        });
      }

      await mergePlaceholderIntoUser(ctx.db, input.placeholderUserId, input.realUserId, input.groupId);

      return { success: true };
    }),
});

/** Whether an invite can still be used to join: not used yet and not expired. */
function isRedeemable(invite: { usedAt: Date | null; expiresAt: Date }) {
  return !invite.usedAt && invite.expiresAt >= new Date();
}

/**
 * Merge all references from a placeholder user into a real user, then delete the placeholder.
 */
async function mergePlaceholderIntoUser(
  db: PrismaClient,
  placeholderUserId: string,
  realUserId: string,
  groupId: string,
) {
  await db.$transaction(async (tx) => {
    // Hard guard: this helper reassigns financial history and may delete the
    // user row, so it must never run against a real (non-placeholder) account.
    const placeholder = await tx.user.findUnique({
      where: { id: placeholderUserId },
      select: { isPlaceholder: true },
    });
    if (!placeholder?.isPlaceholder) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a placeholder user' });
    }

    const groupExpenseIds = (
      await tx.expense.findMany({
        where: { groupId },
        select: { id: true },
      })
    ).map((e) => e.id);

    const shares = await tx.expenseShare.findMany({
      where: { userId: placeholderUserId, expenseId: { in: groupExpenseIds } },
    });
    for (const share of shares) {
      const existing = await tx.expenseShare.findUnique({
        where: { expenseId_userId: { expenseId: share.expenseId, userId: realUserId } },
      });
      if (existing) {
        await tx.expenseShare.update({
          where: { id: existing.id },
          data: { amount: existing.amount + share.amount },
        });
        await tx.expenseShare.delete({ where: { id: share.id } });
      } else {
        await tx.expenseShare.update({
          where: { id: share.id },
          data: { userId: realUserId },
        });
      }
    }

    const groupReceiptItemIds = (
      await tx.receiptItem.findMany({
        where: {
          receipt: {
            OR: [{ expense: { groupId } }, { groupId }],
          },
        },
        select: { id: true },
      })
    ).map((ri) => ri.id);
    if (groupReceiptItemIds.length > 0) {
      const placeholderAssignments = await tx.receiptItemAssignment.findMany({
        where: { userId: placeholderUserId, receiptItemId: { in: groupReceiptItemIds } },
      });
      for (const assignment of placeholderAssignments) {
        const existing = await tx.receiptItemAssignment.findFirst({
          where: { receiptItemId: assignment.receiptItemId, userId: realUserId },
        });
        if (existing) {
          await tx.receiptItemAssignment.delete({ where: { id: assignment.id } });
        } else {
          await tx.receiptItemAssignment.update({
            where: { id: assignment.id },
            data: { userId: realUserId },
          });
        }
      }
    }

    await tx.expense.updateMany({
      where: { paidById: placeholderUserId, groupId },
      data: { paidById: realUserId },
    });
    await tx.expense.updateMany({
      where: { addedById: placeholderUserId, groupId },
      data: { addedById: realUserId },
    });

    await tx.settlement.updateMany({
      where: { fromId: placeholderUserId, groupId },
      data: { fromId: realUserId },
    });
    await tx.settlement.updateMany({
      where: { toId: placeholderUserId, groupId },
      data: { toId: realUserId },
    });

    await tx.activityLog.updateMany({
      where: { userId: placeholderUserId, groupId },
      data: { userId: realUserId },
    });

    await tx.groupMember.deleteMany({
      where: { userId: placeholderUserId, groupId },
    });

    await tx.activityLog.create({
      data: {
        groupId,
        userId: realUserId,
        type: 'PLACEHOLDER_MERGED',
        metadata: { mergedPlaceholderId: placeholderUserId },
      },
    });

    const remainingMemberships = await tx.groupMember.count({
      where: { userId: placeholderUserId },
    });
    if (remainingMemberships === 0) {
      await tx.user.delete({ where: { id: placeholderUserId } });
    }
  });
}
