'use client';

import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { readResetToken } from '@/lib/password-reset-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

// The reset link's token is in the #fragment (src/lib/password-reset-link.ts), which only the
// browser sees: null while rendering on the server.
function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

// A password reset link (#397), emailed by "Forgot password?" or made by an admin
export default function ResetPasswordPage() {
  const t = useTranslations('auth.resetPassword');
  const hash = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => null,
  );
  const token = hash === null ? null : readResetToken(hash);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = trpc.auth.resetPassword.useMutation();
  const mismatch = confirm !== '' && password !== confirm;
  // An outcome belongs to the link it was sent with: another link pasted into this tab only
  // changes the hash, and starts clean
  const sentWithThisLink = reset.variables?.token === token;
  const done = reset.isSuccess && sentWithThisLink;
  const errorForThisLink = sentWithThisLink ? reset.error : null;
  const linkRefused = errorForThisLink?.data?.messageKey === 'resetLinkInvalid';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || password !== confirm) return;
    reset.mutate({ token, password });
  }

  let body: React.ReactNode;
  if (done) {
    body = (
      <div role="status" data-testid="reset-password-done" className="space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{t('success')}</p>
        <Button render={<Link href="/login" />} nativeButton={false} className="rounded-full">
          {t('signIn')}
        </Button>
      </div>
    );
  } else if (hash === null) {
    body = <LoadingSpinner className="py-8" />;
  } else if (!token || linkRefused) {
    body = (
      <div role="alert" data-testid="reset-password-invalid" className="space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{t('invalidLink')}</p>
        <Link href="/forgot-password" className="text-sm font-medium text-primary hover:underline">
          {t('requestNew')}
        </Link>
      </div>
    );
  } else {
    body = (
      <form onSubmit={handleSubmit} className="space-y-4">
        {errorForThisLink && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {errorForThisLink.message}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="newPassword">{t('new')}</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            placeholder={t('placeholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            maxLength={100}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{t('confirm')}</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            maxLength={100}
            aria-invalid={mismatch}
          />
          {mismatch && <p className="text-sm text-destructive">{t('mismatch')}</p>}
        </div>
        <Button
          type="submit"
          className="w-full rounded-full h-10 text-sm font-medium"
          disabled={reset.isPending || mismatch}
        >
          {reset.isPending ? t('submitting') : t('submit')}
        </Button>
      </form>
    );
  }

  return (
    <Card className="border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <KeyRound className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">{done ? t('successTitle') : t('title')}</CardTitle>
        {!done && token && !linkRefused && <CardDescription className="mt-1">{t('description')}</CardDescription>}
      </CardHeader>
      <CardContent className="pt-4">{body}</CardContent>
    </Card>
  );
}
