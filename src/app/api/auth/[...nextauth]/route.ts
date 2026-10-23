import type { NextRequest } from 'next/server';
import { handlers } from '@/server/auth';
import { db } from '@/server/db';
import { keepSessionWhileDatabaseDown } from '@/server/lib/session-endpoint';

// The session endpoint keeps the cookie through a database outage (#397, session-endpoint.ts)
const pingDatabase = () => db.$queryRaw`SELECT 1`;

export async function GET(request: NextRequest) {
  return keepSessionWhileDatabaseDown(request, await handlers.GET(request), pingDatabase);
}

export async function POST(request: NextRequest) {
  return keepSessionWhileDatabaseDown(request, await handlers.POST(request), pingDatabase);
}
