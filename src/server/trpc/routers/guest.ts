import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@/generated/prisma/client";
import { createTRPCRouter, publicProcedure } from "../init";
import { processReceiptImage } from "../../lib/receipt-processor";
import { logger } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limit";
import { calculateSplitTotals } from "@/lib/split-calculator";

export const guestRouter = createTRPCRouter({
  processReceipt: publicProcedure
    .input(z.object({ receiptId: z.string(), correctionHint: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      // Rate limit: 3 processing attempts per receipt per hour
      const { allowed } = checkRateLimit(
        `guest-process:${input.receiptId}`,
        3,
        60 * 60 * 1000
      );
      if (!allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many processing attempts for this receipt. Please try again later.",
        });
      }

      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
      });
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found" });
      }

      // If re-processing with corrections, clear old items first
      if (input.correctionHint) {
        await ctx.db.receiptItem.deleteMany({
          where: { receiptId: input.receiptId },
        });
      }

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { status: "PROCESSING" },
      });

      try {
        return await processReceiptImage({
          db: ctx.db,
          receiptId: input.receiptId,
          receipt,
          correctionHint: input.correctionHint,
          logPrefix: "guest.receipt",
        });
      } catch (error) {
        logger.error("guest.receipt.failed", {
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

  getReceiptItems: publicProcedure
    .input(z.object({ receiptId: z.string() }))
    .query(async ({ ctx, input }) => {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
        },
      });
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return {
        receipt: {
          id: receipt.id,
          status: receipt.status,
          imagePath: receipt.imagePath,
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

  createSplit: publicProcedure
    .input(z.object({
      receiptId: z.string().optional(),
      receiptData: z.object({
        merchantName: z.string().optional(),
        date: z.string().optional(),
        subtotal: z.number().int(),
        tax: z.number().int(),
        tip: z.number().int(),
        total: z.number().int(),
        currency: z.string().default("USD"),
      }),
      items: z.array(z.object({
        name: z.string(),
        quantity: z.number().int().min(1),
        unitPrice: z.number().int(),
        totalPrice: z.number().int(),
      })).max(100),
      people: z.array(z.object({ name: z.string() })).min(1).max(100),
      assignments: z.array(z.object({
        itemIndex: z.number().int(),
        personIndices: z.array(z.number().int()),
      })).max(1000),
      paidByIndex: z.number().int().default(0),
      tipOverride: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const tip = input.tipOverride ?? input.receiptData.tip;

      const summary = calculateSplitTotals({
        items: input.items,
        assignments: input.assignments,
        tax: input.receiptData.tax,
        tip,
        peopleCount: input.people.length,
      });

      const summaryWithNames = summary.map((s) => ({
        ...s,
        name: input.people[s.personIndex]?.name ?? `Person ${s.personIndex + 1}`,
      }));

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const guestSplit = await ctx.db.guestSplit.create({
        data: {
          receiptId: input.receiptId,
          receiptData: { ...input.receiptData, tip } as unknown as Prisma.InputJsonValue,
          items: input.items as unknown as Prisma.InputJsonValue,
          people: input.people as unknown as Prisma.InputJsonValue,
          assignments: input.assignments as unknown as Prisma.InputJsonValue,
          summary: summaryWithNames as unknown as Prisma.InputJsonValue,
          paidByIndex: input.paidByIndex,
          expiresAt,
        },
      });

      // Opportunistic cleanup: delete expired GuestSplit records to prevent unbounded growth.
      // Piggybacked on createSplit to avoid needing a separate cron job.
      ctx.db.guestSplit
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .then((result) => {
          if (result.count > 0) {
            logger.info("guest.split.cleanup", { deletedCount: result.count });
          }
        })
        .catch((err) => {
          logger.warn("guest.split.cleanup.failed", {
            error: err instanceof Error ? err.message : "Unknown",
          });
        });

      logger.info("guest.split.created", {
        splitId: guestSplit.id,
        shareToken: guestSplit.shareToken,
        peopleCount: input.people.length,
        itemCount: input.items.length,
      });

      return { shareToken: guestSplit.shareToken };
    }),

  getSplit: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
      });
      if (!split) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Split not found" });
      }
      if (split.expiresAt < new Date()) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This split has expired" });
      }

      return {
        id: split.id,
        shareToken: split.shareToken,
        receiptData: split.receiptData as {
          merchantName?: string;
          date?: string;
          subtotal: number;
          tax: number;
          tip: number;
          total: number;
          currency: string;
        },
        items: split.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[],
        people: split.people as { name: string }[],
        assignments: split.assignments as { itemIndex: number; personIndices: number[] }[],
        summary: split.summary as { personIndex: number; name: string; itemTotal: number; tax: number; tip: number; total: number }[],
        paidByIndex: split.paidByIndex,
        createdAt: split.createdAt,
        expiresAt: split.expiresAt,
      };
    }),
});
