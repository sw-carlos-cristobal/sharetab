import { NextRequest } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { readFile, stat } from 'fs/promises';
import { resolveUploadPath } from '@/server/lib/upload-dir';

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
};

async function isSharedForClaiming(receiptId: string) {
  const split = await db.guestSplit.findFirst({
    where: { receiptId, receiptShared: true, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  return split !== null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth();

  const { path } = await params;
  const filePath = path.join('/');

  let fullPath: string;
  try {
    fullPath = resolveUploadPath(filePath);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  // Verify receipt ownership
  const receipt = await db.receipt.findFirst({
    where: { imagePath: filePath },
    // A placeholder removed from the group keeps their row (#284), which isn't membership
    include: { group: { include: { members: { where: { removedAt: null } } } } },
  });

  if (!receipt) {
    return new Response('Not found', { status: 404 });
  }

  if (receipt.isGuest) {
    // Guest receipts are viewable by anyone (authenticated or not)
  } else if (await isSharedForClaiming(receipt.id)) {
    // So is a group's receipt while a split made from it is open (#318): the group scan
    // page's Share Link makes a claim session from it, whose page shows the image to
    // anyone with the link. Only a split whose creator could see the receipt counts
    // (receiptShared), not one made before that was checked
  } else if (session?.user?.id) {
    // Authenticated user: must be the uploader or a member of the receipt's group
    const isUploader = receipt.uploadedById === session.user.id;
    const isGroupMember = receipt.group?.members.some((m: { userId: string }) => m.userId === session.user.id) ?? false;
    if (!isUploader && !isGroupMember) {
      return new Response('Forbidden', { status: 403 });
    }
  } else {
    // Unauthenticated user trying to access non-guest receipt
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    await stat(fullPath);
    const buffer = await readFile(fullPath);
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    return new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
