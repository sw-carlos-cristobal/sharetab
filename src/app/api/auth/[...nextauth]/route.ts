import type { NextRequest } from 'next/server';
import { handlers } from '@/server/auth';
import { keepSessionWhileDatabaseDown } from '@/server/lib/session-endpoint';

// The session endpoint keeps the cookie when the password version can't be read (#397, session-endpoint.ts)
export async function GET(request: NextRequest) {
  return keepSessionWhileDatabaseDown(request, handlers.GET);
}

export async function POST(request: NextRequest) {
  return keepSessionWhileDatabaseDown(request, handlers.POST);
}
