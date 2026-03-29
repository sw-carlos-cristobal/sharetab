"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Trash2, UserPlus } from "lucide-react";
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
  const [placeholderName, setPlaceholderName] = useState("");

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

  const addPlaceholder = trpc.groups.addPlaceholder.useMutation({
    onSuccess: () => {
      setPlaceholderName("");
      utils.groups.get.invalidate({ groupId });
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

  function handleAddPlaceholder(e: React.FormEvent) {
    e.preventDefault();
    if (!placeholderName.trim()) return;
    addPlaceholder.mutate({ groupId, name: placeholderName.trim() });
  }

  if (group.isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!group.data) return <p className="text-destructive">Group not found.</p>;

  const placeholders = group.data.members.filter((m) => m.user.isPlaceholder);
  const realMembers = group.data.members.filter((m) => !m.user.isPlaceholder);

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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Add Member
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Add someone to the group who doesn&apos;t have an account yet.
            They can be assigned expenses and will show up in splits.
            If they sign up later, their data can be merged into their real account.
          </p>
          <form onSubmit={handleAddPlaceholder} className="flex gap-2">
            <Input
              placeholder="Name (e.g., Dave)"
              value={placeholderName}
              onChange={(e) => setPlaceholderName(e.target.value)}
              required
            />
            <Button type="submit" disabled={addPlaceholder.isPending}>
              {addPlaceholder.isPending ? "Adding..." : "Add"}
            </Button>
          </form>
          {addPlaceholder.error && (
            <p className="text-sm text-destructive">{addPlaceholder.error.message}</p>
          )}

          {placeholders.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-sm font-medium text-muted-foreground">
                Placeholder members ({placeholders.length})
              </p>
              {placeholders.map((m) => (
                <div
                  key={m.user.id}
                  className="flex items-center justify-between rounded-md border border-dashed p-2"
                >
                  <span className="text-sm">
                    {m.user.placeholderName ?? m.user.name}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    Pending
                  </Badge>
                </div>
              ))}
            </div>
          )}
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
