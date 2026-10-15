'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

/**
 * Merge a placeholder into a member who has joined with an account: their
 * expenses, shares and payments move to that member and the placeholder goes.
 */
export function MergePlaceholderDialog({
  groupId,
  placeholder,
  members,
  open,
  onOpenChange,
}: {
  groupId: string;
  placeholder: { id: string; name: string };
  members: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const utils = trpc.useUtils();
  const [targetId, setTargetId] = useState('');
  const target = members.find((m) => m.id === targetId);

  const merge = trpc.groups.mergePlaceholder.useMutation({
    onSuccess: () => {
      toast.success(t('merge.done', { name: placeholder.name, member: target?.name ?? '' }));
      onOpenChange(false);
      void utils.groups.get.invalidate({ groupId });
      void utils.balances.invalidate();
      void utils.expenses.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('merge.title', { name: placeholder.name })}</DialogTitle>
          <DialogDescription>{t('merge.description', { name: placeholder.name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="merge-target">{t('merge.target')}</Label>
          <select
            id="merge-target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="" disabled>
              {t('merge.choose')}
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {target && (
            <p className="text-sm text-muted-foreground">
              {t('merge.confirm', { name: placeholder.name, member: target.name })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('actions.cancel')}
          </Button>
          <Button
            onClick={() => merge.mutate({ groupId, placeholderUserId: placeholder.id, realUserId: targetId })}
            disabled={!target || merge.isPending}
          >
            {merge.isPending ? t('merge.merging') : t('merge.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
