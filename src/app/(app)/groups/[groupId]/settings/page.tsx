"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Trash2 } from "lucide-react";
import Link from "next/link";

export default function GroupSettingsPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const router = useRouter();
  const group = trpc.groups.get.useQuery({ groupId });
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (group.data) {
      setName(group.data.name);
      setDescription(group.data.description ?? "");
    }
  }, [group.data]);

  const updateGroup = trpc.groups.update.useMutation({
    onSuccess: () => {
      utils.groups.get.invalidate({ groupId });
      utils.groups.list.invalidate();
    },
  });

  const deleteGroup = trpc.groups.delete.useMutation({
    onSuccess: () => {
      router.push("/groups");
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    updateGroup.mutate({
      groupId,
      name,
      description: description || undefined,
    });
  }

  if (group.isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!group.data) return <p className="text-destructive">Group not found.</p>;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">Group Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={updateGroup.isPending}>
              {updateGroup.isPending ? "Saving..." : "Save changes"}
            </Button>
            {updateGroup.isSuccess && (
              <p className="text-sm text-green-600">Saved!</p>
            )}
          </form>
        </CardContent>
      </Card>

      <Separator />

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Deleting a group removes all expenses, settlements, and member data permanently.
          </p>
          <Button
            variant="destructive"
            onClick={() => {
              if (confirm("Are you sure? This cannot be undone.")) {
                deleteGroup.mutate({ groupId });
              }
            }}
            disabled={deleteGroup.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleteGroup.isPending ? "Deleting..." : "Delete group"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
