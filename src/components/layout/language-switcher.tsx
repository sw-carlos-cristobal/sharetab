"use client";

import { Suspense } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { locales, languageConfig } from "@/i18n/routing";
import type { Locale } from "@/i18n/routing";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { useSession } from "next-auth/react";

function setLocaleCookie(locale: string) {
  const secure = window.location.protocol === "https:" ? ";secure" : "";
  document.cookie = `NEXT_LOCALE=${encodeURIComponent(locale)};path=/;max-age=31536000;samesite=lax${secure}`;
}

export function LanguageSwitcher() {
  return (
    <Suspense>
      <LanguageSwitcherInner />
    </Suspense>
  );
}

function LanguageSwitcherInner() {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const t = useTranslations("common");

  const updateLocale = trpc.auth.updateProfile.useMutation();

  function handleLocaleChange(newLocale: Locale) {
    setLocaleCookie(newLocale);

    if (session?.user) {
      updateLocale.mutate({ locale: newLocale });
    }

    const qs = searchParams.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    router.replace(href, { locale: newLocale });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("nav.changeLanguage")}
            data-testid="language-switcher"
          />
        }
      >
        <Globe className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {locales.map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => handleLocaleChange(l)}
            className={l === locale ? "bg-accent" : ""}
          >
            <span className="mr-2">{languageConfig[l].flag}</span>
            {languageConfig[l].name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
