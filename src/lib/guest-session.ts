import { z } from "zod";

const guestSessionTokenSchema = z.string().uuid();

export const storedClaimIdentitySchema = z.object({
  name: z.string(),
  personToken: guestSessionTokenSchema,
});
export type StoredClaimIdentity = z.infer<typeof storedClaimIdentitySchema>;

export function normalizeGuestName(name: string): string {
  return name.trim().toLowerCase();
}

export function isGuestSessionToken(value: string): boolean {
  return guestSessionTokenSchema.safeParse(value).success;
}
