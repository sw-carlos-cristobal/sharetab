import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, publicProcedure, protectedProcedure } from "../init";
import {
  getAIProvidersWithFallback,
  getConfiguredProviderPriority,
  isProviderConfigured,
  createProviderByName,
} from "@/server/ai/registry";
import {
  type AdminAction,
  type PrismaClient,
  Prisma,
} from "@/generated/prisma/client";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { getRecentLogs } from "@/server/lib/logger";
import {
  checkMeridianHealth,
  invalidateMeridianHealthCache,
  sendAuthExpiryEmail,
} from "@/server/lib/auth-health-poller";
import {
  startLogin,
  submitCode,
  cancelLogin,
  logout as logoutMeridian,
  isLoginInProgress,
} from "@/server/lib/meridian-login";
import { clearProviderCache } from "@/server/ai/registry";
import {
  checkOpenAICodexHealth,
  invalidateOpenAICodexHealthCache,
  startLogin as startOpenAICodexLogin,
  submitCode as submitOpenAICodexCode,
  cancelLogin as cancelOpenAICodexLogin,
  logout as logoutOpenAICodex,
  isLoginInProgress as isOpenAICodexLoginInProgress,
} from "@/server/lib/openai-codex-login";

const serverStartTime = new Date();

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const adminEmail = process.env.ADMIN_EMAIL;
  // When impersonating, use the real admin email for the check
  const effectiveEmail = ctx.impersonating
    ? ctx.impersonating.adminEmail
    : ctx.user.email;
  if (!adminEmail || effectiveEmail !== adminEmail) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }
  // For admin procedures, restore the real admin user context
  if (ctx.impersonating) {
    return next({
      ctx: {
        ...ctx,
        user: {
          ...ctx.user,
          id: ctx.impersonating.adminId,
          email: ctx.impersonating.adminEmail,
        },
      },
    });
  }
  return next({ ctx });
});

export { adminProcedure };

/** Reusable helper to log an admin action to the audit log. */
export async function logAdminAction(
  db: PrismaClient,
  adminId: string,
  action: AdminAction,
  targetId?: string | null,
  metadata?: Record<string, unknown> | null
) {
  await db.adminAuditLog.create({
    data: {
      adminId,
      action,
      targetId: targetId ?? undefined,
      metadata:
        metadata !== null && metadata !== undefined
          ? (metadata as Prisma.InputJsonValue)
          : undefined,
    },
  });
}

export const adminRouter = createTRPCRouter({
  getImpersonationStatus: publicProcedure.query(({ ctx }) => {
    return {
      isImpersonating: !!ctx.impersonating,
      targetName: ctx.impersonating?.targetName ?? null,
      targetEmail: ctx.impersonating?.targetEmail ?? null,
    };
  }),

  getAuditLog: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        action: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.adminAuditLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        ...(input.action
          ? { where: { action: input.action as AdminAction } }
          : {}),
        orderBy: { createdAt: "desc" },
        include: {
          admin: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return {
        items: items.map((item) => ({
          id: item.id,
          action: item.action,
          targetId: item.targetId,
          metadata: item.metadata as Record<string, unknown> | null,
          adminName: item.admin.name ?? item.admin.email,
          adminEmail: item.admin.email,
          createdAt: item.createdAt,
        })),
        nextCursor,
      };
    }),

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
    let ocrFallback = false;
    let aiStatus: "available" | "requires_auth" | "unavailable" = "unavailable";
    const authProvidersNeedingLogin: string[] = [];
    try {
      const configured = getConfiguredProviderPriority();
      const [active] = await getAIProvidersWithFallback();
      aiProvider = configured.join(" -> ");
      aiAvailable = true;
      ocrFallback = active.name === "ocr" && configured[0] !== "ocr";

      // Mark OAuth-backed providers that are configured but not currently usable.
      if (configured.includes("meridian")) {
        const meridianHealth = await checkMeridianHealth();
        if (meridianHealth.status !== "healthy") {
          authProvidersNeedingLogin.push("meridian");
        }
      }

      if (configured.includes("openai-codex")) {
        const openAICodexHealth = await checkOpenAICodexHealth();
        if (
          openAICodexHealth.status === "auth_expired" ||
          openAICodexHealth.status === "not_authenticated"
        ) {
          authProvidersNeedingLogin.push("openai-codex");
        }
      }

      aiStatus = authProvidersNeedingLogin.length > 0
        ? "requires_auth"
        : "available";
    } catch {
      aiProvider = process.env.AI_PROVIDER_PRIORITY ?? "not configured";
      aiStatus = "unavailable";
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
      ocrFallback,
      aiStatus,
      authProvidersNeedingLogin,
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
        suspendedAt: true,
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
        isSuspended: u.suspendedAt !== null,
        suspendedAt: u.suspendedAt,
        groupCount: u._count.groupMembers,
        createdAt: u.createdAt,
      })),
      totalCount,
    };
  }),

  suspendUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot suspend your own account",
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, suspendedAt: true },
      });

      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      if (user.suspendedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "User is already suspended",
        });
      }

      await ctx.db.user.update({
        where: { id: input.userId },
        data: { suspendedAt: new Date() },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "USER_SUSPENDED",
        input.userId,
        { email: user.email }
      );

      return { suspended: true, userId: input.userId };
    }),

  unsuspendUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, suspendedAt: true },
      });

      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      if (!user.suspendedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "User is not suspended",
        });
      }

      await ctx.db.user.update({
        where: { id: input.userId },
        data: { suspendedAt: null },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "USER_UNSUSPENDED",
        input.userId,
        { email: user.email }
      );

      return { unsuspended: true, userId: input.userId };
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

      await logAdminAction(ctx.db, ctx.user.id, "USER_DELETED", input.userId, {
        email: user.email,
      });

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
        select: { id: true, name: true },
      });

      if (!group) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Group not found",
        });
      }

      await ctx.db.group.delete({ where: { id: input.groupId } });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "GROUP_DELETED",
        input.groupId,
        { name: group.name }
      );

      return { deleted: true, groupId: input.groupId };
    }),

  // ─── AI Usage Statistics ─────────────────────────────────

  getAIStats: adminProcedure.query(async ({ ctx }) => {
    const [total, byStatus, byProvider, last7Days, last30Days] =
      await Promise.all([
        ctx.db.receipt.count(),
        ctx.db.receipt.groupBy({
          by: ["status"],
          _count: true,
        }),
        ctx.db.receipt.groupBy({
          by: ["aiProvider"],
          _count: true,
          where: { aiProvider: { not: null } },
        }),
        ctx.db.receipt.count({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        }),
        ctx.db.receipt.count({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
        }),
      ]);

    return {
      total,
      byStatus: Object.fromEntries(
        byStatus.map((s) => [s.status, s._count])
      ) as Record<string, number>,
      byProvider: Object.fromEntries(
        byProvider.map((p) => [p.aiProvider ?? "unknown", p._count])
      ) as Record<string, number>,
      last7Days,
      last30Days,
    };
  }),

  // ─── Registration Control ───────────────────────────────

  getRegistrationMode: adminProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: "registrationMode" },
    });
    return {
      mode: (setting?.value ?? "open") as "open" | "invite-only" | "closed",
    };
  }),

  setRegistrationMode: adminProcedure
    .input(
      z.object({
        mode: z.enum(["open", "invite-only", "closed"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemSetting.upsert({
        where: { key: "registrationMode" },
        update: { value: input.mode },
        create: { key: "registrationMode", value: input.mode },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "REGISTRATION_MODE_CHANGED",
        null,
        { mode: input.mode }
      );

      return { mode: input.mode };
    }),

  createSystemInvite: adminProcedure
    .input(
      z.object({
        label: z.string().max(100).optional(),
        expiresInDays: z.number().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const invite = await ctx.db.systemInvite.create({
        data: {
          label: input.label,
          expiresAt,
        },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "INVITE_CREATED",
        invite.id,
        { code: invite.code, label: input.label }
      );

      return {
        id: invite.id,
        code: invite.code,
        label: invite.label,
        expiresAt: invite.expiresAt,
      };
    }),

  listSystemInvites: adminProcedure.query(async ({ ctx }) => {
    const invites = await ctx.db.systemInvite.findMany({
      include: {
        usedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return invites.map((inv) => ({
      id: inv.id,
      code: inv.code,
      label: inv.label,
      usedBy: inv.usedBy
        ? { name: inv.usedBy.name, email: inv.usedBy.email }
        : null,
      usedAt: inv.usedAt,
      expiresAt: inv.expiresAt,
      revokedAt: inv.revokedAt,
      isActive:
        !inv.revokedAt &&
        !inv.usedAt &&
        (!inv.expiresAt || inv.expiresAt > new Date()),
      createdAt: inv.createdAt,
    }));
  }),

  revokeSystemInvite: adminProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const invite = await ctx.db.systemInvite.findUnique({
        where: { id: input.inviteId },
      });

      if (!invite) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invite not found",
        });
      }

      if (invite.revokedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invite is already revoked",
        });
      }

      await ctx.db.systemInvite.update({
        where: { id: input.inviteId },
        data: { revokedAt: new Date() },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "INVITE_REVOKED",
        input.inviteId,
        { code: invite.code }
      );

      return { revoked: true };
    }),

  // ─── Global Activity Feed ────────────────────────────────

  getGlobalActivity: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.activityLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true } },
          group: { select: { id: true, name: true } },
        },
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return {
        items: items.map((item) => ({
          id: item.id,
          type: item.type,
          entityId: item.entityId,
          metadata: item.metadata as Record<string, unknown> | null,
          userName: item.user.name ?? item.user.email,
          userEmail: item.user.email,
          groupName: item.group.name,
          groupId: item.group.id,
          createdAt: item.createdAt,
        })),
        nextCursor,
      };
    }),

  // ─── Announcement Banner ─────────────────────────────────

  getAnnouncement: publicProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: "announcement" },
    });
    return { message: setting?.value ?? null };
  }),

  setAnnouncement: adminProcedure
    .input(
      z.object({
        message: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.message || input.message.trim() === "") {
        // Clear announcement
        await ctx.db.systemSetting.deleteMany({
          where: { key: "announcement" },
        });
      } else {
        await ctx.db.systemSetting.upsert({
          where: { key: "announcement" },
          update: { value: input.message.trim() },
          create: { key: "announcement", value: input.message.trim() },
        });
      }

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "ANNOUNCEMENT_SET",
        null,
        { message: input.message ?? null }
      );

      return { success: true };
    }),

  // ─── Email Test ──────────────────────────────────────────

  sendTestEmail: adminProcedure.mutation(async ({ ctx }) => {
    const host = process.env.EMAIL_SERVER_HOST;
    if (!host) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Email is not configured. Set EMAIL_SERVER_HOST environment variable.",
      });
    }

    const transport = nodemailer.createTransport({
      host,
      port: parseInt(process.env.EMAIL_SERVER_PORT ?? "587"),
      secure: parseInt(process.env.EMAIL_SERVER_PORT ?? "587") === 465,
      auth: {
        user: process.env.EMAIL_SERVER_USER,
        pass: process.env.EMAIL_SERVER_PASSWORD,
      },
    });

    const from =
      process.env.EMAIL_FROM ?? "ShareTab <noreply@sharetab.local>";
    const to = ctx.user.email!;

    try {
      await transport.sendMail({
        from,
        to,
        subject: "ShareTab Test Email",
        text: `This is a test email from ShareTab admin dashboard.\n\nSent at: ${new Date().toISOString()}\nAdmin: ${ctx.user.email}`,
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #10b981;">ShareTab Test Email</h2>
            <p>This is a test email from the ShareTab admin dashboard.</p>
            <p style="color: #666; font-size: 14px;">
              Sent at: ${new Date().toISOString()}<br/>
              Admin: ${ctx.user.email}
            </p>
          </div>
        `,
      });

      await logAdminAction(ctx.db, ctx.user.id, "TEST_EMAIL_SENT", null, {
        to,
      });

      return { success: true, sentTo: to };
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to send test email: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }),

  // ─── Storage ────────────────────────────────────────────

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

    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, "ORPHANS_CLEANED", null, {
        deletedCount,
        freedBytes,
      });
    }

    return {
      deletedCount,
      freedBytes,
      freedBytesFormatted: formatBytes(freedBytes),
    };
  }),
  // ─── Guest Split Cleanup ──────────────────────────────────

  getExpiredSplitCount: adminProcedure.query(async ({ ctx }) => {
    const expiredCount = await ctx.db.guestSplit.count({
      where: { expiresAt: { lt: new Date() } },
    });
    const totalCount = await ctx.db.guestSplit.count();
    return { expiredCount, totalCount };
  }),

  cleanupExpiredSplits: adminProcedure.mutation(async ({ ctx }) => {
    const result = await ctx.db.guestSplit.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    if (result.count > 0) {
      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "EXPIRED_SPLITS_CLEANED",
        null,
        { deletedCount: result.count }
      );
    }

    return { deletedCount: result.count };
  }),

  // ─── Server Logs ─────────────────────────────────────────

  getLogs: adminProcedure
    .input(
      z.object({
        minLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().min(1).max(500).default(200),
        afterId: z.number().optional(),
      })
    )
    .query(({ input }) => {
      return getRecentLogs({
        minLevel: input.minLevel,
        search: input.search || undefined,
        limit: input.limit,
        afterId: input.afterId,
      });
    }),

  // ─── Meridian Auth ──────────────────────────────────────────

  getMeridianAuthStatus: adminProcedure.query(async () => {
    if (!isProviderConfigured("meridian")) {
      return { status: "not_applicable" as const };
    }
    const health = await checkMeridianHealth();
    return {
      ...health,
      loginInProgress: isLoginInProgress(),
    };
  }),

  startMeridianLogin: adminProcedure.mutation(async ({ ctx }) => {
    if (!isProviderConfigured("meridian")) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Meridian is not configured in AI provider priority",
      });
    }

    try {
      const url = await startLogin();

      // Send email with login URL
      await sendAuthExpiryEmail(
        "Re-authentication initiated from admin dashboard",
        url
      );

      await logAdminAction(ctx.db, ctx.user.id, "MERIDIAN_LOGIN_STARTED", null, {
        url,
      });

      return { url };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "Failed to start login",
      });
    }
  }),

  completeMeridianLogin: adminProcedure
    .input(z.object({ code: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await submitCode(input.code);

        if (result.success) {
          clearProviderCache();
          invalidateMeridianHealthCache();
        }

        await logAdminAction(
          ctx.db,
          ctx.user.id,
          result.success ? "MERIDIAN_LOGIN_COMPLETED" : "MERIDIAN_LOGIN_FAILED",
          null,
          { success: result.success, error: result.error }
        );

        return result;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to submit code",
        });
      }
    }),

  cancelMeridianLogin: adminProcedure.mutation(async ({ ctx }) => {
    cancelLogin();
    await logAdminAction(ctx.db, ctx.user.id, "MERIDIAN_LOGIN_FAILED", null, {
      reason: "cancelled",
    });
    return { cancelled: true };
  }),

  logoutMeridian: adminProcedure.mutation(async ({ ctx }) => {
    if (!isProviderConfigured("meridian")) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Meridian is not configured in AI provider priority",
      });
    }

    const result = logoutMeridian();
    if (!result.success) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.error ?? "Failed to log out Meridian",
      });
    }

    clearProviderCache();
    invalidateMeridianHealthCache();
    await logAdminAction(ctx.db, ctx.user.id, "MERIDIAN_LOGOUT", null, {
      reason: "logged_out",
    });
    return { success: true };
  }),

  getMeridianNotifyPreference: adminProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: "meridianNotifyInterval" },
    });
    return {
      interval: (setting?.value ?? "once") as "once" | "1h" | "6h" | "24h",
    };
  }),

  setMeridianNotifyPreference: adminProcedure
    .input(
      z.object({
        interval: z.enum(["once", "1h", "6h", "24h"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemSetting.upsert({
        where: { key: "meridianNotifyInterval" },
        update: { value: input.interval },
        create: { key: "meridianNotifyInterval", value: input.interval },
      });

      await logAdminAction(
        ctx.db,
        ctx.user.id,
        "MERIDIAN_NOTIFY_PREFERENCE_CHANGED",
        null,
        { interval: input.interval }
      );

      return { interval: input.interval };
    }),

  // ─── OpenAI Codex Auth ─────────────────────────────────────

  getOpenAICodexAuthStatus: adminProcedure.query(async () => {
    if (!isProviderConfigured("openai-codex")) {
      return { status: "not_applicable" as const };
    }
    const health = await checkOpenAICodexHealth();
    return {
      ...health,
      loginInProgress: isOpenAICodexLoginInProgress(),
    };
  }),

  startOpenAICodexLogin: adminProcedure.mutation(async () => {
    if (!isProviderConfigured("openai-codex")) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "OpenAI Codex is not configured in AI provider priority",
      });
    }
    return { url: await startOpenAICodexLogin() };
  }),

  completeOpenAICodexLogin: adminProcedure
    .input(z.object({ code: z.string().min(1).max(1000) }))
    .mutation(async ({ input }) => {
      const result = await submitOpenAICodexCode(input.code);
      if (result.success) {
        clearProviderCache();
        invalidateOpenAICodexHealthCache();
      }
      return result;
    }),

  cancelOpenAICodexLogin: adminProcedure.mutation(async () => {
    cancelOpenAICodexLogin();
    return { cancelled: true };
  }),

  logoutOpenAICodex: adminProcedure.mutation(async () => {
    if (!isProviderConfigured("openai-codex")) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "OpenAI Codex is not configured in AI provider priority",
      });
    }

    const result = logoutOpenAICodex();
    if (!result.success) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.error ?? "Failed to log out OpenAI Codex",
      });
    }

    clearProviderCache();
    invalidateOpenAICodexHealthCache();
    return { success: true };
  }),

  // ─── AI Provider Testing ─────────────────────────────────

  testAIProvider: adminProcedure
    .input(
      z.object({
        providerName: z.string(),
        imageBase64: z.string().max(10 * 1024 * 1024),
        mimeType: z.enum([
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
        ]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const start = Date.now();
      let provider;
      try {
        provider = await createProviderByName(input.providerName);
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            err instanceof Error ? err.message : "Failed to create provider",
        });
      }

      const available = await provider.isAvailable();
      if (!available) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Provider "${input.providerName}" is not available`,
        });
      }

      const imageBuffer = Buffer.from(input.imageBase64, "base64");
      if (imageBuffer.length > 5 * 1024 * 1024) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Image exceeds 5 MB limit",
        });
      }

      try {
        const result = await provider.extractReceipt(
          imageBuffer,
          input.mimeType
        );
        const durationMs = Date.now() - start;

        await logAdminAction(
          ctx.db,
          ctx.user.id,
          "AI_PROVIDER_TESTED",
          null,
          { provider: input.providerName, durationMs, success: true }
        );

        return { result, durationMs };
      } catch (err) {
        const durationMs = Date.now() - start;
        const message =
          err instanceof Error ? err.message : "Extraction failed";

        await logAdminAction(
          ctx.db,
          ctx.user.id,
          "AI_PROVIDER_TESTED",
          null,
          {
            provider: input.providerName,
            durationMs,
            success: false,
            error: message,
          }
        );

        throw new TRPCError({
          code: "BAD_GATEWAY",
          message,
        });
      }
    }),
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
