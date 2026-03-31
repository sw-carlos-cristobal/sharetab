import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from "../init";

export const groupsRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: {
        members: { some: { userId: ctx.user.id } },
      },
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

  get: groupMemberProcedure.query(async ({ ctx, input }) => {
    const group = await ctx.db.group.findUnique({
      where: { id: input.groupId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true, isPlaceholder: true, placeholderName: true } } },
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
        currency: z.string().length(3).default("USD"),
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
        currency: z.string().length(3).optional(),
        emoji: z.string().max(4).optional(),
        simplifyDebts: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role === "MEMBER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins and owners can update groups" });
      }
      const { groupId, ...data } = input;
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

      await ctx.db.$transaction([
        ctx.db.groupMember.delete({
          where: { id: targetMember.id },
        }),
        ctx.db.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: "MEMBER_LEFT",
            metadata: { removedUserId: input.userId },
          },
        }),
      ]);

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

      const placeholderEmail = `placeholder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@placeholder.local`;

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
      return ctx.db.user.update({
        where: { id: input.placeholderUserId },
        data: { placeholderName: input.name },
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

      await mergePlaceholderIntoUser(ctx.db, input.placeholderUserId, input.realUserId, input.groupId);

      return { success: true };
    }),
});

/**
 * Merge all references from a placeholder user into a real user, then delete the placeholder.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mergePlaceholderIntoUser(
  db: any,
  placeholderUserId: string,
  realUserId: string,
  groupId: string,
) {
  await db.$transaction(async (tx: typeof db) => {
    // Reassign expense shares (skip if real user already has a share on the same expense)
    const shares = await tx.expenseShare.findMany({ where: { userId: placeholderUserId } });
    for (const share of shares) {
      const existing = await tx.expenseShare.findUnique({
        where: { expenseId_userId: { expenseId: share.expenseId, userId: realUserId } },
      });
      if (existing) {
        // Merge amounts
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

    // Reassign receipt item assignments
    await tx.receiptItemAssignment.updateMany({
      where: { userId: placeholderUserId },
      data: { userId: realUserId },
    });

    // Reassign expenses paid by placeholder
    await tx.expense.updateMany({
      where: { paidById: placeholderUserId },
      data: { paidById: realUserId },
    });
    await tx.expense.updateMany({
      where: { addedById: placeholderUserId },
      data: { addedById: realUserId },
    });

    // Reassign settlements
    await tx.settlement.updateMany({
      where: { fromId: placeholderUserId },
      data: { fromId: realUserId },
    });
    await tx.settlement.updateMany({
      where: { toId: placeholderUserId },
      data: { toId: realUserId },
    });

    // Reassign activity logs
    await tx.activityLog.updateMany({
      where: { userId: placeholderUserId },
      data: { userId: realUserId },
    });

    // Remove placeholder group membership
    await tx.groupMember.deleteMany({
      where: { userId: placeholderUserId, groupId },
    });

    // Log the merge
    await tx.activityLog.create({
      data: {
        groupId,
        userId: realUserId,
        type: "PLACEHOLDER_MERGED",
        metadata: { mergedPlaceholderId: placeholderUserId },
      },
    });

    // Delete the placeholder user
    await tx.user.delete({ where: { id: placeholderUserId } });
  });
}
