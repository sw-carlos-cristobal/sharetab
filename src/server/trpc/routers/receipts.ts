import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@/generated/prisma/client";
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from "../init";
import { getAIProvider } from "../../ai/registry";

export const receiptsRouter = createTRPCRouter({
  processReceipt: protectedProcedure
    .input(z.object({ receiptId: z.string(), groupId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
      });
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found" });
      }

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: {
          status: "PROCESSING",
          ...(input.groupId ? { groupId: input.groupId, savedById: ctx.session!.user!.id } : {}),
        },
      });

      try {
        const { readFile } = await import("fs/promises");
        const { join } = await import("path");
        const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
        const filepath = join(uploadDir, receipt.imagePath);
        const imageBuffer = await readFile(filepath);

        const provider = await getAIProvider();
        const result = await provider.extractReceipt(imageBuffer, receipt.mimeType);

        // Create receipt items in DB
        await ctx.db.receiptItem.createMany({
          data: result.items.map((item, i) => ({
            receiptId: input.receiptId,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
            sortOrder: i,
          })),
        });

        await ctx.db.receipt.update({
          where: { id: input.receiptId },
          data: {
            status: "COMPLETED",
            aiProvider: provider.name,
            rawResponse: JSON.parse(JSON.stringify(result)),
            extractedData: JSON.parse(JSON.stringify({
              merchantName: result.merchantName,
              date: result.date,
              subtotal: result.subtotal,
              tax: result.tax,
              tip: result.tip,
              total: result.total,
              currency: result.currency,
            })),
          },
        });

        return {
          status: "COMPLETED" as const,
          merchantName: result.merchantName,
          date: result.date,
          subtotal: result.subtotal,
          tax: result.tax,
          tip: result.tip,
          total: result.total,
          currency: result.currency,
          itemCount: result.items.length,
        };
      } catch (error) {
        await ctx.db.receipt.update({
          where: { id: input.receiptId },
          data: {
            status: "FAILED",
            rawResponse: JSON.parse(JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            })),
          },
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Receipt processing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }),

  getReceiptItems: protectedProcedure
    .input(z.object({ receiptId: z.string() }))
    .query(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: {
          items: {
            orderBy: { sortOrder: "asc" },
            include: { assignments: true },
          },
        },
      });
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return {
        receipt: {
          id: receipt.id,
          status: receipt.status,
          extractedData: receipt.extractedData as {
            merchantName?: string;
            date?: string;
            subtotal: number;
            tax: number;
            tip: number;
            total: number;
            currency: string;
          } | null,
        },
        items: receipt.items,
      };
    }),

  retryProcessing: protectedProcedure
    .input(z.object({ receiptId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Delete old items before retrying
      await ctx.db.receiptItem.deleteMany({
        where: { receiptId: input.receiptId },
      });
      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: {
          status: "PENDING",
          rawResponse: Prisma.JsonNull,
          extractedData: Prisma.JsonNull,
        },
      });
      return { success: true };
    }),

  assignItemsAndCreateExpense: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        receiptId: z.string(),
        title: z.string().min(1).max(200),
        paidById: z.string(),
        tipOverride: z.number().int().min(0).optional(),
        assignments: z.array(
          z.object({
            receiptItemId: z.string(),
            userIds: z.array(z.string()).min(1),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: { items: true },
      });
      if (!receipt || receipt.status !== "COMPLETED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt not ready" });
      }

      const extractedData = receipt.extractedData as {
        subtotal: number;
        tax: number;
        tip: number;
        total: number;
        currency: string;
      };

      const tax = extractedData.tax;
      const tip = input.tipOverride ?? extractedData.tip;
      const subtotal = extractedData.subtotal;

      // Build item map
      const itemMap = new Map(receipt.items.map((item) => [item.id, item]));

      // Calculate per-user item subtotals
      const userSubtotals = new Map<string, number>();

      for (const assignment of input.assignments) {
        const item = itemMap.get(assignment.receiptItemId);
        if (!item) continue;

        const perPerson = Math.floor(item.totalPrice / assignment.userIds.length);
        const remainder = item.totalPrice - perPerson * assignment.userIds.length;

        for (let i = 0; i < assignment.userIds.length; i++) {
          const userId = assignment.userIds[i];
          const amount = perPerson + (i < remainder ? 1 : 0);
          userSubtotals.set(userId, (userSubtotals.get(userId) ?? 0) + amount);
        }
      }

      // Proportionally distribute tax and tip
      const actualSubtotal = Array.from(userSubtotals.values()).reduce(
        (a, b) => a + b,
        0
      );
      const totalAmount = actualSubtotal + tax + tip;

      const userTotals = new Map<string, number>();
      let allocatedTotal = 0;
      const userEntries = Array.from(userSubtotals.entries());

      for (let i = 0; i < userEntries.length; i++) {
        const [userId, itemTotal] = userEntries[i];
        const proportion = actualSubtotal > 0 ? itemTotal / actualSubtotal : 0;

        let userTax: number;
        let userTip: number;

        if (i === userEntries.length - 1) {
          // Last user gets remainder to prevent off-by-one
          const alreadyAllocated = allocatedTotal;
          const userTotal = totalAmount - alreadyAllocated;
          userTotals.set(userId, userTotal);
          allocatedTotal += userTotal;
        } else {
          userTax = Math.round(tax * proportion);
          userTip = Math.round(tip * proportion);
          const userTotal = itemTotal + userTax + userTip;
          userTotals.set(userId, userTotal);
          allocatedTotal += userTotal;
        }
      }

      // Create expense with ITEM split mode
      const expense = await ctx.db.expense.create({
        data: {
          groupId: input.groupId,
          title: input.title,
          amount: totalAmount,
          currency: extractedData.currency,
          splitMode: "ITEM",
          paidById: input.paidById,
          addedById: ctx.user.id,
          receiptId: input.receiptId,
          shares: {
            create: Array.from(userTotals.entries()).map(([userId, amount]) => ({
              userId,
              amount,
            })),
          },
        },
      });

      // Save assignments for reference
      for (const assignment of input.assignments) {
        for (const userId of assignment.userIds) {
          await ctx.db.receiptItemAssignment.upsert({
            where: {
              receiptItemId_userId: {
                receiptItemId: assignment.receiptItemId,
                userId,
              },
            },
            create: {
              receiptItemId: assignment.receiptItemId,
              userId,
            },
            update: {},
          });
        }
      }

      await ctx.db.activityLog.create({
        data: {
          groupId: input.groupId,
          userId: ctx.user.id,
          type: "EXPENSE_CREATED",
          entityId: expense.id,
          metadata: { title: input.title, amount: totalAmount, fromReceipt: true },
        },
      });

      return expense;
    }),

  saveForLater: groupMemberProcedure
    .input(z.object({ groupId: z.string(), receiptId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
      });
      if (!receipt || receipt.status !== "COMPLETED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt must be processed first" });
      }
      // Check it's not already linked to an expense
      const existing = await ctx.db.expense.findUnique({
        where: { receiptId: input.receiptId },
      });
      if (existing) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt already has an expense" });
      }

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { groupId: input.groupId, savedById: ctx.user.id },
      });
      return { success: true };
    }),

  listPending: groupMemberProcedure
    .input(z.object({ groupId: z.string() }))
    .query(async ({ ctx, input }) => {
      const receipts = await ctx.db.receipt.findMany({
        where: {
          groupId: input.groupId,
          status: "COMPLETED",
          expense: null,
        },
        orderBy: { createdAt: "desc" },
      });

      return receipts.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        extractedData: r.extractedData as {
          merchantName?: string;
          date?: string;
          subtotal: number;
          tax: number;
          tip: number;
          total: number;
          currency: string;
        } | null,
      }));
    }),

  deletePending: protectedProcedure
    .input(z.object({ receiptId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
      });
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      // Only the person who saved it can delete it
      if (receipt.savedById && receipt.savedById !== ctx.session!.user!.id) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      // Can't delete if already linked to expense
      const expense = await ctx.db.expense.findUnique({
        where: { receiptId: input.receiptId },
      });
      if (expense) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt has an expense" });
      }

      await ctx.db.receiptItem.deleteMany({ where: { receiptId: input.receiptId } });
      await ctx.db.receipt.delete({ where: { id: input.receiptId } });
      return { success: true };
    }),
});
