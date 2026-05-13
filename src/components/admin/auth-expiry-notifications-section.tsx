"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bell, Loader2 } from "lucide-react";

export function AuthExpiryNotificationsSection() {
  const t = useTranslations("admin");
  const utils = trpc.useUtils();

  const meridianStatus = trpc.admin.getMeridianAuthStatus.useQuery();
  const openAICodexStatus = trpc.admin.getOpenAICodexAuthStatus.useQuery();
  const notifyPref = trpc.admin.getMeridianNotifyPreference.useQuery();

  const setNotifyPref = trpc.admin.setMeridianNotifyPreference.useMutation({
    onSuccess: () => {
      utils.admin.getMeridianNotifyPreference.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const meridianEnabled = !!meridianStatus.data && meridianStatus.data.status !== "not_applicable";
  const openAICodexEnabled =
    !!openAICodexStatus.data && openAICodexStatus.data.status !== "not_applicable";

  if (!meridianEnabled && !openAICodexEnabled) {
    return null;
  }

  const providerLabels = [
    meridianEnabled ? t("authExpiry.claudeOAuth") : null,
    openAICodexEnabled ? t("authExpiry.chatgptOAuth") : null,
  ].filter(Boolean) as string[];

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Bell className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("authExpiry.title")}</h2>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Bell className="h-4 w-4" />
            {t("authExpiry.cardTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("authExpiry.description", { providers: providerLabels.join(` ${t("authExpiry.or")} `) })}
          </p>
          <Select
            value={notifyPref.data?.interval ?? "once"}
            onValueChange={(value) => {
              setNotifyPref.mutate({
                interval: value as "once" | "1h" | "6h" | "24h",
              });
            }}
            disabled={setNotifyPref.isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">{t("authExpiry.oncePerIncident")}</SelectItem>
              <SelectItem value="1h">{t("authExpiry.everyHour")}</SelectItem>
              <SelectItem value="6h">{t("authExpiry.every6Hours")}</SelectItem>
              <SelectItem value="24h">{t("authExpiry.every24Hours")}</SelectItem>
            </SelectContent>
          </Select>
          {setNotifyPref.isPending && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("authExpiry.saving")}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
