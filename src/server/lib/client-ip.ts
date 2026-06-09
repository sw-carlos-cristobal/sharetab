const FALLBACK_IP = "global";

/**
 * Derives the client IP from proxy headers.
 *
 * Precedence: first entry of `x-forwarded-for`, then `x-real-ip`,
 * falling back to a shared constant when neither is present (so
 * rate limiting still applies globally rather than not at all).
 */
export function getClientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    FALLBACK_IP
  );
}
