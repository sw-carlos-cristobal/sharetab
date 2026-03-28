import { z } from "zod";
import { createTRPCRouter, groupMemberProcedure, protectedProcedure } from "../init";

export const activityRouter = createTRPCRouter({
  getGroupActivity: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.activityLog.findMany({
        where: { groupId: input.groupId },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, image: true } },
        },
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return { items, nextCursor };
    }),

  getRecentActivity: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      const userGroups = await ctx.db.groupMember.findMany({
        where: { userId: ctx.user.id },
        select: { groupId: true },
      });
      const groupIds = userGroups.map((g) => g.groupId);

      return ctx.db.activityLog.findMany({
        where: { groupId: { in: groupIds } },
        take: input.limit,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, image: true } },
          group: { select: { id: true, name: true } },
        },
      });
    }),
});
