'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

// "Forgot password?" (#397): emails a reset link when the server can send email. Without email,
// the user asks an admin for one (admin dashboard, User Management).
export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgotPassword');
  const tVerify = useTranslations('auth.verifyRequest');
  const tCommon = useTranslations('common');
  const loginOptions = trpc.auth.getLoginOptions.useQuery();
  const [email, setEmail] = useState('');
  const request = trpc.auth.requestPasswordReset.useMutation();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    request.mutate({ email: email.trim() });
  }

  // A failed background refetch keeps the options last loaded, so the form stays
  const options = loginOptions.data;
  let body: React.ReactNode;
  if (loginOptions.isPending) {
    body = <LoadingSpinner className="py-8" />;
  } else if (request.isSuccess) {
    // The same for every address, with or without an account. Ahead of the options, so a failed
    // background refetch of them doesn't take the answer off the screen
    body = (
      <div data-testid="forgot-password-sent" className="space-y-3 text-sm text-muted-foreground">
        <p>{t('sent', { email: request.variables.email })}</p>
        <p>{tVerify('spamHint')}</p>
      </div>
    );
  } else if (!options) {
    // Whether this server can send email is unknown, so don't claim either way
    body = <p className="text-sm text-destructive">{tCommon('errors.generic')}</p>;
  } else if (!options.passwordLogin) {
    body = (
      <p data-testid="forgot-password-login-off" className="text-sm text-muted-foreground">
        {t('passwordLoginOff')}
      </p>
    );
  } else if (!options.passwordReset) {
    body = (
      <p data-testid="forgot-password-ask-admin" className="text-sm text-muted-foreground">
        {t('askAdmin')}
      </p>
    );
  } else {
    body = (
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        {request.error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{request.error.message}</div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">{t('email')}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full rounded-full h-10 text-sm font-medium" disabled={request.isPending}>
          {request.isPending ? t('submitting') : t('submit')}
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
        <CardTitle className="text-2xl font-semibold tracking-tight">{t('title')}</CardTitle>
        {request.isSuccess && <CardDescription className="mt-1">{t('sentTitle')}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        {/* Always on the page, so screen readers announce the answer that replaces the form; what's
            inside carries no role of its own, which would announce it twice */}
        <div aria-live="polite">{body}</div>
        <p className="text-center">
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            {t('backToLogin')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
