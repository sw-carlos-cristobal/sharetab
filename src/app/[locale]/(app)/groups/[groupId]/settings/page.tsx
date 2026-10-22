'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { COMMON_CURRENCIES } from '@/lib/currencies';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Crown,
  Pencil,
  Trash2,
  UserPlus,
  Check,
  X,
  Link2,
  LogOut,
  Merge,
} from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { InviteDialog } from '@/components/groups/invite-dialog';
import { MergePlaceholderDialog } from '@/components/groups/merge-placeholder-dialog';
import { TransferOwnershipDialog } from '@/components/groups/transfer-ownership-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';

// Details form is a separate component so its state is initialized exactly
// once from the loaded group data. The page invalidates `groups.get` whenever
// members change; syncing state on every refetch would clobber unsaved edits.
function GroupDetailsForm({
  groupId,
  initialName,
  initialDescription,
  initialCurrency,
  readOnly,
}: {
  groupId: string;
  initialName: string;
  initialDescription: string;
  initialCurrency: string;
  /** Only owners and admins can change the details (#279) */
  readOnly: boolean;
}) {
  const t = useTranslations('groups');
  const utils = trpc.useUtils();

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [currency, setCurrency] = useState(initialCurrency);

  const updateGroup = trpc.groups.update.useMutation({
    onSuccess: () => {
      utils.groups.get.invalidate({ groupId });
      utils.groups.list.invalidate();
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    updateGroup.mutate({
      groupId,
      name: name.trim(),
      description: description || undefined,
      currency: currency || undefined,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.details')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('settings.name')}</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required disabled={readOnly} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">{t('settings.description')}</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="currency">{t('settings.currency')}</Label>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={readOnly}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {COMMON_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
            {updateGroup.error && <p className="text-xs text-destructive">{updateGroup.error.message}</p>}
          </div>
          {!readOnly && (
            <Button type="submit" disabled={updateGroup.isPending}>
              {updateGroup.isPending ? t('settings.saving') : t('settings.saveChanges')}
            </Button>
          )}
          {updateGroup.isSuccess && <p className="text-sm text-green-600">{t('settings.saved')}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

export default function GroupSettingsPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();
  const t = useTranslations('groups');
  const locale = useLocale();
  const group = trpc.groups.get.useQuery({ groupId });
  const utils = trpc.useUtils();
  // Who tRPC acts as: the impersonated user while an admin impersonates, where
  // useSession() would still report the admin.
  const profile = trpc.auth.getProfile.useQuery();

  const [placeholderName, setPlaceholderName] = useState('');
  const [editingPlaceholder, setEditingPlaceholder] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // The placeholder whose claim link or merge dialog is open
  const [claimFor, setClaimFor] = useState<{ id: string; name: string } | null>(null);
  const [mergeFor, setMergeFor] = useState<{ id: string; name: string } | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [removeFor, setRemoveFor] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<'archive' | 'delete' | 'leave' | null>(null);

  const deleteGroup = trpc.groups.delete.useMutation({
    onSuccess: () => {
      router.push('/groups');
    },
    onError: (e) => toast.error(e.message),
  });

  const archiveGroup = trpc.groups.archive.useMutation({
    onSuccess: () => {
      utils.groups.list.invalidate();
      utils.groups.listArchived.invalidate();
      router.push('/groups');
    },
    onError: (e) => toast.error(e.message),
  });

  const unarchiveGroup = trpc.groups.unarchive.useMutation({
    onSuccess: () => {
      utils.groups.get.invalidate({ groupId });
      utils.groups.list.invalidate();
      utils.groups.listArchived.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const addPlaceholder = trpc.groups.addPlaceholder.useMutation({
    onSuccess: ({ name, restored }) => {
      setPlaceholderName('');
      utils.groups.get.invalidate({ groupId });
      // Their name brought back someone removed earlier, with their history (#284)
      if (restored) toast.success(t('settings.placeholderRestored', { name: name ?? '' }));
    },
  });

  const renamePlaceholder = trpc.groups.renamePlaceholder.useMutation({
    onSuccess: () => {
      setEditingPlaceholder(null);
      utils.groups.get.invalidate({ groupId });
    },
    onError: (e, { name }) => toast.error(placeholderError(e, name)),
  });

  const removeMember = trpc.groups.removeMember.useMutation({
    onSuccess: () => utils.groups.get.invalidate({ groupId }),
    onError: (e) => toast.error(e.message),
  });

  const leaveGroup = trpc.groups.removeMember.useMutation({
    onSuccess: () => {
      utils.groups.list.invalidate();
      utils.groups.listArchived.invalidate();
      router.push('/groups');
    },
    onError: (e) => toast.error(e.message),
  });

  // The server refuses a placeholder name someone in the group already has (#265)
  function placeholderError(e: { message: string; data?: { code?: string } | null | undefined }, name: string) {
    return e.data?.code === 'CONFLICT' ? t('settings.placeholderNameTaken', { name }) : e.message;
  }

  function handleAddPlaceholder(e: React.FormEvent) {
    e.preventDefault();
    if (!placeholderName.trim()) return;
    addPlaceholder.mutate({ groupId, name: placeholderName.trim() });
  }

  // The controls below depend on the caller's role, so wait for it rather than flash the wrong ones
  if (group.isLoading || profile.isLoading) return <LoadingSpinner />;
  if (!group.data) return <p className="text-destructive">{t('settings.notFound')}</p>;

  const placeholders = group.data.members
    .filter((m) => m.user.isPlaceholder)
    .map((m) => ({ ...m, displayName: m.user.placeholderName ?? m.user.name ?? '' }));
  // The server refuses a plain member's changes to the group (details, placeholders,
  // archiving) and deleting it to everyone but the owner, so they're only offered to
  // those it allows (#279). Claim links and merges are for owners and admins, and an
  // archived group refuses merges.
  const myId = profile.data?.id;
  const myRole = group.data.members.find((m) => m.user.id === myId)?.role;
  const isOwnerOrAdmin = myRole === 'OWNER' || myRole === 'ADMIN';
  const canMerge = isOwnerOrAdmin && !group.data.archivedAt;
  // Who a placeholder can be merged into: the members who joined with an account
  const accountMembers = group.data.members
    .filter((m) => !m.user.isPlaceholder)
    .map((m) => ({ id: m.user.id, name: m.user.name ?? m.user.email ?? '' }));
  // Who the owner can hand the group to (#309)
  const newOwnerCandidates = accountMembers.filter((m) => m.id !== myId);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('settings.backToGroup')}
          nativeButton={false}
          render={<Link href={`/groups/${groupId}`} />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
      </div>

      {group.data.archivedAt && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
          <Archive className="h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">{t('settings.archived')}</p>
            <p className="text-amber-700 dark:text-amber-300">
              {t('settings.archivedOn', { date: new Date(group.data.archivedAt).toLocaleDateString(locale) })}
            </p>
            {/* Only owners and admins can unarchive */}
            {myRole === 'MEMBER' && <p className="text-amber-700 dark:text-amber-300">{t('detail.askToUnarchive')}</p>}
          </div>
          {(myRole === 'OWNER' || myRole === 'ADMIN') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => unarchiveGroup.mutate({ groupId })}
              disabled={unarchiveGroup.isPending}
            >
              <ArchiveRestore className="mr-2 h-4 w-4" />
              {t('settings.unarchive')}
            </Button>
          )}
        </div>
      )}

      <GroupDetailsForm
        groupId={groupId}
        initialName={group.data.name}
        initialDescription={group.data.description ?? ''}
        initialCurrency={group.data.currency}
        readOnly={!isOwnerOrAdmin}
      />

      {isOwnerOrAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              {t('settings.addMemberTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.addMemberDescription')}</p>
            <form onSubmit={handleAddPlaceholder} className="flex gap-2">
              <Input
                placeholder={t('settings.namePlaceholder')}
                value={placeholderName}
                onChange={(e) => setPlaceholderName(e.target.value)}
                required
              />
              <Button type="submit" disabled={addPlaceholder.isPending}>
                {addPlaceholder.isPending ? t('settings.adding') : t('settings.add')}
              </Button>
            </form>
            {addPlaceholder.error && (
              <p className="text-sm text-destructive" data-testid="placeholder-error">
                {placeholderError(addPlaceholder.error, addPlaceholder.variables?.name ?? '')}
              </p>
            )}

            {placeholders.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {t('settings.placeholderMembers', { count: placeholders.length })}
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
                            if (e.key === 'Enter')
                              renamePlaceholder.mutate({
                                groupId,
                                placeholderUserId: m.user.id,
                                name: editingName.trim(),
                              });
                            if (e.key === 'Escape') setEditingPlaceholder(null);
                          }}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            renamePlaceholder.mutate({
                              groupId,
                              placeholderUserId: m.user.id,
                              name: editingName.trim(),
                            })
                          }
                          className="text-primary hover:text-primary/80"
                          disabled={renamePlaceholder.isPending}
                          aria-label={t('settings.saveName')}
                          title={t('settings.saveName')}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingPlaceholder(null)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={t('settings.cancelRename')}
                          title={t('settings.cancelRename')}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{m.user.placeholderName ?? m.user.name}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {t('settings.pending')}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1">
                          {canMerge && (
                            <>
                              <button
                                type="button"
                                aria-label={t('settings.inviteToClaim', { name: m.displayName })}
                                title={t('settings.inviteToClaim', { name: m.displayName })}
                                onClick={() => setClaimFor({ id: m.user.id, name: m.displayName })}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Link2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={t('settings.mergeIntoMember', { name: m.displayName })}
                                title={t('settings.mergeIntoMember', { name: m.displayName })}
                                onClick={() => setMergeFor({ id: m.user.id, name: m.displayName })}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Merge className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            aria-label={t('settings.renamePlaceholder', { name: m.displayName })}
                            title={t('settings.renamePlaceholder', { name: m.displayName })}
                            onClick={() => {
                              setEditingPlaceholder(m.user.id);
                              setEditingName(m.displayName);
                            }}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={t('settings.removePlaceholder', { name: m.displayName })}
                            title={t('settings.removePlaceholder', { name: m.displayName })}
                            onClick={() => setRemoveFor({ id: m.user.id, name: m.displayName })}
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
      )}

      {claimFor && (
        <InviteDialog
          key={claimFor.id}
          groupId={groupId}
          placeholder={claimFor}
          open
          onOpenChange={(open) => !open && setClaimFor(null)}
        />
      )}
      {mergeFor && (
        <MergePlaceholderDialog
          key={mergeFor.id}
          groupId={groupId}
          placeholder={mergeFor}
          members={accountMembers}
          open
          onOpenChange={(open) => !open && setMergeFor(null)}
        />
      )}
      {transferOpen && (
        <TransferOwnershipDialog groupId={groupId} members={newOwnerCandidates} open onOpenChange={setTransferOpen} />
      )}
      <ConfirmDialog
        open={removeFor !== null}
        onOpenChange={(open) => !open && setRemoveFor(null)}
        title={t('settings.removeTitle', { name: removeFor?.name ?? '' })}
        description={t('settings.removeDescription', { name: removeFor?.name ?? '' })}
        confirmLabel={t('settings.remove')}
        onConfirm={() => removeFor && removeMember.mutate({ groupId, userId: removeFor.id })}
      />
      <ConfirmDialog
        open={confirming === 'archive'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('settings.archiveTitle')}
        description={t('settings.archiveConfirmDescription')}
        confirmLabel={t('settings.archiveGroup')}
        destructive={false}
        onConfirm={() => archiveGroup.mutate({ groupId })}
      />
      <ConfirmDialog
        open={confirming === 'delete'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('settings.deleteTitle')}
        description={t('settings.deleteConfirmDescription')}
        confirmLabel={t('settings.deleteGroup')}
        onConfirm={() => deleteGroup.mutate({ groupId })}
      />
      <ConfirmDialog
        open={confirming === 'leave'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t('settings.leaveTitle')}
        description={t('settings.leaveConfirmDescription')}
        confirmLabel={t('settings.leaveGroup')}
        onConfirm={() => myId && leaveGroup.mutate({ groupId, userId: myId })}
      />

      <Separator />

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">{t('settings.dangerZone')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isOwnerOrAdmin && !group.data.archivedAt && (
            <div>
              <p className="mb-2 text-sm text-muted-foreground">{t('settings.archiveDescription')}</p>
              <Button variant="outline" onClick={() => setConfirming('archive')} disabled={archiveGroup.isPending}>
                <Archive className="mr-2 h-4 w-4" />
                {archiveGroup.isPending ? t('settings.archiving') : t('settings.archiveGroup')}
              </Button>
            </div>
          )}
          {myRole === 'OWNER' && (
            // The owner can't leave until they hand the group to someone else
            <div>
              <p className="mb-2 text-sm text-muted-foreground">
                {newOwnerCandidates.length > 0 ? t('settings.transferDescription') : t('settings.transferNoCandidates')}
              </p>
              <Button
                variant="outline"
                onClick={() => setTransferOpen(true)}
                disabled={newOwnerCandidates.length === 0}
              >
                <Crown className="mr-2 h-4 w-4" />
                {t('settings.transferOwnership')}
              </Button>
            </div>
          )}
          {myRole === 'OWNER' ? (
            <div>
              <p className="mb-2 text-sm text-muted-foreground">{t('settings.deleteDescription')}</p>
              <Button variant="destructive" onClick={() => setConfirming('delete')} disabled={deleteGroup.isPending}>
                <Trash2 className="mr-2 h-4 w-4" />
                {deleteGroup.isPending ? t('settings.deleting') : t('settings.deleteGroup')}
              </Button>
            </div>
          ) : (
            // The owner can't leave (nobody else could manage or delete the group);
            // they transfer ownership first
            myId && (
              <div>
                <p className="mb-2 text-sm text-muted-foreground">{t('settings.leaveDescription')}</p>
                <Button variant="destructive" onClick={() => setConfirming('leave')} disabled={leaveGroup.isPending}>
                  <LogOut className="mr-2 h-4 w-4" />
                  {leaveGroup.isPending ? t('settings.leaving') : t('settings.leaveGroup')}
                </Button>
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
