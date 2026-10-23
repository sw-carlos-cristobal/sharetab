'use client';

import { Suspense, useEffect, useState } from 'react';
import { signIn, signOut } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { Separator } from '@/components/ui/separator';
import { KeyRound, Receipt, Mail } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { normalizeCallbackPath, stripLocalePrefix } from '@/lib/locale-paths';
import { getSignInErrorKey } from '@/lib/sign-in-errors';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function OrDivider({ label }: { label: string }) {
  return (
    <div className="relative my-8">
      <Separator />
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
    </div>
  );
}

/** Google's "G" mark, which its sign-in branding asks buttons to show. */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function LoginForm() {
  const t = useTranslations('auth.login');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [magicLinkEmail, setMagicLinkEmail] = useState('');
  const [magicLinkSending, setMagicLinkSending] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const loginOptions = trpc.auth.getLoginOptions.useQuery();
  // Quick Split needs uploads; hide its link only once we know guests are refused.
  const guestUploadStatus = trpc.guest.getUploadStatus.useQuery();
  // Back from the provider's page (e.g. Google's account chooser) can restore
  // this page from the back/forward cache with the buttons still disabled.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);
  const callbackPath = normalizeCallbackPath(searchParams.get('callbackUrl'), locale);
  const callbackHref = stripLocalePrefix(callbackPath);
  const registerHref = `/register?callbackUrl=${encodeURIComponent(callbackPath)}`;

  // Password login stays the default if the options can't be loaded, so the
  // page never renders empty.
  const passwordLogin = loginOptions.data?.passwordLogin ?? true;
  // Without email settings there is no magic-link provider to send to.
  const magicLinkEnabled = loginOptions.data?.magicLink ?? false;
  const magicLinkOnly = !passwordLogin && magicLinkEnabled;
  const oidc = loginOptions.data?.oidc ?? null;
  const google = loginOptions.data?.google ?? false;

  // Errors from Auth.js redirects (`/login?error=...`) show until the user
  // triggers a new attempt, which sets its own error state.
  const urlErrorKey = getSignInErrorKey(searchParams.get('error'));
  const shownError = error || (urlErrorKey ? t(`errors.${urlErrorKey}`) : '');
  // The refusal says to sign out first, and this page has no other way to.
  const showSignOut = !error && urlErrorKey === 'sessionActive';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSignOutFailed(false);
    setLoading(true);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
      callbackUrl: callbackPath,
    });

    setLoading(false);

    if (result?.error) {
      setError(t('error'));
    } else {
      router.push(callbackHref);
      router.refresh();
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSignOutFailed(false);
    setMagicLinkSending(true);

    const result = await signIn('nodemailer', {
      email: magicLinkEmail,
      redirect: false,
      callbackUrl: callbackPath,
    });

    setMagicLinkSending(false);

    if (result?.error) {
      setError(t('magicLinkError'));
    } else {
      router.push('/verify-request');
    }
  }

  async function handleProviderSignIn(provider: 'oidc' | 'google') {
    setError('');
    setSignOutFailed(false);
    setRedirecting(true);
    try {
      // Full-page redirect to the identity provider; failures normally come
      // back as `/login?error=...`.
      await signIn(provider, { redirectTo: callbackPath });
    } catch {
      setRedirecting(false);
      setError(t('errors.generic'));
    }
  }

  const magicLinkForm = (
    <form onSubmit={handleMagicLink} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('magicLinkDescription')}</p>
      <div className="space-y-2">
        <Label htmlFor="magic-email">{t('magicLinkEmail')}</Label>
        <Input
          id="magic-email"
          type="email"
          placeholder={t('emailPlaceholder')}
          value={magicLinkEmail}
          onChange={(e) => setMagicLinkEmail(e.target.value)}
          required
        />
      </div>
      <Button type="submit" className="w-full rounded-full h-10 text-sm font-medium mt-2" disabled={magicLinkSending}>
        <Mail className="mr-2 h-4 w-4" />
        {magicLinkSending ? t('magicLinkSending') : t('magicLinkSubmit')}
      </Button>
    </form>
  );

  return (
    <Card className="border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Receipt className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">{t('title')}</CardTitle>
        <CardDescription className="mt-1">{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {loginOptions.isPending ? (
          <LoadingSpinner className="py-8" />
        ) : (
          <>
            {shownError && (
              <div
                role="alert"
                data-testid="login-error"
                className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              >
                {shownError}
                {showSignOut && (
                  <Button
                    data-testid="login-sign-out"
                    variant="link"
                    className="ml-1 h-auto p-0 text-sm text-destructive underline"
                    onClick={() => {
                      setSignOutFailed(false);
                      // Keeps the button, so a failed sign-out can be tried again.
                      signOut({ callbackUrl: `/${locale}/login` }).catch(() => setSignOutFailed(true));
                    }}
                  >
                    {tCommon('nav.signOut')}
                  </Button>
                )}
                {showSignOut && signOutFailed && (
                  <span data-testid="login-sign-out-failed" className="block">
                    {tCommon('errors.generic')}
                  </span>
                )}
              </div>
            )}

            {(oidc || google) && (
              <>
                <div className="space-y-3">
                  {oidc && (
                    <Button
                      data-testid="oidc-sign-in"
                      // Next to Google it's outlined too: Google's branding
                      // rules want its button at least as prominent as other
                      // third-party sign-in buttons.
                      variant={passwordLogin || magicLinkOnly || google ? 'outline' : 'default'}
                      className="w-full rounded-full h-10 text-sm font-medium"
                      onClick={() => handleProviderSignIn('oidc')}
                      disabled={redirecting}
                    >
                      <KeyRound className="mr-2 h-4 w-4" />
                      {t('sso', { provider: oidc.name })}
                    </Button>
                  )}
                  {google && (
                    <Button
                      data-testid="google-sign-in"
                      // Always outlined: the primary color belongs to the
                      // password or magic-link form, when there is one.
                      variant="outline"
                      className="w-full rounded-full h-10 text-sm font-medium"
                      onClick={() => handleProviderSignIn('google')}
                      disabled={redirecting}
                    >
                      {/* Google's branding puts its colored mark on white, in dark mode too. */}
                      <span className="mr-2 flex h-5 w-5 items-center justify-center rounded-full bg-white">
                        <GoogleIcon className="size-3.5" />
                      </span>
                      {t('sso', { provider: 'Google' })}
                    </Button>
                  )}
                </div>
                {(passwordLogin || magicLinkOnly) && <OrDivider label={t('or')} />}
              </>
            )}

            {passwordLogin &&
              (!showMagicLink ? (
                <>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">{t('email')}</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder={t('emailPlaceholder')}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password">{t('password')}</Label>
                        {magicLinkEnabled && (
                          <button
                            type="button"
                            onClick={() => setShowMagicLink(true)}
                            className="text-xs text-primary hover:text-primary/80 transition-colors"
                          >
                            {t('forgotPassword')}
                          </button>
                        )}
                      </div>
                      <Input
                        id="password"
                        type="password"
                        placeholder={t('passwordPlaceholder')}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={8}
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full rounded-full h-10 text-sm font-medium mt-2"
                      disabled={loading}
                    >
                      {loading ? t('submitting') : t('submit')}
                    </Button>
                  </form>

                  {magicLinkEnabled && (
                    <>
                      <OrDivider label={t('or')} />

                      <Button
                        variant="outline"
                        className="w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40"
                        onClick={() => setShowMagicLink(true)}
                      >
                        <Mail className="mr-2 h-4 w-4" />
                        {t('magicLink')}
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <>
                  {magicLinkForm}

                  <OrDivider label={t('or')} />

                  <Button
                    variant="outline"
                    className="w-full rounded-full h-10 text-sm border-primary/20 text-muted-foreground hover:text-foreground hover:border-primary/40"
                    onClick={() => setShowMagicLink(false)}
                  >
                    {t('passwordLink')}
                  </Button>
                </>
              ))}

            {magicLinkOnly && magicLinkForm}
          </>
        )}

        <div className="relative my-8">
          <Separator />
        </div>

        <div className="text-center space-y-3">
          {passwordLogin && (
            <p className="text-sm text-muted-foreground">
              {t('noAccount')}{' '}
              <Link href={registerHref} className="font-medium text-primary hover:underline">
                {t('createAccount')}
              </Link>
            </p>
          )}
          {guestUploadStatus.data?.allowed !== false && (
            <p className="text-xs text-muted-foreground/80">
              {t('quickSplit')}{' '}
              <Link href="/split" className="font-medium text-primary hover:underline">
                {t('quickSplitLink')}
              </Link>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
