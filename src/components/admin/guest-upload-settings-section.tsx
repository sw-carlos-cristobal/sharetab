'use client';

import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScanLine } from 'lucide-react';

export function GuestUploadSettingsSection() {
  const t = useTranslations('admin');
  const utils = trpc.useUtils();
  const guestUploads = trpc.admin.getGuestUploadsEnabled.useQuery();
  const setGuestUploads = trpc.admin.setGuestUploadsEnabled.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.admin.getGuestUploadsEnabled.invalidate(), utils.guest.getUploadStatus.invalidate()]);
    },
  });

  const enabled = guestUploads.data?.enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScanLine className="h-4 w-4" />
          {t('guestUploads.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('guestUploads.description')}</p>
        <div className="flex items-center gap-3">
          <Button
            variant={enabled ? 'default' : 'outline'}
            size="sm"
            onClick={() => setGuestUploads.mutate({ enabled: !enabled })}
            disabled={setGuestUploads.isPending || guestUploads.isLoading || enabled === undefined}
            data-testid="guest-uploads-toggle-btn"
          >
            {enabled ? t('guestUploads.enabled') : t('guestUploads.disabled')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {enabled ? t('guestUploads.enabledStatus') : t('guestUploads.disabledStatus')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
