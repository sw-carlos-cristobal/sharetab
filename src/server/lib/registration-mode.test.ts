import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { isRegistrationOpen, readRegistrationMode } from './registration-mode';

function dbWithMode(value: string | null) {
  const findUnique = vi.fn().mockResolvedValue(value === null ? null : { value });
  return { findUnique, client: { systemSetting: { findUnique } } as unknown as PrismaClient };
}

describe('readRegistrationMode', () => {
  test.each([
    [null, 'open'],
    ['open', 'open'],
    ['something-else', 'open'],
    // Only the exact stored values count.
    ['Closed', 'open'],
    [' closed', 'open'],
    ['invite-only', 'invite-only'],
    ['closed', 'closed'],
  ])('stored setting %s reads as %s', async (stored, mode) => {
    const { findUnique, client } = dbWithMode(stored);
    expect(await readRegistrationMode(client)).toBe(mode);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'registrationMode' } }));
  });
});

describe('isRegistrationOpen', () => {
  test.each([
    [null, true],
    ['something-else', true],
    ['invite-only', false],
    ['closed', false],
  ])('stored setting %s reads as open: %s', async (stored, open) => {
    expect(await isRegistrationOpen(dbWithMode(stored).client)).toBe(open);
  });
});
