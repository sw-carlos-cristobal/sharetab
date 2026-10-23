/**
 * A password version (#397): when the user's password last changed, in milliseconds, 0 if it never
 * has. A session carries the version it signed in under (the jwt callback in `auth.ts`); one whose
 * version is no longer the user's has ended.
 */
export function passwordStamp(changedAt: Date | null | undefined): number {
  return changedAt?.getTime() ?? 0;
}
