'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Copy, Link } from 'lucide-react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/clipboard';

/**
 * Invite link for the group. Given a placeholder, the link is theirs to claim:
 * whoever accepts it takes over the placeholder's expenses and payments.
 */
export function InviteDialog({
  groupId,
  placeholder,
  open,
  onOpenChange,
}: {
  groupId: string;
  placeholder?: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const t = useTranslations('groups');
  const tc = useTranslations('common');

  const createInvite = trpc.groups.createInvite.useMutation({
    onError: (e) => toast.error(e.message),
  });

  function handleGenerate() {
    createInvite.mutate(placeholder ? { groupId, placeholderUserId: placeholder.id } : { groupId });
  }

  function getInviteUrl(token: string) {
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    return `${base}/invite/${token}`;
  }

  async function handleCopy() {
    if (!createInvite.data) return;
    const url = getInviteUrl(createInvite.data.token);
    if (!(await copyToClipboard(url))) {
      toast.error(tc('actions.copyFailed'));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {placeholder ? t('invite.claimTitle', { name: placeholder.name }) : t('invite.title')}
          </DialogTitle>
          <DialogDescription>
            {placeholder ? t('invite.claimDescription', { name: placeholder.name }) : t('invite.description')}
          </DialogDescription>
        </DialogHeader>

        {!createInvite.data ? (
          <Button onClick={handleGenerate} disabled={createInvite.isPending}>
            <Link className="mr-2 h-4 w-4" />
            {createInvite.isPending ? t('invite.generating') : t('invite.generateLink')}
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input readOnly value={getInviteUrl(createInvite.data.token)} className="font-mono text-xs" />
              <Button variant="outline" size="icon" aria-label={t('invite.copyLink')} onClick={handleCopy}>
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {placeholder ? t('invite.claimLinkInfo', { name: placeholder.name }) : t('invite.linkInfo')}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
