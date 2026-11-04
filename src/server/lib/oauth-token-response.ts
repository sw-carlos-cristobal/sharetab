// Token endpoint bodies can carry credentials, and so can an error page from something in
// front of the endpoint that echoes the request. The only parts that reach a log line or an
// error message (which the admin audit log stores) are the status, a known OAuth error code,
// and fields the caller has type-checked. Shared by the Claude (Meridian) and ChatGPT (OpenAI
// Codex) logins.

// The error codes RFC 6749 defines: §5.2 for the token endpoint, and §4.1.2.1 for
// authorization responses, which some servers also return from the token endpoint
const OAUTH_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'unsupported_response_type',
  'server_error',
  'temporarily_unavailable',
]);

/** The error for a token response that isn't a JSON object, or fails while it's read. */
export const MALFORMED_TOKEN_RESPONSE = 'Malformed token response';

/**
 * The status and error code of a failed token request: all that is logged or shown. The code
 * is kept only if it is one RFC 6749 defines. Anything else in the body (other error values,
 * error_description, extra fields, a proxy's error page) can echo the code or token that was
 * sent.
 */
export async function describeTokenError(res: Response): Promise<{ status: number; error?: string }> {
  const body: unknown = await res.json().catch(() => null);
  const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  return typeof error === 'string' && OAUTH_ERROR_CODES.has(error)
    ? { status: res.status, error }
    : { status: res.status };
}

/**
 * A successful token response's body, as an object for the caller to type-check. A parse
 * error's message can quote up to 20 characters of the body, and a read error's can quote
 * anything, so a body that isn't a JSON object fails with a fixed error.
 */
export async function readTokenBody(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(MALFORMED_TOKEN_RESPONSE);
  return body as Record<string, unknown>;
}
