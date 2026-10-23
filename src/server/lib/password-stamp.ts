/**
 * A password version (#397): when the user's password last changed, in milliseconds, 0 if it never
 * has. A session carries the version it signed in under (`auth.ts`); one whose version is no longer
 * the user's has ended.
 */
export function passwordStamp(changedAt: Date | string | null | undefined): number {
  return changedAt ? new Date(changedAt).getTime() : 0;
}
