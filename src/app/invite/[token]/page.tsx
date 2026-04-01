"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UserPlus } from "lucide-react";
import Link from "next/link";

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { data: session, status } = useSession();

  const joinGroup = trpc.groups.joinByInvite.useMutation({
    onSuccess: (data) => {
      router.push(`/groups/${data.groupId}`);
    },
  });

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push(`/login?callbackUrl=/invite/${token}`);
    }
  }, [status, router, token]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <UserPlus className="mx-auto mb-2 h-8 w-8 text-primary" />
          <CardTitle>Join Group</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            You&apos;ve been invited to join a group on ShareTab.
          </p>

          {joinGroup.error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {joinGroup.error.message}
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => joinGroup.mutate({ token })}
            disabled={joinGroup.isPending}
          >
            {joinGroup.isPending ? "Joining..." : "Accept Invite"}
          </Button>

          <Button variant="ghost" className="w-full" nativeButton={false} render={<Link href="/dashboard" />}>
            Go to Dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
