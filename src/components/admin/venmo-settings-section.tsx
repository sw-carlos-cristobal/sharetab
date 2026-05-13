"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";

export function VenmoSettingsSection() {
  const t = useTranslations("admin");
  const venmo = trpc.admin.getVenmoEnabled.useQuery();
  const setVenmo = trpc.admin.setVenmoEnabled.useMutation({
    onSuccess: () => venmo.refetch(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DollarSign className="h-4 w-4" />
          {t("venmo.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("venmo.description")}
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant={venmo.data?.enabled ? "default" : "outline"}
            size="sm"
            onClick={() => setVenmo.mutate({ enabled: !(venmo.data?.enabled ?? false) })}
            disabled={setVenmo.isPending || venmo.isLoading || !venmo.data}
            data-testid="venmo-toggle-btn"
          >
            {venmo.data?.enabled ? t("venmo.enabled") : t("venmo.disabled")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {venmo.data?.enabled
              ? t("venmo.enabledStatus")
              : t("venmo.disabledStatus")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
