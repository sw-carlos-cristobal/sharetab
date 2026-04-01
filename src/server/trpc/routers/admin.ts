import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "../init";
import { getAIProvider } from "@/server/ai/registry";
import fs from "fs";
import path from "path";

const serverStartTime = new Date();

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || ctx.user.email !== adminEmail) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }
  return next({ ctx });
});

export { adminProcedure };

export const adminRouter = createTRPCRouter({
  getSystemHealth: adminProcedure.query(async ({ ctx }) => {
    // DB status
    let dbStatus: "connected" | "disconnected" = "disconnected";
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      dbStatus = "connected";
    } catch {
      // disconnected
    }

    // AI provider info
    let aiProvider = "unknown";
    let aiAvailable = false;
    try {
      const provider = await getAIProvider();
      aiProvider = provider.name;
      aiAvailable = await provider.isAvailable();
    } catch {
      aiProvider = process.env.AI_PROVIDER ?? "not configured";
    }

    // App version
    let version = "unknown";
    try {
      const pkgPath = path.resolve(process.cwd(), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      version = pkg.version;
    } catch {
      // ignore
    }

    return {
      dbStatus,
      aiProvider,
      aiAvailable,
      version,
      serverStartTime: serverStartTime.toISOString(),
      uptime: Math.floor((Date.now() - serverStartTime.getTime()) / 1000),
    };
  }),

  listUsers: adminProcedure.query(async ({ ctx }) => {
    const users = await ctx.db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        isPlaceholder: true,
        placeholderName: true,
        createdAt: true,
        _count: {
          select: { groupMembers: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const totalCount = users.length;

    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.isPlaceholder ? u.placeholderName : u.name,
        email: u.email,
        isPlaceholder: u.isPlaceholder,
        groupCount: u._count.groupMembers,
        createdAt: u.createdAt,
      })),
      totalCount,
    };
  }),

  deleteUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete your own account",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true },
      });

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      await ctx.db.user.delete({ where: { id: input.userId } });

      return { deleted: true, userId: input.userId };
    }),

  listGroups: adminProcedure.query(async ({ ctx }) => {
    const groups = await ctx.db.group.findMany({
      select: {
        id: true,
        name: true,
        archivedAt: true,
        createdAt: true,
        _count: {
          select: {
            members: true,
            expenses: true,
            settlements: true,
          },
        },
        expenses: {
          select: { amount: true },
        },
        activityLogs: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    let totalExpenses = 0;
    let totalSettlements = 0;

    const result = groups.map((g) => {
      const totalAmount = g.expenses.reduce((sum, e) => sum + e.amount, 0);
      totalExpenses += g._count.expenses;
      totalSettlements += g._count.settlements;

      return {
        id: g.id,
        name: g.name,
        memberCount: g._count.members,
        expenseCount: g._count.expenses,
        totalAmount,
        lastActivity: g.activityLogs[0]?.createdAt ?? g.createdAt,
        isArchived: g.archivedAt !== null,
        createdAt: g.createdAt,
      };
    });

    return {
      groups: result,
      totalCount: groups.length,
      totalExpenses,
      totalSettlements,
    };
  }),

  deleteGroup: adminProcedure
    .input(z.object({ groupId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.group.findUnique({
        where: { id: input.groupId },
        select: { id: true },
      });

      if (!group) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Group not found",
        });
      }

      await ctx.db.group.delete({ where: { id: input.groupId } });

      return { deleted: true, groupId: input.groupId };
    }),

  getStorageStats: adminProcedure.query(async ({ ctx }) => {
    // Receipt count from DB
    const receiptCount = await ctx.db.receipt.count();

    // Get all receipt image paths from DB
    const receipts = await ctx.db.receipt.findMany({
      select: { imagePath: true },
    });
    const dbPaths = new Set(receipts.map((r) => r.imagePath));

    // Scan uploads directory
    const uploadDir = path.resolve(
      process.cwd(),
      process.env.UPLOAD_DIR ?? "./uploads"
    );

    let totalDiskUsage = 0;
    let orphanCount = 0;
    const orphanPaths: string[] = [];
    let diskFiles = 0;

    if (fs.existsSync(uploadDir)) {
      const scanDir = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else {
            diskFiles++;
            const stat = fs.statSync(fullPath);
            totalDiskUsage += stat.size;

            // Check if this file is referenced in DB
            const relativePath = path.relative(uploadDir, fullPath).replace(/\\/g, "/");
            // Receipt imagePath may be stored as relative or with uploads/ prefix
            const isReferenced =
              dbPaths.has(relativePath) ||
              dbPaths.has(`uploads/${relativePath}`) ||
              dbPaths.has(`/uploads/${relativePath}`) ||
              dbPaths.has(fullPath);

            if (!isReferenced) {
              orphanCount++;
              orphanPaths.push(relativePath);
            }
          }
        }
      };
      scanDir(uploadDir);
    }

    return {
      receiptCount,
      diskFiles,
      totalDiskUsage,
      totalDiskUsageFormatted: formatBytes(totalDiskUsage),
      orphanCount,
      orphanPaths,
    };
  }),

  cleanupOrphans: adminProcedure.mutation(async ({ ctx }) => {
    // Get all receipt image paths from DB
    const receipts = await ctx.db.receipt.findMany({
      select: { imagePath: true },
    });
    const dbPaths = new Set(receipts.map((r) => r.imagePath));

    const uploadDir = path.resolve(
      process.cwd(),
      process.env.UPLOAD_DIR ?? "./uploads"
    );

    let deletedCount = 0;
    let freedBytes = 0;

    if (fs.existsSync(uploadDir)) {
      const scanAndDelete = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanAndDelete(fullPath);
            // Remove empty directories
            try {
              const remaining = fs.readdirSync(fullPath);
              if (remaining.length === 0) {
                fs.rmdirSync(fullPath);
              }
            } catch {
              // ignore
            }
          } else {
            const relativePath = path.relative(uploadDir, fullPath).replace(/\\/g, "/");
            const isReferenced =
              dbPaths.has(relativePath) ||
              dbPaths.has(`uploads/${relativePath}`) ||
              dbPaths.has(`/uploads/${relativePath}`) ||
              dbPaths.has(fullPath);

            if (!isReferenced) {
              const stat = fs.statSync(fullPath);
              freedBytes += stat.size;
              fs.unlinkSync(fullPath);
              deletedCount++;
            }
          }
        }
      };
      scanAndDelete(uploadDir);
    }

    return {
      deletedCount,
      freedBytes,
      freedBytesFormatted: formatBytes(freedBytes),
    };
  }),
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
