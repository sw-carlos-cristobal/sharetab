"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Copy, Link } from "lucide-react";

export function InviteDialog({
  groupId,
  open,
  onOpenChange,
}: {
  groupId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const createInvite = trpc.groups.createInvite.useMutation();

  function handleGenerate() {
    createInvite.mutate({ groupId });
  }

  function getInviteUrl(token: string) {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return `${base}/invite/${token}`;
  }

  async function handleCopy() {
    if (!createInvite.data) return;
    const url = getInviteUrl(createInvite.data.token);
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite to group</DialogTitle>
          <DialogDescription>
            Generate an invite link to share with friends. Links expire after 7 days.
          </DialogDescription>
        </DialogHeader>

        {!createInvite.data ? (
          <Button onClick={handleGenerate} disabled={createInvite.isPending}>
            <Link className="mr-2 h-4 w-4" />
            {createInvite.isPending ? "Generating..." : "Generate invite link"}
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                readOnly
                value={getInviteUrl(createInvite.data.token)}
                className="font-mono text-xs"
              />
              <Button variant="outline" size="icon" aria-label="Copy invite link" onClick={handleCopy}>
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Anyone with this link can join the group.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
