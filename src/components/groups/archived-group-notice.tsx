'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Archive } from 'lucide-react';

/**
 * Shown in place of a form an archived group refuses (adding, editing or
 * scanning an expense), so a bookmarked or back-button link says so before
 * the user fills it in rather than failing on submit (#290).
 */
export function ArchivedGroupNotice({ groupId }: { groupId: string }) {
  const t = useTranslations('groups');

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <Archive className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
      <h2 className="mb-2 text-lg font-semibold">{t('settings.archived')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('detail.archivedMessage')}</p>
      <Button nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
        {t('settings.backToGroup')}
      </Button>
    </div>
  );
}
