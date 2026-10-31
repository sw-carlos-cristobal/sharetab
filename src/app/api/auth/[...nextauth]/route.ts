import type { NextRequest } from 'next/server';
import { handlers } from '@/server/auth';
import { warnOnAuthUrlSchemeMismatch } from '@/server/lib/auth-url-check';
import { keepSessionWhileDatabaseDown } from '@/server/lib/session-endpoint';

// The session endpoint keeps the cookie when the password version can't be read (#397, session-endpoint.ts).
// Every page load reads the session here, so a NEXTAUTH_URL whose scheme isn't the browser's is logged
// once, before it shows up as a sign-in that silently fails (#409).
export async function GET(request: NextRequest) {
  warnOnAuthUrlSchemeMismatch(request.headers);
  return keepSessionWhileDatabaseDown(request, handlers.GET);
}

export async function POST(request: NextRequest) {
  warnOnAuthUrlSchemeMismatch(request.headers);
  return keepSessionWhileDatabaseDown(request, handlers.POST);
}
