import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure } from "../init";
import { getAIProvider } from "../../ai/registry";
import { logger } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limit";
import { calculateSplitTotals } from "@/lib/split-calculator";

export const guestRouter = createTRPCRouter({
  processReceipt: publicProcedure
    .input(z.object({ receiptId: z.string() }))
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

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { status: "PROCESSING" },
      });

      try {
        const { readFile } = await import("fs/promises");
        const { join } = await import("path");
        const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
        const filepath = join(uploadDir, receipt.imagePath);
        const imageBuffer = await readFile(filepath);

        const provider = await getAIProvider();
        logger.info("guest.receipt.processing", {
          receiptId: input.receiptId,
          provider: provider.name,
          imageSize: imageBuffer.length,
        });
        const start = Date.now();
        const result = await provider.extractReceipt(imageBuffer, receipt.mimeType);
        logger.info("guest.receipt.extracted", {
          receiptId: input.receiptId,
          provider: provider.name,
          items: result.items.length,
          total: result.total,
          durationMs: Date.now() - start,
        });

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
        logger.error("guest.receipt.failed", {
          receiptId: input.receiptId,
          error: error instanceof Error ? error.message : "Unknown",
        });
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
      })),
      people: z.array(z.object({ name: z.string() })).min(1),
      assignments: z.array(z.object({
        itemIndex: z.number().int(),
        personIndices: z.array(z.number().int()),
      })),
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
          receiptData: JSON.parse(JSON.stringify({ ...input.receiptData, tip })),
          items: JSON.parse(JSON.stringify(input.items)),
          people: JSON.parse(JSON.stringify(input.people)),
          assignments: JSON.parse(JSON.stringify(input.assignments)),
          summary: JSON.parse(JSON.stringify(summaryWithNames)),
          paidByIndex: input.paidByIndex,
          expiresAt,
        },
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
