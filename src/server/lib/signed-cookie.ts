import { createHmac, timingSafeEqual } from "crypto";

function getSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET or NEXTAUTH_SECRET must be set");
  return secret;
}

export function signPayload(payload: string): string {
  const signature = createHmac("sha256", getSecret()).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function verifyAndParse<T = Record<string, unknown>>(signed: string): T | null {
  const lastDot = signed.lastIndexOf(".");
  if (lastDot === -1) return null;

  const payload = signed.substring(0, lastDot);
  const signature = signed.substring(lastDot + 1);

  const expected = createHmac("sha256", getSecret()).update(payload).digest("hex");

  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}
