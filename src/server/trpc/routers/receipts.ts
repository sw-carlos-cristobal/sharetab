import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from "../init";
import { processReceiptImage } from "../../lib/receipt-processor";
import { logger } from "../../lib/logger";
import {
  getAIProvidersWithFallback,
  getConfiguredProviderPriority,
} from "@/server/ai/registry";

/**
 * Verify that a receipt exists and the user has access to it (via group membership).
 * When additional `include` fields are passed, the return type is widened since
 * Prisma cannot statically infer dynamic includes -- callers should cast as needed.
 */
async function verifyReceiptAccess(
  db: PrismaClient,
  receiptId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  include?: Record<string, any>
) {
  const receipt = await db.receipt.findUnique({
    where: { id: receiptId },
    include: { group: { include: { members: true } }, ...include },
  });
  if (!receipt) throw new TRPCError({ code: "NOT_FOUND" });
  if (receipt.group) {
    const isMember = receipt.group.members.some((m: { userId: string }) => m.userId === userId);
    if (!isMember) throw new TRPCError({ code: "FORBIDDEN" });
  } else {
    // Ungrouped receipt: only the uploader can access it
    if (receipt.uploadedById !== userId) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
  }
  return receipt;
}

export const receiptsRouter = createTRPCRouter({
  getScanProviderInfo: protectedProcedure.query(async () => {
    try {
      const configured = getConfiguredProviderPriority();
      const [active] = await getAIProvidersWithFallback();
      return {
        configuredProviders: configured,
        activeProvider: active?.name ?? null,
      };
    } catch {
      // Keep response shape stable even if provider checks fail.
      return {
        configuredProviders: [],
        activeProvider: null,
      };
    }
  }),

  processReceipt: protectedProcedure
    .input(z.object({
      receiptId: z.string(),
      groupId: z.string().optional(),
      correctionHint: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found" });
      }

      // Note: old items are NOT deleted here — processReceiptImage handles
      // delete + recreate atomically, so if the AI provider fails the old items remain.

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: {
          status: "PROCESSING",
          ...(input.groupId ? { groupId: input.groupId, savedById: ctx.user.id } : {}),
        },
      });

      try {
        return await processReceiptImage({
          db: ctx.db,
          receiptId: input.receiptId,
          receipt,
          correctionHint: input.correctionHint,
          logPrefix: "receipt",
        });
      } catch (error) {
        logger.error("receipt.failed", {
          receiptId: input.receiptId,
          error: error instanceof Error ? error.message : "Unknown",
        });
        await ctx.db.receipt.update({
          where: { id: input.receiptId },
          data: {
            status: "FAILED",
            rawResponse: {
              error: error instanceof Error ? error.message : "Unknown error",
            } as unknown as Prisma.InputJsonValue,
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
      const receipt = await verifyReceiptAccess(
        ctx.db,
        input.receiptId,
        ctx.user.id,
        {
          items: {
            orderBy: { sortOrder: "asc" },
            include: { assignments: true },
          },
        }
      );

      type ReceiptItem = {
        id: string;
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        sortOrder: number;
        assignments: { id: string; receiptItemId: string; userId: string; shareOfItem: number }[];
      };

      const receiptWithItems = receipt as typeof receipt & { items: ReceiptItem[] };

      return {
        receipt: {
          id: receiptWithItems.id,
          status: receiptWithItems.status,
          imagePath: receiptWithItems.imagePath,
          paidById: receiptWithItems.paidById,
          extractedData: receiptWithItems.extractedData as {
            merchantName?: string;
            date?: string;
            subtotal: number;
            tax: number;
            tip: number;
            total: number;
            currency: string;
          } | null,
        },
        items: receiptWithItems.items as ReceiptItem[],
      };
    }),

  updateItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        name: z.string().min(1).max(200).optional(),
        quantity: z.number().int().min(1).optional(),
        unitPrice: z.number().int().min(0).optional(),
        totalPrice: z.number().int().min(0).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new TRPCError({ code: "NOT_FOUND" });
      await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      const { itemId, ...data } = input;
      return ctx.db.receiptItem.update({
        where: { id: itemId },
        data,
      });
    }),

  addItem: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).default(1),
        unitPrice: z.number().int().min(0),
        totalPrice: z.number().int().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const maxSort = await ctx.db.receiptItem.findFirst({
        where: { receiptId: input.receiptId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      return ctx.db.receiptItem.create({
        data: {
          receiptId: input.receiptId,
          name: input.name,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          totalPrice: input.totalPrice,
          sortOrder: (maxSort?.sortOrder ?? 0) + 1,
        },
      });
    }),

  deleteItem: protectedProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new TRPCError({ code: "NOT_FOUND" });
      await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      await ctx.db.receiptItemAssignment.deleteMany({
        where: { receiptItemId: input.itemId },
      });
      await ctx.db.receiptItem.delete({ where: { id: input.itemId } });
      return { success: true };
    }),

  updateExtractedData: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        tax: z.number().int().min(0).optional(),
        tip: z.number().int().min(0).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const current = (receipt.extractedData ?? {}) as Record<string, unknown>;
      const updated = {
        ...current,
        ...(input.tax !== undefined ? { tax: input.tax } : {}),
        ...(input.tip !== undefined ? { tip: input.tip } : {}),
      };

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { extractedData: updated as unknown as Prisma.InputJsonValue },
      });
      return { success: true };
    }),

  retryProcessing: protectedProcedure
    .input(z.object({ receiptId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      // Reset status to PROCESSING and re-run extraction
      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { status: "PROCESSING" },
      });

      try {
        return await processReceiptImage({
          db: ctx.db,
          receiptId: input.receiptId,
          receipt: { imagePath: receipt.imagePath, mimeType: receipt.mimeType },
          logPrefix: "receipt.retry",
        });
      } catch (error) {
        await ctx.db.receipt.update({
          where: { id: input.receiptId },
          data: {
            status: "FAILED",
            rawResponse: { error: error instanceof Error ? error.message : "Unknown error" } as unknown as Prisma.InputJsonValue,
          },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Reprocessing failed",
        });
      }
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
      // Verify group is not archived
      const group = await ctx.db.group.findUnique({ where: { id: input.groupId } });
      if (group?.archivedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot create expenses in archived groups" });
      }

      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: { items: true },
      });
      if (!receipt || receipt.status !== "COMPLETED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Receipt not ready" });
      }

      // Verify the caller has access to this receipt
      if (receipt.groupId) {
        // If already assigned to a group, it must match the target group
        if (receipt.groupId !== input.groupId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Receipt belongs to a different group" });
        }
      } else {
        // Ungrouped receipt: only the uploader can use it
        if (receipt.uploadedById !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
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

      // Verify paidBy and all assignees are members of this group
      const groupMembers = await ctx.db.groupMember.findMany({
        where: { groupId: input.groupId },
        select: { userId: true },
      });
      const memberIds = new Set(groupMembers.map((m) => m.userId));
      if (!memberIds.has(input.paidById)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Payer is not a member of this group" });
      }
      for (const a of input.assignments) {
        for (const uid of a.userIds) {
          if (!memberIds.has(uid)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Assignee is not a member of this group" });
          }
        }
      }

      // Build item map and verify all referenced items belong to this receipt
      const itemMap = new Map(receipt.items.map((item) => [item.id, item]));
      for (const a of input.assignments) {
        if (!itemMap.has(a.receiptItemId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Item does not belong to this receipt" });
        }
      }

      // Calculate per-user item subtotals
      const userSubtotals = new Map<string, number>();

      for (const assignment of input.assignments) {
        const item = itemMap.get(assignment.receiptItemId)!;

        const perPerson = Math.floor(item.totalPrice / assignment.userIds.length);
        const remainder = item.totalPrice - perPerson * assignment.userIds.length;

        for (let i = 0; i < assignment.userIds.length; i++) {
          const userId = assignment.userIds[i];
          const amount = perPerson + (i < remainder ? 1 : 0);
          userSubtotals.set(userId, (userSubtotals.get(userId) ?? 0) + amount);
        }
      }

      // Proportionally distribute tax and tip using receipt subtotal as denominator.
      // This ensures each assigned item gets its fair share of tax/tip relative to
      // the full receipt subtotal, even when not all items are assigned.
      const actualSubtotal = Array.from(userSubtotals.values()).reduce(
        (a, b) => a + b,
        0
      );
      const receiptSubtotal = extractedData.subtotal > 0 ? extractedData.subtotal : actualSubtotal;
      const totalAmount = actualSubtotal + tax + tip;

      const userTotals = new Map<string, number>();
      let allocatedTotal = 0;
      const userEntries = Array.from(userSubtotals.entries());

      for (let i = 0; i < userEntries.length; i++) {
        const [userId, itemTotal] = userEntries[i];
        const proportion = receiptSubtotal > 0 ? itemTotal / receiptSubtotal : 0;

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

      // Save assignments in a single batch (replaces N×M individual upserts)
      const assignmentData = input.assignments.flatMap((a) =>
        a.userIds.map((userId) => ({
          receiptItemId: a.receiptItemId,
          userId,
        }))
      );

      // All writes in a single transaction for atomicity
      const expense = await ctx.db.$transaction(async (tx) => {
        const exp = await tx.expense.create({
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

        const itemIds = [...new Set(input.assignments.map((a) => a.receiptItemId))];
        await tx.receiptItemAssignment.deleteMany({
          where: { receiptItemId: { in: itemIds } },
        });
        await tx.receiptItemAssignment.createMany({
          data: assignmentData,
          skipDuplicates: true,
        });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: "EXPENSE_CREATED",
            entityId: exp.id,
            metadata: { title: input.title, amount: totalAmount, fromReceipt: true },
          },
        });

        return exp;
      });

      return expense;
    }),

  saveForLater: groupMemberProcedure
    .input(z.object({
      groupId: z.string(),
      receiptId: z.string(),
      paidById: z.string().optional(),
      assignments: z.array(z.object({
        receiptItemId: z.string(),
        userIds: z.array(z.string()),
      })).optional(),
    }))
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
        data: {
          groupId: input.groupId,
          savedById: ctx.user.id,
          paidById: input.paidById,
        },
      });

      // Save partial assignments if provided
      if (input.assignments && input.assignments.length > 0) {
        // Clear any existing assignments first
        await ctx.db.receiptItemAssignment.deleteMany({
          where: {
            receiptItem: { receiptId: input.receiptId },
          },
        });

        // Create new assignments
        const assignmentData = input.assignments.flatMap((a) =>
          a.userIds.map((userId) => ({
            receiptItemId: a.receiptItemId,
            userId,
          }))
        );
        if (assignmentData.length > 0) {
          await ctx.db.receiptItemAssignment.createMany({
            data: assignmentData,
          });
        }
      }

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
      // Only the uploader or the person who saved it can delete it
      const isUploader = receipt.uploadedById === ctx.user.id;
      const isSaver = receipt.savedById && receipt.savedById === ctx.user.id;
      if (!isUploader && !isSaver) {
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

      // Clean up the uploaded image file
      try {
        const { unlink } = await import("fs/promises");
        const { join } = await import("path");
        const { getUploadDir } = await import("../../lib/upload-dir");
        const filepath = join(getUploadDir(), receipt.imagePath);
        await unlink(filepath);
      } catch {
        // Non-fatal: file may already be missing
        logger.warn("receipt.delete.fileCleanupFailed", {
          receiptId: input.receiptId,
          imagePath: receipt.imagePath,
        });
      }

      return { success: true };
    }),
});
