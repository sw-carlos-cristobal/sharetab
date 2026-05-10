"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";

export function VenmoSettingsSection() {
  const venmo = trpc.admin.getVenmoEnabled.useQuery();
  const setVenmo = trpc.admin.setVenmoEnabled.useMutation({
    onSuccess: () => venmo.refetch(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DollarSign className="h-4 w-4" />
          Venmo Payments
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          When enabled, split results show &quot;Pay via Venmo&quot; deeplink
          buttons. The payer enters their Venmo username and others can tap to
          pay.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant={venmo.data?.enabled ? "default" : "outline"}
            size="sm"
            onClick={() => setVenmo.mutate({ enabled: !venmo.data?.enabled })}
            disabled={setVenmo.isPending || venmo.isLoading}
            data-testid="venmo-toggle-btn"
          >
            {venmo.data?.enabled ? "Enabled" : "Disabled"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {venmo.data?.enabled
              ? "Venmo payment links are visible on split results"
              : "Venmo payment links are hidden"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
