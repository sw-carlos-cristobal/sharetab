"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { TRPCClientError } from "@trpc/client";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Receipt } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { normalizeCallbackPath, stripLocalePrefix } from "@/lib/locale-paths";

type RegistrationErrorKey =
  | "emailTaken"
  | "inviteRequired"
  | "inviteInvalid"
  | "closed"
  | "generic";

function getRegistrationErrorKey(error: unknown): RegistrationErrorKey {
  if (!(error instanceof TRPCClientError)) {
    return "generic";
  }

  if (error.data?.code === "CONFLICT") {
    return "emailTaken";
  }

  if (error.data?.code !== "FORBIDDEN") {
    return "generic";
  }

  switch (error.message) {
    case "An invite code is required to register.":
      return "inviteRequired";
    case "Invalid or expired invite code.":
      return "inviteInvalid";
    case "Registration is currently closed.":
      return "closed";
    default:
      return "generic";
  }
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const t = useTranslations("auth.register");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const regMode = trpc.auth.getRegistrationMode.useQuery();
  const registerMutation = trpc.auth.register.useMutation();

  const mode = regMode.data?.mode ?? "open";
  const callbackPath = normalizeCallbackPath(searchParams.get("callbackUrl"), locale);
  const callbackHref = stripLocalePrefix(callbackPath);
  const loginHref = `/login?callbackUrl=${encodeURIComponent(callbackPath)}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await registerMutation.mutateAsync({
        name,
        email,
        password,
        ...(mode === "invite-only" && inviteCode
          ? { inviteCode }
          : {}),
      });

      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl: callbackPath,
      });

      if (result?.error) {
        setError(t("error.generic"));
      } else {
        router.push(callbackHref);
        router.refresh();
      }
    } catch (err: unknown) {
      setError(t(`error.${getRegistrationErrorKey(err)}`));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Receipt className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">{t("title")}</CardTitle>
        <CardDescription className="mt-1">{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="name">{t("name")}</Label>
            <Input
              id="name"
              type="text"
              placeholder={t("namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input
              id="email"
              type="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input
              id="password"
              type="password"
              placeholder={t("passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          {mode === "invite-only" && (
            <div className="space-y-2">
              <Label htmlFor="inviteCode">{t("inviteCode")}</Label>
              <Input
                id="inviteCode"
                type="text"
                placeholder={t("inviteCodePlaceholder")}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                {t("error.inviteRequired")}
              </p>
            </div>
          )}
          {mode === "closed" ? (
            <div className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              {t("error.closed")}
            </div>
          ) : (
            <Button type="submit" className="w-full rounded-full h-10 text-sm font-medium mt-2" disabled={loading}>
              {loading ? t("submitting") : t("submit")}
            </Button>
          )}
        </form>

        <div className="relative my-8">
          <Separator />
        </div>

        <p className="text-center text-sm text-muted-foreground">
          {t("hasAccount")}{" "}
          <Link href={loginHref} className="font-medium text-primary hover:underline">
            {t("signIn")}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
