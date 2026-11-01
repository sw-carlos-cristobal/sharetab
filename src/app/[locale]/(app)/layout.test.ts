import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

const { auth, mockDb, MobileHeader, AppSidebar } = vi.hoisted(() => ({
  auth: vi.fn(),
  mockDb: { $queryRaw: vi.fn(), user: { findMany: vi.fn() } },
  MobileHeader: vi.fn(() => null),
  AppSidebar: vi.fn(() => null),
}));
vi.mock('@/server/auth', () => ({ auth }));
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader }));
vi.mock('@/components/layout/sidebar', () => ({ AppSidebar }));
vi.mock('@/components/layout/announcement-banner', () => ({ AnnouncementBanner: () => null }));
vi.mock('@/components/layout/impersonation-banner', () => ({ ImpersonationBanner: () => null }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import AppLayout from './layout';

/** The `isAdmin` prop the layout passes to `component`, wherever it is in the tree. */
function isAdminPropOf(tree: ReactNode, component: unknown): unknown {
  if (!isValidElement(tree)) return undefined;
  const element = tree as ReactElement<{ isAdmin?: boolean; children?: ReactNode }>;
  if (element.type === component) return element.props.isAdmin;
  const children = ([] as ReactNode[]).concat(element.props.children ?? []);
  for (const child of children) {
    const found = isAdminPropOf(child, component);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function adminLinkShownTo(user: { id: string; email: string }) {
  auth.mockResolvedValue({ user });
  const tree = await AppLayout({ children: null, params: Promise.resolve({ locale: 'en' }) });
  const header = isAdminPropOf(tree, MobileHeader);
  expect(isAdminPropOf(tree, AppSidebar)).toBe(header);
  return header;
}

/** The accounts the case-insensitive lookup of ADMIN_EMAIL finds. */
function accountsWithAdminEmail(rows: { id: string; email: string }[]) {
  mockDb.$queryRaw.mockResolvedValueOnce(rows.map(({ id }) => ({ id })));
  mockDb.user.findMany.mockResolvedValueOnce(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ADMIN_EMAIL', 'admin@example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app layout: the Admin link (#399)', () => {
  test('shows it to the admin', async () => {
    await expect(adminLinkShownTo({ id: 'admin-1', email: 'admin@example.com' })).resolves.toBe(true);
  });

  test('shows it to an admin who registered the address in other letter case', async () => {
    accountsWithAdminEmail([{ id: 'admin-1', email: 'Admin@Example.com' }]);
    await expect(adminLinkShownTo({ id: 'admin-1', email: 'Admin@Example.com' })).resolves.toBe(true);
  });

  test('ignores letter case and spaces in ADMIN_EMAIL', async () => {
    vi.stubEnv('ADMIN_EMAIL', '  ADMIN@example.com ');
    accountsWithAdminEmail([{ id: 'admin-1', email: 'admin@example.com' }]);
    await expect(adminLinkShownTo({ id: 'admin-1', email: 'admin@example.com' })).resolves.toBe(true);
  });

  test('hides it from a case variant while another account has the address exactly', async () => {
    accountsWithAdminEmail([
      { id: 'other', email: 'Admin@example.com' },
      { id: 'admin-1', email: 'admin@example.com' },
    ]);
    await expect(adminLinkShownTo({ id: 'other', email: 'Admin@example.com' })).resolves.toBe(false);
  });

  test('hides it from anyone else', async () => {
    await expect(adminLinkShownTo({ id: 'user-1', email: 'user@example.com' })).resolves.toBe(false);
  });

  test.each([
    ['unset', undefined],
    ['blank', '  '],
  ])('hides it from everyone while ADMIN_EMAIL is %s', async (_, value) => {
    vi.stubEnv('ADMIN_EMAIL', value);
    await expect(adminLinkShownTo({ id: 'admin-1', email: 'admin@example.com' })).resolves.toBe(false);
  });
});
