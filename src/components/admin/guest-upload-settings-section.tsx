'use client';

import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ScanLine } from 'lucide-react';

export function GuestUploadSettingsSection() {
  const t = useTranslations('admin');
  const utils = trpc.useUtils();
  const guestUploads = trpc.admin.getGuestUploadsEnabled.useQuery();
  const setGuestUploads = trpc.admin.setGuestUploadsEnabled.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.admin.getGuestUploadsEnabled.invalidate(), utils.guest.getUploadStatus.invalidate()]);
    },
  });

  const data = guestUploads.data;
  // DISABLE_GUEST_UPLOADS wins over the saved toggle, so show the effective state.
  const enabled = data ? data.enabled && !data.forcedOffByEnv : false;

  let status = '';
  if (data?.forcedOffByEnv) status = t('guestUploads.forcedOffStatus');
  else if (data) status = enabled ? t('guestUploads.enabledStatus') : t('guestUploads.disabledStatus');

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
        {data ? (
          <div className="flex items-center gap-3">
            <Button
              variant={enabled ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGuestUploads.mutate({ enabled: !data.enabled })}
              disabled={setGuestUploads.isPending || data.forcedOffByEnv}
              data-testid="guest-uploads-toggle-btn"
            >
              {enabled ? t('guestUploads.enabled') : t('guestUploads.disabled')}
            </Button>
            <span className="text-xs text-muted-foreground">{status}</span>
          </div>
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </CardContent>
    </Card>
  );
}
