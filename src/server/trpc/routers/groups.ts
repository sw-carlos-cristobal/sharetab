import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from "../init";

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
          include: { user: { select: { id: true, name: true, email: true, image: true, isPlaceholder: true, placeholderName: true } } },
        },
        _count: { select: { expenses: true } },
      },
      orderBy: { updatedAt: "desc" },
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
          include: { user: { select: { id: true, name: true, email: true, image: true, isPlaceholder: true, placeholderName: true } } },
        },
        _count: { select: { expenses: true } },
      },
      orderBy: { archivedAt: "desc" },
    });
    return groups;
  }),

  get: groupMemberProcedure.query(async ({ ctx, input }) => {
    const group = await ctx.db.group.findUnique({
      where: { id: input.groupId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true, isPlaceholder: true, placeholderName: true, venmoUsername: true } } },
        },
      },
    });
    if (!group) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
    }
    return group;
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        currency: z.string().length(3).regex(/^[a-zA-Z]{3}$/).transform((c) => c.toUpperCase()).default("USD"),
        emoji: z.string().max(4).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.create({
        data: {
          ...input,
          members: {
            create: {
              userId: ctx.user.id,
              role: "OWNER",
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
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        currency: z.string().length(3).regex(/^[a-zA-Z]{3}$/).transform((c) => c.toUpperCase()).optional(),
        emoji: z.string().max(4).optional(),
        simplifyDebts: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === "MEMBER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins and owners can update groups" });
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
              code: "BAD_REQUEST",
              message: "Cannot change group currency after expenses or settlements have been recorded. Create a new group with the desired currency instead.",
            });
          }
        }
      }

      const group = await ctx.db.group.update({
        where: { id: groupId },
        data,
      });
      return group;
    }),

  delete: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can delete a group" });
      }
      await ctx.db.group.delete({ where: { id: input.groupId } });
      return { success: true };
    }),

  archive: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === "MEMBER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins and owners can archive groups" });
      }
      const group = await ctx.db.group.update({
        where: { id: input.groupId },
        data: { archivedAt: new Date() },
      });
      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: "GROUP_ARCHIVED",
          metadata: { name: group.name },
        },
      });
      return group;
    }),

  unarchive: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === "MEMBER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins and owners can unarchive groups" });
      }
      const group = await ctx.db.group.update({
        where: { id: input.groupId },
        data: { archivedAt: null },
      });
      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: "GROUP_UNARCHIVED",
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.groupInvite.create({
        data: {
          groupId: input.groupId,
          email: input.email,
          placeholderUserId: input.placeholderUserId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        },
      });
      return { token: invite.token };
    }),

  joinByInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.groupInvite.findUnique({
        where: { token: input.token },
      });
      if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired invite" });
      }

      const existing = await ctx.db.groupMember.findUnique({
        where: {
          userId_groupId: { userId: ctx.user.id, groupId: invite.groupId },
        },
      });
      if (existing) {
        // Intentional: invite links are reusable for navigation purposes.
        // usedAt/usedById only track the first redemption that creates a membership.
        // An already-member user can still use the link to navigate to the group.
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
            type: "MEMBER_JOINED",
          },
        }),
      ]);

      // Auto-merge placeholder if invite was linked to one
      if (invite.placeholderUserId) {
        await mergePlaceholderIntoUser(ctx.db, invite.placeholderUserId, ctx.user.id, invite.groupId);
      }

      return { groupId: invite.groupId, alreadyMember: false };
    }),

  removeMember: groupMemberProcedure
    .input(z.object({ groupId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const isSelf = input.userId === ctx.user.id;
      const isAdmin = ctx.membership.role === "OWNER" || ctx.membership.role === "ADMIN";

      if (!isSelf && !isAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot remove other members" });
      }

      const targetMember = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.userId, groupId: input.groupId } },
      });
      if (!targetMember) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
      }
      if (targetMember.role === "OWNER" && !isSelf) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot remove the owner" });
      }

      const targetUser = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { isPlaceholder: true },
      });

      if (targetUser?.isPlaceholder) {
        // Placeholder cleanup: redistribute shares, reassign expenses, then hard-delete the user
        await ctx.db.$transaction(async (tx) => {
          // 1. Redistribute expense shares to each expense's payer
          const shares = await tx.expenseShare.findMany({
            where: { userId: input.userId, expense: { groupId: input.groupId } },
            include: { expense: { select: { paidById: true } } },
          });

          for (const share of shares) {
            // If the placeholder was the payer, redistribute to the acting admin
            const payerId =
              share.expense.paidById === input.userId ? ctx.user.id : share.expense.paidById;

            const existing = await tx.expenseShare.findUnique({
              where: { expenseId_userId: { expenseId: share.expenseId, userId: payerId } },
            });
            if (existing) {
              await tx.expenseShare.update({
                where: { id: existing.id },
                data: { amount: existing.amount + share.amount },
              });
            } else {
              await tx.expenseShare.create({
                data: { expenseId: share.expenseId, userId: payerId, amount: share.amount },
              });
            }
            await tx.expenseShare.delete({ where: { id: share.id } });
          }

          // 2. Reassign expenses where the placeholder was payer or creator
          await tx.expense.updateMany({
            where: { paidById: input.userId, groupId: input.groupId },
            data: { paidById: ctx.user.id },
          });
          await tx.expense.updateMany({
            where: { addedById: input.userId, groupId: input.groupId },
            data: { addedById: ctx.user.id },
          });

          // 3. Delete settlements involving the placeholder in this group
          await tx.settlement.deleteMany({
            where: { groupId: input.groupId, OR: [{ fromId: input.userId }, { toId: input.userId }] },
          });

          // 4. Delete receipt item assignments for the placeholder
          await tx.receiptItemAssignment.deleteMany({ where: { userId: input.userId } });

          // 5. Delete any activity log entries for the placeholder
          await tx.activityLog.deleteMany({ where: { userId: input.userId } });

          // 6. Log the removal before deleting the user
          await tx.activityLog.create({
            data: {
              groupId: input.groupId,
              userId: ctx.user.id,
              type: "MEMBER_LEFT",
              metadata: { removedUserId: input.userId, wasPlaceholder: true },
            },
          });

          // 7. Delete the placeholder user record (GroupMember cascades automatically)
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
              type: "MEMBER_LEFT",
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
        name: z.string().min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === "MEMBER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins and owners can add placeholder members" });
      }

      const { randomUUID } = await import("crypto");
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
          type: "PLACEHOLDER_CREATED",
          metadata: { placeholderName: input.name, placeholderUserId: user.id },
        },
      });

      return { id: user.id, name: user.name, isPlaceholder: true };
    }),

  renamePlaceholder: groupMemberProcedure
    .input(z.object({ groupId: z.string(), placeholderUserId: z.string(), name: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins and owners can rename placeholder members" });
      }
      const user = await ctx.db.user.findUnique({ where: { id: input.placeholderUserId } });
      if (!user?.isPlaceholder) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "User is not a placeholder" });
      }
      const membership = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
      });
      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Placeholder is not a member of this group" });
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const placeholder = await ctx.db.user.findUnique({
        where: { id: input.placeholderUserId },
      });
      if (!placeholder?.isPlaceholder) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not a placeholder user" });
      }

      const placeholderMember = await ctx.db.groupMember.findUnique({
        where: { userId_groupId: { userId: input.placeholderUserId, groupId: input.groupId } },
      });
      if (!placeholderMember) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Placeholder is not a member of this group" });
      }

      // Verify realUserId is a member of the same group
      const realUserMember = await ctx.db.groupMember.findUnique({
        where: {
          userId_groupId: { userId: input.realUserId, groupId: input.groupId },
        },
      });
      if (!realUserMember) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Target user is not a member of this group",
        });
      }

      await mergePlaceholderIntoUser(ctx.db, input.placeholderUserId, input.realUserId, input.groupId);

      return { success: true };
    }),
});

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
            OR: [
              { expense: { groupId } },
              { groupId },
            ],
          },
        },
        select: { id: true },
      })
    ).map((ri) => ri.id);
    if (groupReceiptItemIds.length > 0) {
      await tx.receiptItemAssignment.updateMany({
        where: { userId: placeholderUserId, receiptItemId: { in: groupReceiptItemIds } },
        data: { userId: realUserId },
      });
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
        type: "PLACEHOLDER_MERGED",
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
