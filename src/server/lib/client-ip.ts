const FALLBACK_IP = "global";

/**
 * Derives the client IP from proxy headers.
 *
 * Precedence: `cf-connecting-ip` (set by Cloudflare, hardest to spoof when
 * behind it), then the first entry of `x-forwarded-for`, then `x-real-ip`,
 * falling back to a shared constant when none is present (so rate limiting
 * still applies globally rather than not at all).
 *
 * SECURITY: these headers are client-supplied unless a trusted reverse proxy
 * strips/overwrites them. When ShareTab is exposed directly (no proxy), an
 * attacker can rotate header values to get fresh per-IP rate-limit buckets.
 * Next.js route handlers do not expose the socket address, so callers must
 * treat per-IP limits as defense-in-depth, never the only control — pair
 * them with per-account or global caps (see `src/server/auth.ts` per-email
 * bucket and the guest global caps). Operators should front the app with a
 * proxy that sets these headers from the connection (see .env.example).
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    FALLBACK_IP
  );
}
