"use client";

import { use, useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Archive, ArchiveRestore, ArrowLeft, Pencil, Trash2, UserPlus, Check, X } from "lucide-react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

export default function GroupSettingsPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const router = useRouter();
  const t = useTranslations("groups");
  const group = trpc.groups.get.useQuery({ groupId });
  const utils = trpc.useUtils();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [placeholderName, setPlaceholderName] = useState("");
  const [editingPlaceholder, setEditingPlaceholder] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

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

  const archiveGroup = trpc.groups.archive.useMutation({
    onSuccess: () => {
      utils.groups.list.invalidate();
      utils.groups.listArchived.invalidate();
      router.push("/groups");
    },
  });

  const unarchiveGroup = trpc.groups.unarchive.useMutation({
    onSuccess: () => {
      utils.groups.get.invalidate({ groupId });
      utils.groups.list.invalidate();
      utils.groups.listArchived.invalidate();
    },
  });

  const addPlaceholder = trpc.groups.addPlaceholder.useMutation({
    onSuccess: () => {
      setPlaceholderName("");
      utils.groups.get.invalidate({ groupId });
    },
  });

  const renamePlaceholder = trpc.groups.renamePlaceholder.useMutation({
    onSuccess: () => {
      setEditingPlaceholder(null);
      utils.groups.get.invalidate({ groupId });
    },
  });

  const removeMember = trpc.groups.removeMember.useMutation({
    onSuccess: () => utils.groups.get.invalidate({ groupId }),
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

  if (group.isLoading) return <LoadingSpinner />;
  if (!group.data) return <p className="text-destructive">{t("settings.notFound")}</p>;

  const placeholders = group.data.members.filter((m) => m.user.isPlaceholder);
  const realMembers = group.data.members.filter((m) => !m.user.isPlaceholder);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label={t("settings.backToGroup")} nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t("settings.title")}</h1>
      </div>

      {group.data.archivedAt && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
          <Archive className="h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{t("settings.archived")}</p>
            <p className="text-amber-700 dark:text-amber-300">
              {t("settings.archivedOn", { date: new Date(group.data.archivedAt).toLocaleDateString() })}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => unarchiveGroup.mutate({ groupId })}
            disabled={unarchiveGroup.isPending}
          >
            <ArchiveRestore className="mr-2 h-4 w-4" />
            {t("settings.unarchive")}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.details")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t("settings.name")}</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t("settings.description")}</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={updateGroup.isPending}>
              {updateGroup.isPending ? t("settings.saving") : t("settings.saveChanges")}
            </Button>
            {updateGroup.isSuccess && (
              <p className="text-sm text-green-600">{t("settings.saved")}</p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            {t("settings.addMemberTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("settings.addMemberDescription")}
          </p>
          <form onSubmit={handleAddPlaceholder} className="flex gap-2">
            <Input
              placeholder={t("settings.namePlaceholder")}
              value={placeholderName}
              onChange={(e) => setPlaceholderName(e.target.value)}
              required
            />
            <Button type="submit" disabled={addPlaceholder.isPending}>
              {addPlaceholder.isPending ? t("settings.adding") : t("settings.add")}
            </Button>
          </form>
          {addPlaceholder.error && (
            <p className="text-sm text-destructive">{addPlaceholder.error.message}</p>
          )}

          {placeholders.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-sm font-medium text-muted-foreground">
                {t("settings.placeholderMembers", { count: placeholders.length })}
              </p>
              {placeholders.map((m) => (
                <div
                  key={m.user.id}
                  className="flex items-center justify-between rounded-md border border-dashed p-2"
                >
                  {editingPlaceholder === m.user.id ? (
                    <div className="flex flex-1 items-center gap-2">
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="h-7 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renamePlaceholder.mutate({ groupId, placeholderUserId: m.user.id, name: editingName.trim() });
                          if (e.key === "Escape") setEditingPlaceholder(null);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => renamePlaceholder.mutate({ groupId, placeholderUserId: m.user.id, name: editingName.trim() })}
                        className="text-primary hover:text-primary/80"
                        disabled={renamePlaceholder.isPending}
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingPlaceholder(null)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{m.user.placeholderName ?? m.user.name}</span>
                        <Badge variant="outline" className="text-[10px]">{t("settings.pending")}</Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => { setEditingPlaceholder(m.user.id); setEditingName(m.user.placeholderName ?? m.user.name ?? ""); }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(t("settings.removeConfirm", { name: m.user.placeholderName ?? m.user.name }))) {
                              removeMember.mutate({ groupId, userId: m.user.id });
                            }
                          }}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">{t("settings.dangerZone")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {!group.data.archivedAt && (
            <div>
              <p className="mb-2 text-sm text-muted-foreground">
                {t("settings.archiveDescription")}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  if (confirm(t("settings.archiveConfirm"))) {
                    archiveGroup.mutate({ groupId });
                  }
                }}
                disabled={archiveGroup.isPending}
              >
                <Archive className="mr-2 h-4 w-4" />
                {archiveGroup.isPending ? t("settings.archiving") : t("settings.archiveGroup")}
              </Button>
            </div>
          )}
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              {t("settings.deleteDescription")}
            </p>
          <Button
            variant="destructive"
            onClick={() => {
              if (confirm(t("settings.deleteConfirm"))) {
                deleteGroup.mutate({ groupId });
              }
            }}
            disabled={deleteGroup.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleteGroup.isPending ? t("settings.deleting") : t("settings.deleteGroup")}
          </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
