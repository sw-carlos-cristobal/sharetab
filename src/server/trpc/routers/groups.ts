import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from "../init";

export const groupsRouter = createTRPCRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      where: {
        members: { some: { userId: ctx.user.id } },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
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
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.groupInvite.create({
        data: {
          groupId: input.groupId,
          email: input.email,
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
});
