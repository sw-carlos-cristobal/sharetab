import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import {
  getAIProvidersWithFallback,
  getConfiguredProviderPriority,
  isProviderConfigured,
  createProviderByName,
} from '@/server/ai/registry';
import { type AdminAction, type PrismaClient, Prisma } from '@/generated/prisma/client';
import nodemailer from 'nodemailer';
import fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import { getRecentLogs } from '@/server/lib/logger';
import { deleteGroupWithData } from '@/server/lib/group-delete';
import { lockGroupMembers } from '@/server/lib/group-balances';
import {
  countUnusedReceipts,
  deleteExpiredSplits,
  deleteUnusedReceipts,
  removeReceiptFiles,
} from '@/server/lib/receipt-cleanup';
import {
  checkMeridianHealth,
  invalidateMeridianHealthCache,
  sendAuthExpiryEmail,
} from '@/server/lib/auth-health-poller';
import {
  startLogin,
  submitCode,
  cancelLogin,
  logout as logoutMeridian,
  isLoginInProgress,
} from '@/server/lib/meridian-login';
import { clearProviderCache } from '@/server/ai/registry';
import { getMeridianStartError, startMeridianProxy } from '@/server/ai/providers/meridian';
import {
  checkOpenAICodexHealth,
  invalidateOpenAICodexHealthCache,
  startLogin as startOpenAICodexLogin,
  submitCode as submitOpenAICodexCode,
  cancelLogin as cancelOpenAICodexLogin,
  logout as logoutOpenAICodex,
  isLoginInProgress as isOpenAICodexLoginInProgress,
} from '@/server/lib/openai-codex-login';

import { getBuildInfo } from '@/server/lib/build-info';
import { REGISTRATION_MODES, readRegistrationMode } from '@/server/lib/registration-mode';
import { isGuestUploadsForcedOff, readGuestUploadsSetting, saveGuestUploadsSetting } from '@/server/lib/guest-uploads';

// How long a successful Meridian login waits for the proxy start attempt.
const MERIDIAN_LOGIN_START_WAIT_MS = 15_000;

const serverStartTime = new Date();
const { version: cachedVersion, commitSha: cachedCommitSha } = getBuildInfo();

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  const adminEmail = process.env.ADMIN_EMAIL;
  // When impersonating, use the real admin email for the check
  const effectiveEmail = ctx.impersonating ? ctx.impersonating.adminEmail : ctx.user.email;
  if (!adminEmail || effectiveEmail !== adminEmail) {
    throw new AppError('FORBIDDEN', 'adminRequired');
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
  metadata?: Record<string, unknown> | null,
) {
  await db.adminAuditLog.create({
    data: {
      adminId,
      action,
      ...(targetId != null ? { targetId } : {}),
      ...(metadata !== null && metadata !== undefined ? { metadata: metadata as Prisma.InputJsonValue } : {}),
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
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.adminAuditLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        ...(input.action ? { where: { action: input.action as AdminAction } } : {}),
        orderBy: { createdAt: 'desc' },
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
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      dbStatus = 'connected';
    } catch {
      // disconnected
    }

    // AI provider info
    let aiProvider = 'unknown';
    let aiAvailable = false;
    let aiStatus: 'available' | 'requires_auth' | 'unavailable' = 'unavailable';
    const authProvidersNeedingLogin: string[] = [];
    try {
      const configured = getConfiguredProviderPriority();
      const providers = await getAIProvidersWithFallback();
      aiProvider = configured.join(' -> ');
      aiAvailable = providers.length > 0;

      // Mark OAuth-backed providers that are configured but not currently usable.
      if (configured.includes('meridian')) {
        const meridianHealth = await checkMeridianHealth();
        if (meridianHealth.status !== 'healthy') {
          authProvidersNeedingLogin.push('meridian');
        }
      }

      if (configured.includes('openai-codex')) {
        const openAICodexHealth = await checkOpenAICodexHealth();
        if (openAICodexHealth.status === 'auth_expired' || openAICodexHealth.status === 'not_authenticated') {
          authProvidersNeedingLogin.push('openai-codex');
        }
      }

      aiStatus = authProvidersNeedingLogin.length > 0 ? 'requires_auth' : 'available';
    } catch {
      aiProvider = process.env.AI_PROVIDER_PRIORITY ?? 'not configured';
      aiStatus = 'unavailable';
    }

    return {
      dbStatus,
      aiProvider,
      aiAvailable,
      aiStatus,
      authProvidersNeedingLogin,
      version: cachedVersion,
      commitSha: cachedCommitSha,
      serverStartTime: serverStartTime.toISOString(),
      uptime: Math.floor((Date.now() - serverStartTime.getTime()) / 1000),
    };
  }),

  listUsers: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().max(200).optional(),
        sortBy: z.enum(['name', 'email', 'groupCount', 'createdAt']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        status: z.enum(['all', 'active', 'suspended', 'placeholder']).default('all'),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Build where clause
      const where: Prisma.UserWhereInput = {};

      if (input.status === 'active') {
        where.suspendedAt = null;
        where.isPlaceholder = false;
      } else if (input.status === 'suspended') {
        where.suspendedAt = { not: null };
      } else if (input.status === 'placeholder') {
        where.isPlaceholder = true;
      }

      if (input.search) {
        where.OR = [
          { name: { contains: input.search, mode: 'insensitive' } },
          { email: { contains: input.search, mode: 'insensitive' } },
          { placeholderName: { contains: input.search, mode: 'insensitive' } },
        ];
      }

      type UserOrderBy = Prisma.UserOrderByWithRelationInput;
      const dir = input.sortDirection;
      const idTiebreaker: UserOrderBy = { id: dir };
      let orderBy: UserOrderBy[];
      switch (input.sortBy) {
        case 'name':
          orderBy = [
            { name: { sort: dir, nulls: dir === 'asc' ? 'last' : 'first' } },
            { placeholderName: dir },
            idTiebreaker,
          ];
          break;
        case 'email':
          orderBy = [{ email: dir }, idTiebreaker];
          break;
        case 'groupCount':
          orderBy = [{ groupMembers: { _count: dir } }, idTiebreaker];
          break;
        case 'createdAt':
        default:
          orderBy = [{ createdAt: dir }, idTiebreaker];
          break;
      }

      const isFirstPage = !input.cursor;
      const [users, ...counts] = await Promise.all([
        ctx.db.user.findMany({
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
          where,
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
          orderBy,
        }),
        ...(isFirstPage ? [ctx.db.user.count({ where })] : []),
      ]);

      let nextCursor: string | undefined;
      if (users.length > input.limit) {
        const next = users.pop();
        nextCursor = next?.id;
      }

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
        totalCount: counts[0] as number | undefined,
        nextCursor,
      };
    }),

  suspendUser: adminProcedure.input(z.object({ userId: z.string() })).mutation(async ({ ctx, input }) => {
    if (input.userId === ctx.user.id) {
      throw new AppError('BAD_REQUEST', 'cannotSuspendYourself');
    }

    const user = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, suspendedAt: true },
    });

    if (!user) {
      throw new AppError('NOT_FOUND', 'userNotFound');
    }

    if (user.suspendedAt) {
      throw new AppError('BAD_REQUEST', 'alreadySuspended');
    }

    await ctx.db.user.update({
      where: { id: input.userId },
      data: { suspendedAt: new Date() },
    });

    await logAdminAction(ctx.db, ctx.user.id, 'USER_SUSPENDED', input.userId, { email: user.email });

    return { suspended: true, userId: input.userId };
  }),

  unsuspendUser: adminProcedure.input(z.object({ userId: z.string() })).mutation(async ({ ctx, input }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, suspendedAt: true, isPlaceholder: true },
    });

    if (!user) {
      throw new AppError('NOT_FOUND', 'userNotFound');
    }

    if (!user.suspendedAt) {
      throw new AppError('BAD_REQUEST', 'notSuspended');
    }

    if (user.isPlaceholder) {
      throw new AppError('BAD_REQUEST', 'cannotUnsuspend');
    }

    await ctx.db.user.update({
      where: { id: input.userId },
      data: { suspendedAt: null },
    });

    await logAdminAction(ctx.db, ctx.user.id, 'USER_UNSUSPENDED', input.userId, { email: user.email });

    return { unsuspended: true, userId: input.userId };
  }),

  deleteUser: adminProcedure.input(z.object({ userId: z.string() })).mutation(async ({ ctx, input }) => {
    if (input.userId === ctx.user.id) {
      throw new AppError('BAD_REQUEST', 'cannotDeleteYourself');
    }

    const user = await ctx.db.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true },
    });

    if (!user) {
      throw new AppError('NOT_FOUND', 'userNotFound');
    }

    await ctx.db.$transaction(async (tx) => {
      // Convert to placeholder to preserve financial history, then strip auth data
      await tx.user.update({
        where: { id: input.userId },
        data: {
          isPlaceholder: true,
          name: 'Deleted user',
          placeholderName: 'Deleted user',
          email: `deleted-${input.userId}@placeholder.local`,
          passwordHash: null,
          image: null,
          venmoUsername: null,
          suspendedAt: new Date(),
        },
      });
      // Remove auth records (sessions, accounts)
      await tx.account.deleteMany({ where: { userId: input.userId } });
      await tx.session.deleteMany({ where: { userId: input.userId } });
      // Transfer ownership before removing memberships
      const ownedGroups = await tx.groupMember.findMany({
        where: { userId: input.userId, role: 'OWNER' },
        select: { groupId: true },
      });
      const keepMembershipGroupIds: string[] = [];
      for (const { groupId } of ownedGroups) {
        const nextOwner = await tx.groupMember.findFirst({
          where: {
            groupId,
            userId: { not: input.userId },
            user: { isPlaceholder: false, suspendedAt: null },
          },
          orderBy: { joinedAt: 'asc' },
        });
        if (nextOwner) {
          await tx.groupMember.update({
            where: { id: nextOwner.id },
            data: { role: 'OWNER' },
          });
        } else {
          keepMembershipGroupIds.push(groupId);
        }
      }
      // Remove memberships except where user is the sole active owner
      await tx.groupMember.deleteMany({
        where: {
          userId: input.userId,
          ...(keepMembershipGroupIds.length > 0 ? { groupId: { notIn: keepMembershipGroupIds } } : {}),
        },
      });
    });

    await logAdminAction(ctx.db, ctx.user.id, 'USER_DELETED', input.userId, {
      email: user.email,
    });

    return { deleted: true, userId: input.userId };
  }),

  listGroups: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().max(200).optional(),
        sortBy: z.enum(['name', 'memberCount', 'expenseCount', 'createdAt']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        status: z.enum(['all', 'active', 'archived']).default('all'),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Build where clause
      const where: Prisma.GroupWhereInput = {};

      if (input.status === 'active') {
        where.archivedAt = null;
      } else if (input.status === 'archived') {
        where.archivedAt = { not: null };
      }

      if (input.search) {
        where.name = { contains: input.search, mode: 'insensitive' };
      }

      type GroupOrderBy = Prisma.GroupOrderByWithRelationInput;
      const dir = input.sortDirection;
      const idTiebreaker: GroupOrderBy = { id: dir };
      let orderBy: GroupOrderBy[];
      switch (input.sortBy) {
        case 'name':
          orderBy = [{ name: dir }, idTiebreaker];
          break;
        case 'memberCount':
          orderBy = [{ members: { _count: dir } }, idTiebreaker];
          break;
        case 'expenseCount':
          orderBy = [{ expenses: { _count: dir } }, idTiebreaker];
          break;
        case 'createdAt':
        default:
          orderBy = [{ createdAt: dir }, idTiebreaker];
          break;
      }

      const isFirstPage = !input.cursor;

      const [groups, ...countsArr] = await Promise.all([
        ctx.db.group.findMany({
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
          where,
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
            activityLogs: {
              select: { createdAt: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
          orderBy,
        }),
        ...(isFirstPage
          ? [
              ctx.db.group.count({ where }),
              ctx.db.expense.count({ where: { group: where } }),
              ctx.db.settlement.count({ where: { group: where } }),
            ]
          : []),
      ]);

      let nextCursor: string | undefined;
      if (groups.length > input.limit) {
        const next = groups.pop();
        nextCursor = next?.id;
      }

      const groupIds = groups.map((g) => g.id);
      const expenseSums =
        groupIds.length > 0
          ? await ctx.db.expense.groupBy({
              by: ['groupId'],
              where: { groupId: { in: groupIds } },
              _sum: { amount: true },
            })
          : [];
      const sumByGroup = new Map(expenseSums.map((e) => [e.groupId, e._sum.amount ?? 0]));

      const result = groups.map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: g._count.members,
        expenseCount: g._count.expenses,
        totalAmount: sumByGroup.get(g.id) ?? 0,
        lastActivity: g.activityLogs[0]?.createdAt ?? g.createdAt,
        isArchived: g.archivedAt !== null,
        createdAt: g.createdAt,
      }));

      return {
        groups: result,
        totalCount: countsArr[0] as number | undefined,
        totalExpenses: countsArr[1] as number | undefined,
        totalSettlements: countsArr[2] as number | undefined,
        nextCursor,
      };
    }),

  deleteGroup: adminProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    const group = await ctx.db.group.findUnique({
      where: { id: input.groupId },
      select: { id: true, name: true },
    });

    if (!group) {
      throw new AppError('NOT_FOUND', 'groupNotFound');
    }

    const imagePaths = await ctx.db.$transaction(async (tx) => {
      // Waits for balance changes, removals and transfers in flight, as the owner's delete does
      await lockGroupMembers(tx, input.groupId);
      return deleteGroupWithData(tx, input.groupId);
    });
    await removeReceiptFiles(imagePaths);

    await logAdminAction(ctx.db, ctx.user.id, 'GROUP_DELETED', input.groupId, { name: group.name });

    return { deleted: true, groupId: input.groupId };
  }),

  // ─── AI Usage Statistics ─────────────────────────────────

  getAIStats: adminProcedure.query(async ({ ctx }) => {
    const [total, byStatus, byProvider, last7Days, last30Days] = await Promise.all([
      ctx.db.receipt.count(),
      ctx.db.receipt.groupBy({
        by: ['status'],
        _count: true,
      }),
      ctx.db.receipt.groupBy({
        by: ['aiProvider'],
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
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number>,
      byProvider: Object.fromEntries(byProvider.map((p) => [p.aiProvider ?? 'unknown', p._count])) as Record<
        string,
        number
      >,
      last7Days,
      last30Days,
    };
  }),

  // ─── Registration Control ───────────────────────────────

  getRegistrationMode: adminProcedure.query(async ({ ctx }) => ({ mode: await readRegistrationMode(ctx.db) })),

  setRegistrationMode: adminProcedure
    .input(
      z.object({
        mode: z.enum(REGISTRATION_MODES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemSetting.upsert({
        where: { key: 'registrationMode' },
        update: { value: input.mode },
        create: { key: 'registrationMode', value: input.mode },
      });

      await logAdminAction(ctx.db, ctx.user.id, 'REGISTRATION_MODE_CHANGED', null, { mode: input.mode });

      return { mode: input.mode };
    }),

  createSystemInvite: adminProcedure
    .input(
      z.object({
        label: z.string().max(100).optional(),
        expiresInDays: z.number().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000) : null;

      const invite = await ctx.db.systemInvite.create({
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          expiresAt,
        },
      });

      await logAdminAction(ctx.db, ctx.user.id, 'INVITE_CREATED', invite.id, { code: invite.code, label: input.label });

      return {
        id: invite.id,
        code: invite.code,
        label: invite.label,
        expiresAt: invite.expiresAt,
      };
    }),

  listSystemInvites: adminProcedure.query(async ({ ctx }) => {
    const invites = await ctx.db.systemInvite.findMany({
      take: 200,
      include: {
        usedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((inv) => ({
      id: inv.id,
      code: inv.code,
      label: inv.label,
      usedBy: inv.usedBy ? { name: inv.usedBy.name, email: inv.usedBy.email } : null,
      usedAt: inv.usedAt,
      expiresAt: inv.expiresAt,
      revokedAt: inv.revokedAt,
      isActive: !inv.revokedAt && !inv.usedAt && (!inv.expiresAt || inv.expiresAt > new Date()),
      createdAt: inv.createdAt,
    }));
  }),

  revokeSystemInvite: adminProcedure.input(z.object({ inviteId: z.string() })).mutation(async ({ ctx, input }) => {
    const invite = await ctx.db.systemInvite.findUnique({
      where: { id: input.inviteId },
    });

    if (!invite) {
      throw new AppError('NOT_FOUND', 'inviteNotFound');
    }

    if (invite.revokedAt) {
      throw new AppError('BAD_REQUEST', 'inviteAlreadyRevoked');
    }

    await ctx.db.systemInvite.update({
      where: { id: input.inviteId },
      data: { revokedAt: new Date() },
    });

    await logAdminAction(ctx.db, ctx.user.id, 'INVITE_REVOKED', input.inviteId, { code: invite.code });

    return { revoked: true };
  }),

  // ─── Global Activity Feed ────────────────────────────────

  getGlobalActivity: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.activityLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        orderBy: { createdAt: 'desc' },
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
          userName: item.user?.name ?? item.user?.email ?? 'Deleted user',
          userEmail: item.user?.email ?? null,
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
      where: { key: 'announcement' },
    });
    return { message: setting?.value ?? null };
  }),

  setAnnouncement: adminProcedure
    .input(
      z.object({
        message: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.message || input.message.trim() === '') {
        // Clear announcement
        await ctx.db.systemSetting.deleteMany({
          where: { key: 'announcement' },
        });
      } else {
        await ctx.db.systemSetting.upsert({
          where: { key: 'announcement' },
          update: { value: input.message.trim() },
          create: { key: 'announcement', value: input.message.trim() },
        });
      }

      await logAdminAction(ctx.db, ctx.user.id, 'ANNOUNCEMENT_SET', null, { message: input.message ?? null });

      return { success: true };
    }),

  // ─── Venmo Payments Toggle ──────────────────────────────

  getVenmoEnabled: publicProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: 'venmoEnabled' },
    });
    return { enabled: setting?.value === 'true' };
  }),

  setVenmoEnabled: adminProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    await ctx.db.systemSetting.upsert({
      where: { key: 'venmoEnabled' },
      update: { value: String(input.enabled) },
      create: { key: 'venmoEnabled', value: String(input.enabled) },
    });

    await logAdminAction(ctx.db, ctx.user.id, 'VENMO_SETTING_CHANGED', null, { enabled: input.enabled });

    return { success: true };
  }),

  // ─── Guest Receipt Uploads Toggle ───────────────────────

  // `enabled` is the saved toggle; DISABLE_GUEST_UPLOADS overrides it.
  getGuestUploadsEnabled: adminProcedure.query(async ({ ctx }) => {
    return { enabled: await readGuestUploadsSetting(ctx.db), forcedOffByEnv: isGuestUploadsForcedOff() };
  }),

  setGuestUploadsEnabled: adminProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    // While the env var locks it, a saved value would only take effect later, unseen.
    if (isGuestUploadsForcedOff()) {
      throw new AppError('PRECONDITION_FAILED', 'guestUploadsLockedOff');
    }
    await saveGuestUploadsSetting(ctx.db, input.enabled);

    await logAdminAction(ctx.db, ctx.user.id, 'GUEST_UPLOADS_SETTING_CHANGED', null, { enabled: input.enabled });

    return { enabled: input.enabled };
  }),

  // ─── Email Test ──────────────────────────────────────────

  sendTestEmail: adminProcedure.mutation(async ({ ctx }) => {
    const host = process.env.EMAIL_SERVER_HOST;
    if (!host) {
      throw new AppError('PRECONDITION_FAILED', 'emailNotConfigured');
    }

    const transport = nodemailer.createTransport({
      host,
      port: parseInt(process.env.EMAIL_SERVER_PORT ?? '587'),
      secure: parseInt(process.env.EMAIL_SERVER_PORT ?? '587') === 465,
      auth: {
        user: process.env.EMAIL_SERVER_USER,
        pass: process.env.EMAIL_SERVER_PASSWORD,
      },
    });

    const from = process.env.EMAIL_FROM ?? 'ShareTab <noreply@sharetab.local>';
    const to = ctx.user.email!;

    try {
      await transport.sendMail({
        from,
        to,
        subject: 'ShareTab Test Email',
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

      await logAdminAction(ctx.db, ctx.user.id, 'TEST_EMAIL_SENT', null, {
        to,
      });

      return { success: true, sentTo: to };
    } catch (error) {
      throw new AppError('INTERNAL_SERVER_ERROR', 'testEmailFailed', {
        error: error instanceof Error ? error.message : 'Unknown error',
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
    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './uploads');

    let totalDiskUsage = 0;
    let orphanCount = 0;
    const orphanPaths: string[] = [];
    let diskFiles = 0;

    if (fs.existsSync(uploadDir)) {
      const scanDir = async (dir: string) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else {
            diskFiles++;
            const stat = await fsp.stat(fullPath);
            totalDiskUsage += stat.size;

            const relativePath = path.relative(uploadDir, fullPath).replace(/\\/g, '/');
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
      await scanDir(uploadDir);
    }

    const unused = await countUnusedReceipts(ctx.db);

    return {
      receiptCount,
      diskFiles,
      totalDiskUsage,
      totalDiskUsageFormatted: formatBytes(totalDiskUsage),
      orphanCount,
      orphanPaths,
      unusedReceiptCount: unused.count,
      unusedReceiptBytes: unused.bytes,
      unusedReceiptBytesFormatted: formatBytes(unused.bytes),
    };
  }),

  cleanupOrphans: adminProcedure.mutation(async ({ ctx }) => {
    // Get all receipt image paths from DB
    const receipts = await ctx.db.receipt.findMany({
      select: { imagePath: true },
    });
    const dbPaths = new Set(receipts.map((r) => r.imagePath));

    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './uploads');

    let deletedCount = 0;
    let freedBytes = 0;

    if (fs.existsSync(uploadDir)) {
      const scanAndDelete = async (dir: string) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanAndDelete(fullPath);
            try {
              const remaining = await fsp.readdir(fullPath);
              if (remaining.length === 0) {
                await fsp.rm(fullPath);
              }
            } catch {
              // ignore
            }
          } else {
            const relativePath = path.relative(uploadDir, fullPath).replace(/\\/g, '/');
            const isReferenced =
              dbPaths.has(relativePath) ||
              dbPaths.has(`uploads/${relativePath}`) ||
              dbPaths.has(`/uploads/${relativePath}`) ||
              dbPaths.has(fullPath);

            if (!isReferenced) {
              const stat = await fsp.stat(fullPath);
              freedBytes += stat.size;
              await fsp.unlink(fullPath);
              deletedCount++;
            }
          }
        }
      };
      await scanAndDelete(uploadDir);
    }

    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, 'ORPHANS_CLEANED', null, {
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

  // Receipts no group, expense or split uses, a day or more old (#312), with their files
  cleanupUnusedReceipts: adminProcedure.mutation(async ({ ctx }) => {
    const deletedCount = await deleteUnusedReceipts(ctx.db, 500);
    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, 'UNUSED_RECEIPTS_CLEANED', null, { deletedCount });
    }
    return { deletedCount };
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
    // With the receipts only they used (#265), a batch at a time so a large backlog
    // doesn't make one long transaction
    const batchSize = 500;
    let deletedCount = 0;
    for (;;) {
      const count = await deleteExpiredSplits(ctx.db, batchSize);
      deletedCount += count;
      if (count === 0) break;
    }

    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, 'EXPIRED_SPLITS_CLEANED', null, { deletedCount });
    }

    return { deletedCount };
  }),

  // ─── Server Logs ─────────────────────────────────────────

  getLogs: adminProcedure
    .input(
      z.object({
        minLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().min(1).max(500).default(200),
        afterId: z.number().optional(),
      }),
    )
    .query(({ input }) => {
      return getRecentLogs({
        ...(input.minLevel !== undefined ? { minLevel: input.minLevel } : {}),
        ...(input.search ? { search: input.search } : {}),
        limit: input.limit,
        ...(input.afterId !== undefined ? { afterId: input.afterId } : {}),
      });
    }),

  // ─── Meridian Auth ──────────────────────────────────────────

  getMeridianAuthStatus: adminProcedure.query(async () => {
    if (!isProviderConfigured('meridian')) {
      return { status: 'not_applicable' as const };
    }
    const health = await checkMeridianHealth();
    // A proxy that isn't listening has no health to report; show why its
    // last start failed instead.
    const startError = health.status === 'not_running' ? getMeridianStartError() : null;
    return {
      ...health,
      ...(startError ? { error: startError } : {}),
      loginInProgress: isLoginInProgress(),
    };
  }),

  startMeridianLogin: adminProcedure.mutation(async ({ ctx }) => {
    if (!isProviderConfigured('meridian')) {
      throw new AppError('PRECONDITION_FAILED', 'meridianNotConfigured');
    }

    try {
      const url = await startLogin();

      // Send email with login URL
      await sendAuthExpiryEmail('Re-authentication initiated from admin dashboard', url);

      await logAdminAction(ctx.db, ctx.user.id, 'MERIDIAN_LOGIN_STARTED', null, {
        url,
      });

      return { url };
    } catch (err) {
      throw err instanceof Error
        ? new AppError('INTERNAL_SERVER_ERROR', 'detail', { detail: err.message })
        : new AppError('INTERNAL_SERVER_ERROR', 'loginStartFailed');
    }
  }),

  completeMeridianLogin: adminProcedure
    .input(z.object({ code: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await submitCode(input.code);

        let proxyError: string | null = null;
        if (result.success) {
          clearProviderCache();
          // Wait (bounded) for the proxy start attempt before answering, then
          // drop the cached health: the page re-reads the status right after
          // this returns, and a check that lands before the proxy listens
          // caches "not running" for 15s.
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            startMeridianProxy(),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, MERIDIAN_LOGIN_START_WAIT_MS);
            }),
          ]);
          clearTimeout(timer);
          invalidateMeridianHealthCache();
          // The login itself succeeded; report a proxy that still can't start.
          proxyError = getMeridianStartError();
        }

        await logAdminAction(
          ctx.db,
          ctx.user.id,
          result.success ? 'MERIDIAN_LOGIN_COMPLETED' : 'MERIDIAN_LOGIN_FAILED',
          null,
          { success: result.success, error: result.error, ...(proxyError ? { proxyError } : {}) },
        );

        return { ...result, ...(proxyError ? { proxyError } : {}) };
      } catch (err) {
        throw err instanceof Error
          ? new AppError('INTERNAL_SERVER_ERROR', 'detail', { detail: err.message })
          : new AppError('INTERNAL_SERVER_ERROR', 'loginCodeFailed');
      }
    }),

  cancelMeridianLogin: adminProcedure.mutation(async ({ ctx }) => {
    cancelLogin();
    await logAdminAction(ctx.db, ctx.user.id, 'MERIDIAN_LOGIN_FAILED', null, {
      reason: 'cancelled',
    });
    return { cancelled: true };
  }),

  logoutMeridian: adminProcedure.mutation(async ({ ctx }) => {
    if (!isProviderConfigured('meridian')) {
      throw new AppError('PRECONDITION_FAILED', 'meridianNotConfigured');
    }

    const result = logoutMeridian();
    if (!result.success) {
      throw result.error
        ? new AppError('INTERNAL_SERVER_ERROR', 'detail', { detail: result.error })
        : new AppError('INTERNAL_SERVER_ERROR', 'meridianLogoutFailed');
    }

    clearProviderCache();
    invalidateMeridianHealthCache();
    await logAdminAction(ctx.db, ctx.user.id, 'MERIDIAN_LOGOUT', null, {
      reason: 'logged_out',
    });
    return { success: true };
  }),

  getMeridianNotifyPreference: adminProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: 'meridianNotifyInterval' },
    });
    return {
      interval: (setting?.value ?? 'once') as 'once' | '1h' | '6h' | '24h',
    };
  }),

  setMeridianNotifyPreference: adminProcedure
    .input(
      z.object({
        interval: z.enum(['once', '1h', '6h', '24h']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemSetting.upsert({
        where: { key: 'meridianNotifyInterval' },
        update: { value: input.interval },
        create: { key: 'meridianNotifyInterval', value: input.interval },
      });

      await logAdminAction(ctx.db, ctx.user.id, 'MERIDIAN_NOTIFY_PREFERENCE_CHANGED', null, {
        interval: input.interval,
      });

      return { interval: input.interval };
    }),

  // ─── OpenAI Codex Auth ─────────────────────────────────────

  getOpenAICodexAuthStatus: adminProcedure.query(async () => {
    if (!isProviderConfigured('openai-codex')) {
      return { status: 'not_applicable' as const };
    }
    const health = await checkOpenAICodexHealth();
    return {
      ...health,
      loginInProgress: isOpenAICodexLoginInProgress(),
    };
  }),

  startOpenAICodexLogin: adminProcedure.mutation(async () => {
    if (!isProviderConfigured('openai-codex')) {
      throw new AppError('PRECONDITION_FAILED', 'codexNotConfigured');
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
    if (!isProviderConfigured('openai-codex')) {
      throw new AppError('PRECONDITION_FAILED', 'codexNotConfigured');
    }

    const result = logoutOpenAICodex();
    if (!result.success) {
      throw result.error
        ? new AppError('INTERNAL_SERVER_ERROR', 'detail', { detail: result.error })
        : new AppError('INTERNAL_SERVER_ERROR', 'codexLogoutFailed');
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
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const start = Date.now();
      let provider;
      try {
        provider = await createProviderByName(input.providerName);
      } catch (err) {
        const error =
          err instanceof Error
            ? new AppError('BAD_REQUEST', 'detail', { detail: err.message })
            : new AppError('BAD_REQUEST', 'providerCreateFailed');
        await logAdminAction(ctx.db, ctx.user.id, 'AI_PROVIDER_TESTED', null, {
          provider: input.providerName,
          durationMs: Date.now() - start,
          success: false,
          error: error.message,
        });
        throw error;
      }

      const available = await provider.isAvailable();
      if (!available) {
        const error = new AppError('PRECONDITION_FAILED', 'providerUnavailable', { provider: input.providerName });
        await logAdminAction(ctx.db, ctx.user.id, 'AI_PROVIDER_TESTED', null, {
          provider: input.providerName,
          durationMs: Date.now() - start,
          success: false,
          error: error.message,
        });
        throw error;
      }

      const imageBuffer = Buffer.from(input.imageBase64, 'base64');
      if (imageBuffer.length > 5 * 1024 * 1024) {
        const error = new AppError('BAD_REQUEST', 'testImageTooLarge');
        await logAdminAction(ctx.db, ctx.user.id, 'AI_PROVIDER_TESTED', null, {
          provider: input.providerName,
          durationMs: Date.now() - start,
          success: false,
          error: error.message,
        });
        throw error;
      }

      try {
        const result = await provider.extractReceipt(imageBuffer, input.mimeType);
        const durationMs = Date.now() - start;

        await logAdminAction(ctx.db, ctx.user.id, 'AI_PROVIDER_TESTED', null, {
          provider: input.providerName,
          durationMs,
          success: true,
        });

        return { result, durationMs };
      } catch (err) {
        const durationMs = Date.now() - start;
        // SERVICE_UNAVAILABLE (503): the provider failed, not ShareTab. Not
        // BAD_GATEWAY: Cloudflare (and proxies set to intercept errors)
        // replaces a 502 or 504 body with its own HTML page, hiding this
        // message.
        const error =
          err instanceof Error
            ? new AppError('SERVICE_UNAVAILABLE', 'detail', { detail: err.message })
            : new AppError('SERVICE_UNAVAILABLE', 'extractionFailed');

        await logAdminAction(ctx.db, ctx.user.id, 'AI_PROVIDER_TESTED', null, {
          provider: input.providerName,
          durationMs,
          success: false,
          error: error.message,
        });

        throw error;
      }
    }),
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
