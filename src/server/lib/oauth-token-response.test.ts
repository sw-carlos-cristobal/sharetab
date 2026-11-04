import { describe, expect, test } from 'vitest';
import { describeTokenError, MALFORMED_TOKEN_RESPONSE, readTokenBody } from './oauth-token-response';

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

/** A response whose body fails while it is read, with a message that quotes a secret */
function brokenStream(status: number) {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('stream broke after tok_SECRETSECRET'));
    },
  });
  return new Response(body, { status });
}

describe('describeTokenError', () => {
  test('keeps the status and an RFC 6749 error code', async () => {
    expect(await describeTokenError(json({ error: 'invalid_grant', error_description: 'code abc' }, 400))).toEqual({
      status: 400,
      error: 'invalid_grant',
    });
  });

  test('drops an error code RFC 6749 does not define (it can echo what was sent)', async () => {
    expect(await describeTokenError(json({ error: 'bad code CODE123456' }, 400))).toEqual({ status: 400 });
  });

  test('drops a non-string error value (array or object)', async () => {
    expect(await describeTokenError(json({ error: ['invalid_grant'] }, 400))).toEqual({ status: 400 });
    expect(await describeTokenError(json({ error: { code: 'invalid_grant' } }, 400))).toEqual({ status: 400 });
  });

  test('keeps only the status for a body that is not JSON, or fails while it is read', async () => {
    expect(await describeTokenError(new Response('<html>CODE123456</html>', { status: 502 }))).toEqual({
      status: 502,
    });
    expect(await describeTokenError(brokenStream(500))).toEqual({ status: 500 });
  });
});

describe('readTokenBody', () => {
  test('returns the JSON object', async () => {
    expect(await readTokenBody(json({ access_token: 'a', expires_in: 60 }, 200))).toEqual({
      access_token: 'a',
      expires_in: 60,
    });
  });

  test('fails with a fixed error for a body that is not JSON, not an object, or fails while it is read', async () => {
    await expect(readTokenBody(new Response('tok_SECRETSECRET is not JSON', { status: 200 }))).rejects.toThrow(
      new Error(MALFORMED_TOKEN_RESPONSE),
    );
    await expect(readTokenBody(json('tok_SECRETSECRET', 200))).rejects.toThrow(new Error(MALFORMED_TOKEN_RESPONSE));
    await expect(readTokenBody(json(null, 200))).rejects.toThrow(new Error(MALFORMED_TOKEN_RESPONSE));
    await expect(readTokenBody(json(['tok_SECRETSECRET'], 200))).rejects.toThrow(new Error(MALFORMED_TOKEN_RESPONSE));
    await expect(readTokenBody(brokenStream(200))).rejects.toThrow(new Error(MALFORMED_TOKEN_RESPONSE));
  });
});
