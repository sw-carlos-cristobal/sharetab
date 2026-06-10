/**
 * Sentinel returned when no client IP header is present. Callers that key
 * per-IP rate-limit buckets should treat this as "identity unknown" and
 * skip (or widen) the bucket rather than lumping every client together.
 */
export const FALLBACK_IP = "global";

/**
 * Derives the client IP from proxy headers.
 *
 * Precedence: `cf-connecting-ip` (set by Cloudflare, hardest to spoof when
 * behind it), then `x-real-ip` (set by the immediate reverse proxy), then
 * the first entry of `x-forwarded-for` (easiest for clients to spoof),
 * falling back to a shared constant when none is present (so rate limiting
 * still applies globally rather than not at all). The same order is used
 * by every per-IP limiter (login, guest uploads, guest AI quotas).
 *
 * SECURITY: these headers are client-supplied unless a trusted reverse proxy
 * strips/overwrites them. When ShareTab is exposed directly (no proxy), an
 * attacker can rotate header values to get fresh per-IP rate-limit buckets.
 * The precedence above is likewise only meaningful behind a proxy that
 * manages these headers: if a deployment's proxy sets `x-forwarded-for`
 * but passes client-supplied `x-real-ip` through untouched, the client
 * chooses its own bucket regardless of order — no ordering fixes that.
 * Next.js route handlers do not expose the socket address, so callers must
 * treat per-IP limits as defense-in-depth, never the only control — pair
 * them with per-account or global caps (see `src/server/auth.ts` per-email
 * bucket and the guest global caps). Operators should front the app with a
 * proxy that sets these headers from the connection (see .env.example).
 */
// Longest legitimate value is an IPv6 address with a zone id (~50 chars);
// anything longer is garbage, but capping (rather than rejecting) keeps a
// stable per-sender bucket and bounds rate-limit key size and log output.
const MAX_IP_LENGTH = 64;

function normalizeHeaderIp(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first.slice(0, MAX_IP_LENGTH) : undefined;
}

export function getClientIp(headers: Headers): string {
  return (
    normalizeHeaderIp(headers.get("cf-connecting-ip")) ||
    normalizeHeaderIp(headers.get("x-real-ip")) ||
    normalizeHeaderIp(headers.get("x-forwarded-for")) ||
    FALLBACK_IP
  );
}
