'use client';

import { use, useEffect, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { useLocale } from 'next-intl';
import { useSession } from 'next-auth/react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';

// The group, inviter and placeholder names come from other users; <bdi> keeps right-to-left or direction-override
// characters in them from reordering the rest of the sentence.
const isolate = (chunks: ReactNode) => <bdi>{chunks}</bdi>;
const bold = (chunks: ReactNode) => <bdi className="font-medium text-foreground">{chunks}</bdi>;

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('auth.invite');
  const { data: session, status } = useSession();

  // No retries, so a failed lookup falls back straight away. Details that loaded aren't refetched
  // on focus, so the page doesn't turn to "invalid" because this person's own join used the
  // invite; they're dropped when the page closes, so coming back loads them fresh.
  const invite = trpc.groups.getInvite.useQuery(
    { token },
    { enabled: !!session, retry: false, staleTime: Infinity, gcTime: 0 },
  );
  // null means joinByInvite would refuse the token, and BAD_REQUEST means it's too long to be one.
  // Any other failed lookup falls back to the generic description and the Accept button, and
  // leaves joinByInvite to report any problem.
  const invalid = invite.data === null || invite.error?.data?.code === 'BAD_REQUEST';

  const joinGroup = trpc.groups.joinByInvite.useMutation({
    onSuccess: (data) => {
      router.push(`/groups/${data.groupId}`);
    },
    // Someone may have used the invite, or it may have expired, since the page loaded.
    onError: () => void invite.refetch(),
  });

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push(`/login?callbackUrl=${encodeURIComponent(`/${locale}/invite/${token}`)}`);
    }
  }, [status, router, token, locale]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }

  if (!session) return null;

  let summary: ReactNode;
  if (invite.data) {
    const details = { group: invite.data.groupName, count: invite.data.memberCount, b: bold };
    summary = invite.data.inviterName
      ? t.rich('invitedBy', { ...details, inviter: invite.data.inviterName, name: isolate })
      : t.rich('invited', details);
  } else {
    summary = invite.isPending ? t('loading') : t('description');
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <UserPlus className="mx-auto mb-2 h-8 w-8 text-primary" />
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          {invalid ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{t('invalid')}</div>
          ) : (
            <p className="text-sm break-words text-muted-foreground">{summary}</p>
          )}

          {!invalid && invite.data?.placeholderName && (
            <p className="rounded-md bg-muted p-3 text-sm break-words">
              {t.rich('claims', { name: invite.data.placeholderName, b: bold })}
            </p>
          )}

          {joinGroup.error && !invalid && !invite.isFetching && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{joinGroup.error.message}</div>
          )}

          {!invalid && (
            <Button
              className="w-full"
              onClick={() => joinGroup.mutate({ token })}
              disabled={invite.isFetching || joinGroup.isPending}
            >
              {joinGroup.isPending ? t('joining') : t('accept')}
            </Button>
          )}

          <Button variant="ghost" className="w-full" nativeButton={false} render={<Link href="/dashboard" />}>
            {t('dashboard')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
