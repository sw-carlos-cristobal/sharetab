import { randomUUID } from "crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@/generated/prisma/client";
import { createTRPCRouter, publicProcedure, protectedProcedure } from "../init";
import { processReceiptImage } from "../../lib/receipt-processor";
import { logger } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limit";
import { calculateSplitTotals } from "@/lib/split-calculator";
import { normalizeGuestName } from "@/lib/guest-session";
import {
  getConfiguredProviderPriority,
} from "@/server/ai/registry";

async function getCreatorPayerVenmoHandle(
  db: typeof import("@/server/db").db,
  userId: string | undefined | null,
  payerName: string | undefined
): Promise<string | null> {
  if (!userId || !payerName) return null;
  const creator = await db.user.findUnique({
    where: { id: userId },
    select: { venmoUsername: true, name: true },
  });
  if (creator?.venmoUsername && creator.name && normalizeGuestName(creator.name) === normalizeGuestName(payerName)) {
    return creator.venmoUsername;
  }
  return null;
}

type GuestSessionPerson = {
  name: string;
  personToken?: string;
  groupSize?: number; // defaults to 1, > 1 means this person represents a group
};

const GUEST_TRANSACTION_RETRY_ATTEMPTS = 3;

function toPublicPeople(people: GuestSessionPerson[]) {
  return people.map(({ name, groupSize }) => ({ name, groupSize: groupSize ?? 1 }));
}

function cloneAssignments(
  assignments: { itemIndex: number; personIndices: number[] }[]
) {
  return assignments.map((assignment) => ({
    ...assignment,
    personIndices: [...assignment.personIndices],
  }));
}

function isTransactionConflict(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2034"
  );
}

async function withSerializableRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= GUEST_TRANSACTION_RETRY_ATTEMPTS - 1 || !isTransactionConflict(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 10) + 1)
      );
      attempt += 1;
    }
  }
}

// ─── Shared Zod schemas (Finding #27) ────────────────────────────
const receiptDataSchema = z.object({
  merchantName: z.string().optional(),
  date: z.string().optional(),
  subtotal: z.number().int(),
  tax: z.number().int(),
  tip: z.number().int(),
  total: z.number().int(),
  currency: z.string().default("USD"),
});

const itemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().int(),
  totalPrice: z.number().int(),
});

// ─── Shared helpers (Finding #28) ─────────────────────────────────
/** Create a Date 7 days from now for guest split expiration. */
function createExpiryDate(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  return expiresAt;
}

/** Fire-and-forget cleanup of expired GuestSplit records. */
function cleanupExpiredSplits(
  db: typeof import("@/server/db").db,
  logPrefix: string
): void {
  db.guestSplit
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .then((result) => {
      if (result.count > 0) {
        logger.info(`${logPrefix}.cleanup`, { deletedCount: result.count });
      }
    })
    .catch((err) => {
      logger.warn(`${logPrefix}.cleanup.failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export const guestRouter = createTRPCRouter({
  expireSession: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: { id: true, userId: true },
      });
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      if (session.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      await ctx.db.guestSplit.update({
        where: { id: session.id },
        data: { expiresAt: new Date(0) },
      });
      return { success: true };
    }),

  deleteSplit: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const split = await ctx.db.guestSplit.findUnique({
        where: { id: input.id },
        select: { userId: true },
      });
      if (!split || split.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Split not found" });
      }
      await ctx.db.guestSplit.delete({ where: { id: input.id } });
      return { success: true };
    }),

  mySplits: protectedProcedure
    .input(z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const splits = await ctx.db.guestSplit.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      let nextCursor: string | undefined;
      if (splits.length > input.limit) {
        nextCursor = splits.pop()!.id;
      }

      type ReceiptJson = Record<string, unknown>;
      type PersonJson = Record<string, unknown>;

      return {
        splits: splits.map(s => {
          const receipt = s.receiptData as ReceiptJson | null;
          const people = s.people as PersonJson[] | null;
          const items = s.items as PersonJson[] | null;
          return {
            id: s.id,
            shareToken: s.shareToken,
            status: s.status,
            merchantName: receipt?.merchantName as string | undefined,
            total: receipt?.total as number | undefined,
            currency: (receipt?.currency as string | undefined) ?? "USD",
            peopleCount: people?.length ?? 0,
            itemCount: items?.length ?? 0,
            createdAt: s.createdAt,
          };
        }),
        nextCursor,
      };
    }),

  getScanProviderInfo: protectedProcedure.query(async () => {
    try {
      return {
        configuredProviders: getConfiguredProviderPriority(),
        activeProvider: null,
      };
    } catch {
      // Keep response shape stable even if provider parsing fails.
      return {
        configuredProviders: [],
        activeProvider: null,
      };
    }
  }),

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
      if (!receipt.isGuest) {
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
      // Rate limit: 10 lookups per receipt per hour to mitigate enumeration.
      // Guest receipt IDs are CUIDs (25 chars of randomness) making brute force
      // infeasible, but rate limiting adds defense-in-depth.
      const { allowed } = checkRateLimit(
        `guest-items:${input.receiptId}`,
        10,
        60 * 60 * 1000
      );
      if (!allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many requests. Please try again later.",
        });
      }

      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: {
          items: { orderBy: { sortOrder: "asc" } },
        },
      });
      if (!receipt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found" });
      }
      if (!receipt.isGuest) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Receipt not found" });
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
      receiptData: receiptDataSchema,
      items: z.array(itemSchema).min(1).max(100),
      people: z.array(z.object({ name: z.string() })).min(1).max(100),
      assignments: z.array(z.object({
        itemIndex: z.number().int(),
        personIndices: z.array(z.number().int()),
      })).max(1000),
      paidByIndex: z.number().int().default(0),
      tipOverride: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const ip = ctx.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "global";
      const { allowed } = checkRateLimit(`guest-create-split:${ip}`, 10, 60 * 60 * 1000);
      if (!allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many splits created. Please try again later." });
      }

      // Validate raw index bounds BEFORE filtering blank names
      for (const a of input.assignments) {
        if (a.itemIndex < 0 || a.itemIndex >= input.items.length) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid itemIndex: ${a.itemIndex}` });
        }
        for (const pi of a.personIndices) {
          if (pi < 0 || pi >= input.people.length) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid personIndex: ${pi}` });
          }
        }
      }
      if (input.paidByIndex < 0 || input.paidByIndex >= input.people.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid paidByIndex: ${input.paidByIndex}` });
      }

      // Filter out blank-name people and remap indices
      const indexMap = new Map<number, number>();
      const filteredPeople = input.people.filter((p, i) => {
        if (!p.name.trim()) return false;
        indexMap.set(i, indexMap.size);
        return true;
      });
      if (filteredPeople.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "At least one person with a name is required" });
      }
      const remappedAssignments = input.assignments
        .map((a) => ({
          itemIndex: a.itemIndex,
          personIndices: a.personIndices
            .filter((pi) => indexMap.has(pi))
            .map((pi) => indexMap.get(pi)!),
        }))
        .filter((a) => a.personIndices.length > 0);
      const remappedPaidBy = indexMap.get(input.paidByIndex) ?? 0;

      // Note: second bounds-validation loop removed (Finding #13) — the remap above
      // only produces valid indices via indexMap filtering, making post-remap validation redundant.

      const tip = input.tipOverride ?? input.receiptData.tip;

      const summary = calculateSplitTotals({
        items: input.items,
        assignments: remappedAssignments,
        tax: input.receiptData.tax,
        tip,
        peopleCount: filteredPeople.length,
      });

      const summaryWithNames = summary.map((s) => ({
        ...s,
        name: filteredPeople[s.personIndex]?.name ?? `Person ${s.personIndex + 1}`,
      }));

      const payerVenmoHandle = await getCreatorPayerVenmoHandle(
        ctx.db, ctx.session?.user?.id, filteredPeople[remappedPaidBy]?.name
      );

      const guestSplit = await ctx.db.guestSplit.create({
        data: {
          receiptId: input.receiptId,
          receiptData: {
            ...input.receiptData,
            tip,
            ...(input.tipOverride != null ? { total: input.receiptData.subtotal + input.receiptData.tax + tip } : {}),
          } as unknown as Prisma.InputJsonValue,
          items: input.items as unknown as Prisma.InputJsonValue,
          people: filteredPeople as unknown as Prisma.InputJsonValue,
          assignments: remappedAssignments as unknown as Prisma.InputJsonValue,
          summary: summaryWithNames as unknown as Prisma.InputJsonValue,
          paidByIndex: remappedPaidBy,
          payerVenmoHandle,
          userId: ctx.session?.user?.id ?? null,
          expiresAt: createExpiryDate(),
        },
      });

      cleanupExpiredSplits(ctx.db, "guest.split");

      logger.info("guest.split.created", {
        splitId: guestSplit.id,
        shareToken: guestSplit.shareToken.substring(0, 8) + "...",
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
      if (split.status !== "finalized") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This split is not yet finalized. Please wait for the split creator to finalize it.",
        });
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
        people: toPublicPeople(split.people as GuestSessionPerson[]),
        assignments: split.assignments as { itemIndex: number; personIndices: number[] }[],
        summary: split.summary as { personIndex: number; name: string; itemTotal: number; tax: number; tip: number; total: number }[],
        paidByIndex: split.paidByIndex,
        payerVenmoHandle: split.payerVenmoHandle,
        isCreator: !!split.userId && split.userId === ctx.session?.user?.id,
        isPayer: (() => {
          if (!ctx.session?.user?.name) return false;
          const people = split.people as GuestSessionPerson[];
          const payerName = people[split.paidByIndex]?.name;
          return !!payerName && normalizeGuestName(ctx.session.user.name) === normalizeGuestName(payerName);
        })(),
        createdAt: split.createdAt,
        expiresAt: split.expiresAt,
      };
    }),

  // ─── CLAIMING SESSION ENDPOINTS ────────────────────────────

  createClaimSession: publicProcedure
    .input(z.object({
      receiptId: z.string().optional(),
      receiptData: receiptDataSchema,
      items: z.array(itemSchema).min(1).max(100),
      creatorName: z.string().trim().min(1).max(100),
      paidByName: z.string().trim().min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const ip = ctx.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "global";
      const { allowed } = checkRateLimit(`guest-create-claim:${ip}`, 10, 60 * 60 * 1000);
      if (!allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many sessions created. Please try again later." });
      }

      const creatorName = input.creatorName.trim();
      const paidByName = input.paidByName.trim();

      // Tokens are assigned lazily when participants, including creator/paidBy, first join this session.
      const people: GuestSessionPerson[] = [{ name: creatorName }];
      let paidByIndex = 0;
      if (normalizeGuestName(paidByName) !== normalizeGuestName(creatorName)) {
        people.push({ name: paidByName });
        paidByIndex = 1;
      }

      // Auto-split multi-quantity items into individual rows for easier claiming
      const MAX_EXPANDED_ITEMS = 200;
      const totalExpanded = input.items.reduce((sum, item) => sum + Math.max(item.quantity, 1), 0);
      if (totalExpanded > MAX_EXPANDED_ITEMS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Too many items after expansion (${totalExpanded} > ${MAX_EXPANDED_ITEMS})` });
      }

      const expandedItems: typeof input.items = [];
      for (const item of input.items) {
        if (item.quantity <= 1) {
          expandedItems.push(item);
        } else {
          // Distribute price evenly with round-robin remainder (e.g. $10/3 → $4,$3,$3 not $3,$3,$4)
          const base = Math.floor(item.totalPrice / item.quantity);
          const remainder = item.totalPrice - base * item.quantity;
          for (let i = 0; i < item.quantity; i++) {
            const price = base + (i < remainder ? 1 : 0);
            expandedItems.push({
              name: item.name,
              quantity: 1,
              unitPrice: price,
              totalPrice: price,
            });
          }
        }
      }

      const claimPayerVenmoHandle = await getCreatorPayerVenmoHandle(
        ctx.db, ctx.session?.user?.id, people[paidByIndex]?.name
      );

      const session = await ctx.db.guestSplit.create({
        data: {
          receiptId: input.receiptId,
          receiptData: input.receiptData as unknown as Prisma.InputJsonValue,
          items: expandedItems as unknown as Prisma.InputJsonValue,
          people: people as unknown as Prisma.InputJsonValue,
          assignments: [] as unknown as Prisma.InputJsonValue,
          paidByIndex,
          payerVenmoHandle: claimPayerVenmoHandle,
          status: "claiming",
          userId: ctx.session?.user?.id ?? null,
          expiresAt: createExpiryDate(),
        },
      });

      cleanupExpiredSplits(ctx.db, "guest.session");

      logger.info("guest.session.created", {
        sessionId: session.id,
        shareToken: session.shareToken.substring(0, 8) + "...",
        itemCount: expandedItems.length,
      });

      return { shareToken: session.shareToken };
    }),

  joinSession: publicProcedure
    .input(z.object({
      token: z.string(),
      name: z.string().trim().min(1).max(100),
      groupSize: z.number().int().min(1).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return withSerializableRetry(() =>
        ctx.db.$transaction(async (tx) => {
          const session = await tx.guestSplit.findUnique({
            where: { shareToken: input.token },
          });
          if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });
          if (session.status !== "claiming") throw new TRPCError({ code: "BAD_REQUEST", message: "Session is no longer accepting claims" });

          const people = [...(session.people as GuestSessionPerson[])];
          const normalizedName = normalizeGuestName(input.name);

          // Check if name already exists (case-insensitive)
          const existingIndex = people.findIndex(
            (p) => normalizeGuestName(p.name) === normalizedName
          );
          if (existingIndex >= 0) {
            const existingPerson = people[existingIndex]!;
            if (!existingPerson.personToken) {
              const personToken = randomUUID();
              people[existingIndex] = { ...existingPerson, personToken, ...(input.groupSize != null ? { groupSize: input.groupSize } : {}) };
              await tx.guestSplit.update({
                where: { id: session.id },
                data: { people: people as unknown as Prisma.InputJsonValue },
              });
              return { personIndex: existingIndex, personToken };
            }
            // Update groupSize on rejoin only if explicitly provided and different
            if (input.groupSize != null && input.groupSize !== (existingPerson.groupSize ?? 1)) {
              people[existingIndex] = { ...existingPerson, groupSize: input.groupSize };
              await tx.guestSplit.update({
                where: { id: session.id },
                data: { people: people as unknown as Prisma.InputJsonValue },
              });
            }
            return { personIndex: existingIndex, personToken: existingPerson.personToken };
          }

          if (people.length >= 100) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Maximum 100 people per session" });
          }

          const personToken = randomUUID();
          people.push({ name: input.name.trim(), personToken, ...(input.groupSize != null ? { groupSize: input.groupSize } : {}) });
          await tx.guestSplit.update({
            where: { id: session.id },
            data: { people: people as unknown as Prisma.InputJsonValue },
          });

          return { personIndex: people.length - 1, personToken };
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        })
      );
    }),

  editPersonName: publicProcedure
    .input(z.object({
      token: z.string(),
      personToken: z.string().uuid(),
      targetIndex: z.number().int().min(0),
      newName: z.string().trim().min(1).max(100),
      groupSize: z.number().int().min(1).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { allowed } = checkRateLimit(`guest-edit-name:${input.token}`, 10, 60 * 1000);
      if (!allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests. Please try again shortly." });
      }
      return withSerializableRetry(() =>
        ctx.db.$transaction(async (tx) => {
          const session = await tx.guestSplit.findUnique({
            where: { shareToken: input.token },
          });
          if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });
          if (session.status !== "claiming") throw new TRPCError({ code: "BAD_REQUEST", message: "Session is finalized" });

          const people = [...(session.people as GuestSessionPerson[])];
          const isParticipant = people.some(p => p.personToken === input.personToken);
          if (!isParticipant) throw new TRPCError({ code: "FORBIDDEN", message: "Not a participant" });
          if (input.targetIndex >= people.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid person index" });

          const normalizedNew = normalizeGuestName(input.newName);
          const conflict = people.findIndex((p, i) => i !== input.targetIndex && normalizeGuestName(p.name) === normalizedNew);
          if (conflict >= 0) throw new TRPCError({ code: "CONFLICT", message: "Name already taken" });

          people[input.targetIndex] = {
            ...people[input.targetIndex]!,
            name: input.newName.trim(),
            ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
          };
          await tx.guestSplit.update({
            where: { id: session.id },
            data: { people: people as unknown as Prisma.InputJsonValue },
          });
          return { success: true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      );
    }),

  removePerson: publicProcedure
    .input(z.object({
      token: z.string(),
      personToken: z.string().uuid(),
      targetIndex: z.number().int().min(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const { allowed } = checkRateLimit(`guest-remove-person:${input.token}`, 10, 60 * 1000);
      if (!allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests. Please try again shortly." });
      }
      return withSerializableRetry(() =>
        ctx.db.$transaction(async (tx) => {
          const session = await tx.guestSplit.findUnique({
            where: { shareToken: input.token },
          });
          if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });
          if (session.status !== "claiming") throw new TRPCError({ code: "BAD_REQUEST", message: "Session is finalized" });

          const people = [...(session.people as GuestSessionPerson[])];
          const isParticipant = people.some(p => p.personToken === input.personToken);
          if (!isParticipant) throw new TRPCError({ code: "FORBIDDEN", message: "Not a participant" });
          if (input.targetIndex >= people.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid person index" });
          if (people.length <= 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove the last person" });

          people.splice(input.targetIndex, 1);

          // Remap assignments: remove the person and shift indices down
          const assignments = (session.assignments as { itemIndex: number; personIndices: number[] }[])
            .map(a => ({
              itemIndex: a.itemIndex,
              personIndices: a.personIndices
                .filter(pi => pi !== input.targetIndex)
                .map(pi => pi > input.targetIndex ? pi - 1 : pi),
            }))
            .filter(a => a.personIndices.length > 0);

          // Adjust paidByIndex
          let paidByIndex = session.paidByIndex;
          if (input.targetIndex === paidByIndex) {
            paidByIndex = 0;
          } else if (input.targetIndex < paidByIndex) {
            paidByIndex--;
          }

          await tx.guestSplit.update({
            where: { id: session.id },
            data: {
              people: people as unknown as Prisma.InputJsonValue,
              assignments: assignments as unknown as Prisma.InputJsonValue,
              paidByIndex,
            },
          });
          return { success: true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      );
    }),

  // Note (Finding #12): createClaimSession auto-splits multi-quantity items to qty=1,
  // so this endpoint is unreachable for sessions created by current code. However, it
  // remains useful for sessions where items were manually edited to have qty>1 after
  // creation, or if the auto-split logic changes in the future.
  splitClaimItem: publicProcedure
    .input(z.object({
      token: z.string(),
      personToken: z.string().uuid(),
      itemIndex: z.number().int().min(0),
      splitQuantity: z.number().int().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { allowed } = checkRateLimit(`guest-split-item:${input.token}`, 10, 60 * 1000);
      if (!allowed) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests. Please try again shortly." });
      }
      return withSerializableRetry(() =>
        ctx.db.$transaction(async (tx) => {
          const session = await tx.guestSplit.findUnique({
            where: { shareToken: input.token },
          });
          if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });
          if (session.status !== "claiming") throw new TRPCError({ code: "BAD_REQUEST", message: "Session is finalized" });

          const people = session.people as GuestSessionPerson[];
          const isParticipant = people.some(p => p.personToken === input.personToken);
          if (!isParticipant) throw new TRPCError({ code: "FORBIDDEN", message: "Not a participant" });

          const items = [...(session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[])];
          if (input.itemIndex >= items.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid item index" });

          const item = items[input.itemIndex]!;
          if (input.splitQuantity >= item.quantity) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Split quantity must be less than item quantity" });
          }

          const maxNewTotal = item.totalPrice - 1;
          if (maxNewTotal <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Item price too low to split" });

          const newTotalPrice = Math.min(item.unitPrice * input.splitQuantity, maxNewTotal);
          const remainingQty = item.quantity - input.splitQuantity;
          const remainingTotalPrice = item.totalPrice - newTotalPrice;

          items[input.itemIndex] = { ...item, quantity: remainingQty, totalPrice: remainingTotalPrice };
          items.splice(input.itemIndex + 1, 0, {
            name: item.name,
            quantity: input.splitQuantity,
            unitPrice: item.unitPrice,
            totalPrice: newTotalPrice,
          });

          // Remap assignments: shift indices after insertion point
          const assignments = (session.assignments as { itemIndex: number; personIndices: number[] }[])
            .map(a => ({
              itemIndex: a.itemIndex > input.itemIndex ? a.itemIndex + 1 : a.itemIndex,
              personIndices: [...a.personIndices],
            }));

          await tx.guestSplit.update({
            where: { id: session.id },
            data: {
              items: items as unknown as Prisma.InputJsonValue,
              assignments: assignments as unknown as Prisma.InputJsonValue,
            },
          });
          return { success: true, itemCount: items.length };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      );
    }),

  claimItems: publicProcedure
    .input(z.object({
      token: z.string(),
      personIndex: z.number().int().min(0),
      personToken: z.string().uuid(),
      claimedItemIndices: z.array(z.number().int().min(0)).max(1000),
    }))
    .mutation(async ({ ctx, input }) => {
      // Rate limit: 10 claims per token per minute
      const { allowed: claimAllowed } = checkRateLimit(
        `guest-claim:${input.token}`,
        10,
        60 * 1000
      );
      if (!claimAllowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many claim attempts. Please try again shortly.",
        });
      }

      return withSerializableRetry(() =>
        ctx.db.$transaction(async (tx) => {
          const session = await tx.guestSplit.findUnique({
            where: { shareToken: input.token },
          });
          if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });
          if (session.status !== "claiming") throw new TRPCError({ code: "BAD_REQUEST", message: "Session is no longer accepting claims" });

          const people = session.people as GuestSessionPerson[];
          const items = session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[];

          // Validate personToken belongs to ANY participant (allows claiming for others)
          const isParticipant = people.some(p => p.personToken === input.personToken);
          if (!isParticipant) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Invalid person token" });
          }
          if (input.personIndex >= people.length) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid person index" });
          }

          // Deduplicate claimed indices
          const claimedSet = new Set(input.claimedItemIndices);

          for (const idx of claimedSet) {
            if (idx >= items.length) {
              throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid item index: ${idx}` });
            }
          }

          const assignments = cloneAssignments(
            session.assignments as { itemIndex: number; personIndices: number[] }[]
          );

          // Remove this person from all current assignments
          for (const a of assignments) {
            a.personIndices = a.personIndices.filter((pi) => pi !== input.personIndex);
          }

          // Add this person to claimed items
          for (const itemIdx of claimedSet) {
            let assignment = assignments.find((a) => a.itemIndex === itemIdx);
            if (!assignment) {
              assignment = { itemIndex: itemIdx, personIndices: [] };
              assignments.push(assignment);
            }
            if (!assignment.personIndices.includes(input.personIndex)) {
              assignment.personIndices.push(input.personIndex);
            }
          }

          // Clean up empty assignments
          const cleanedAssignments = assignments.filter((a) => a.personIndices.length > 0);

          await tx.guestSplit.update({
            where: { id: session.id },
            data: { assignments: cleanedAssignments as unknown as Prisma.InputJsonValue },
          });

          // Check for conflicts: items in this person's claim set that are also claimed by others
          const assignmentMap = new Map(cleanedAssignments.map(a => [a.itemIndex, a]));
          const conflicts: { itemIndex: number; claimedBy: string[] }[] = [];
          for (const claimedIdx of claimedSet) {
            const assignment = assignmentMap.get(claimedIdx);
            if (assignment && assignment.personIndices.length > 1) {
              const otherNames = assignment.personIndices
                .filter(pi => pi !== input.personIndex)
                .map(pi => people[pi]?.name ?? "Someone");
              if (otherNames.length > 0) {
                conflicts.push({ itemIndex: claimedIdx, claimedBy: otherNames });
              }
            }
          }

          return { success: true, conflicts };
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        })
      );
    }),

  getSession: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      // Rate limit: 120 reads per token per minute (polled every 3s = ~20/min)
      const { allowed: readAllowed } = checkRateLimit(
        `guest-session-read:${input.token}`,
        120,
        60 * 1000
      );
      if (!readAllowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many requests. Please try again shortly.",
        });
      }

      const session = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
      });
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });

      let receiptImagePath: string | null = null;
      if (session.receiptId) {
        const receipt = await ctx.db.receipt.findUnique({
          where: { id: session.receiptId },
          select: { imagePath: true },
        });
        receiptImagePath = receipt?.imagePath ?? null;
      }

      return {
        id: session.id,
        shareToken: session.shareToken,
        status: session.status,
        receiptData: session.receiptData as {
          merchantName?: string;
          date?: string;
          subtotal: number;
          tax: number;
          tip: number;
          total: number;
          currency: string;
        },
        items: session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[],
        people: toPublicPeople(session.people as GuestSessionPerson[]),
        assignments: session.assignments as { itemIndex: number; personIndices: number[] }[],
        summary: session.summary as { personIndex: number; name: string; itemTotal: number; tax: number; tip: number; total: number }[] | null,
        paidByIndex: session.paidByIndex,
        payerVenmoHandle: session.payerVenmoHandle,
        isCreator: !!session.userId && session.userId === ctx.session?.user?.id,
        receiptImagePath,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      };
    }),

  finalizeSession: publicProcedure
    .input(z.object({
      token: z.string(),
      personIndex: z.number().int().min(0),
      personToken: z.string().uuid(),
      tipOverride: z.number().int().min(0).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return withSerializableRetry(() =>
        ctx.db.$transaction(async (tx) => {
          const session = await tx.guestSplit.findUnique({
            where: { shareToken: input.token },
          });
          if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
          if (session.expiresAt < new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "Session expired" });
          if (session.status !== "claiming") throw new TRPCError({ code: "BAD_REQUEST", message: "Session already finalized" });

          const items = session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
          const people = session.people as GuestSessionPerson[];
          const assignments = session.assignments as { itemIndex: number; personIndices: number[] }[];
          const receiptData = session.receiptData as {
            merchantName?: string;
            date?: string;
            subtotal: number;
            tax: number;
            tip: number;
            total: number;
            currency: string;
          };

          if (input.personIndex >= people.length) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid person index" });
          }

          const person = people[input.personIndex];
          if (!person?.personToken || person.personToken !== input.personToken) {
            throw new TRPCError({ code: "FORBIDDEN", message: "Invalid person token" });
          }

          const tip = input.tipOverride ?? receiptData.tip;

          // Build personWeights from each person's groupSize for proportional splitting
          const personWeights = people.map((p) => p.groupSize ?? 1);
          const hasWeights = personWeights.some((w) => w > 1);

          const summary = calculateSplitTotals({
            items,
            assignments,
            tax: receiptData.tax,
            tip,
            peopleCount: people.length,
            ...(hasWeights ? { personWeights } : {}),
          });

          const summaryWithNames = summary.map((s) => ({
            ...s,
            name: people[s.personIndex]?.name ?? `Person ${s.personIndex + 1}`,
          }));

          await tx.guestSplit.update({
            where: { id: session.id },
            data: {
              status: "finalized",
              summary: summaryWithNames as unknown as Prisma.InputJsonValue,
              assignments: assignments as unknown as Prisma.InputJsonValue,
              ...(input.tipOverride !== undefined && {
                receiptData: {
                  ...receiptData,
                  tip,
                  total: receiptData.subtotal + receiptData.tax + tip,
                } as unknown as Prisma.InputJsonValue,
              }),
            },
          });

          logger.info("guest.session.finalized", {
            sessionId: session.id,
            peopleCount: people.length,
            itemCount: items.length,
          });

          return { shareToken: session.shareToken };
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        })
      );
    }),

  setPayerVenmoHandle: protectedProcedure
    .input(z.object({
      token: z.string(),
      handle: z.string().max(50).nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { allowed } = checkRateLimit(
        `venmo-handle:${ctx.user.id}:${input.token}`,
        10,
        60 * 1000
      );
      if (!allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many requests. Please try again shortly.",
        });
      }

      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: { id: true, userId: true, expiresAt: true },
      });
      if (!split) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Split not found" });
      }
      if (split.expiresAt < new Date()) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This split has expired" });
      }
      if (split.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the split creator can update the Venmo handle" });
      }

      await ctx.db.guestSplit.update({
        where: { id: split.id },
        data: { payerVenmoHandle: input.handle?.trim() || null },
      });

      return { success: true };
    }),
});
