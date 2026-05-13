'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Loader2,
  ShieldCheck,
  Plus,
  Copy,
  Ban,
  Check,
} from 'lucide-react';

export function RegistrationControlSection() {
  const t = useTranslations("admin");
  const utils = trpc.useUtils();
  const regMode = trpc.admin.getRegistrationMode.useQuery();
  const setMode = trpc.admin.setRegistrationMode.useMutation({
    onSuccess: () => utils.admin.getRegistrationMode.invalidate(),
  });
  const invites = trpc.admin.listSystemInvites.useQuery();
  const createInvite = trpc.admin.createSystemInvite.useMutation({
    onSuccess: () => {
      utils.admin.listSystemInvites.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });
  const revokeInvite = trpc.admin.revokeSystemInvite.useMutation({
    onSuccess: () => {
      utils.admin.listSystemInvites.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const [inviteLabel, setInviteLabel] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const currentMode = regMode.data?.mode ?? 'open';

  const MODE_INFO = {
    open: {
      label: t("registration.open"),
      description: t("registration.openDescription"),
      variant: 'default' as const,
    },
    'invite-only': {
      label: t("registration.inviteOnly"),
      description: t("registration.inviteOnlyDescription"),
      variant: 'secondary' as const,
    },
    closed: {
      label: t("registration.closed"),
      description: t("registration.closedDescription"),
      variant: 'destructive' as const,
    },
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("registration.title")}</h2>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("registration.modeTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant={MODE_INFO[currentMode].variant}>
                {MODE_INFO[currentMode].label}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {MODE_INFO[currentMode].description}
              </span>
            </div>
            <div className="flex gap-2">
              {(Object.keys(MODE_INFO) as Array<keyof typeof MODE_INFO>).map(
                (mode) => (
                  <Button
                    key={mode}
                    variant={currentMode === mode ? 'default' : 'outline'}
                    size="sm"
                    disabled={setMode.isPending || currentMode === mode}
                    onClick={() => setMode.mutate({ mode })}
                  >
                    {setMode.isPending &&
                    setMode.variables?.mode === mode ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : null}
                    {MODE_INFO[mode].label}
                  </Button>
                )
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("registration.createInvite")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder={t("registration.labelPlaceholder")}
                value={inviteLabel}
                onChange={(e) => setInviteLabel(e.target.value)}
                className="flex-1"
              />
              <Button
                size="sm"
                disabled={createInvite.isPending}
                onClick={() => {
                  createInvite.mutate({
                    label: inviteLabel || undefined,
                    expiresInDays: 7,
                  });
                  setInviteLabel('');
                }}
              >
                {createInvite.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-3 w-3" />
                )}
                {t("registration.create")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("registration.inviteExpiry")}
            </p>
          </CardContent>
        </Card>
      </div>

      {invites.data && invites.data.length > 0 && (
        <Card className="mt-4">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">{t("registration.colCode")}</th>
                    <th className="px-4 py-3 font-medium">{t("registration.colLabel")}</th>
                    <th className="px-4 py-3 font-medium">{t("registration.colStatus")}</th>
                    <th className="px-4 py-3 font-medium">{t("registration.colCreated")}</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {invites.data.map((inv) => (
                    <tr key={inv.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-mono text-xs">
                        <div className="flex items-center gap-1">
                          {inv.code.slice(0, 12)}...
                          <button
                            type="button"
                            className="rounded p-0.5 hover:bg-muted"
                            onClick={() => {
                              navigator.clipboard.writeText(inv.code);
                              setCopiedCode(inv.code);
                              setTimeout(() => setCopiedCode(null), 2000);
                            }}
                          >
                            {copiedCode === inv.code ? (
                              <Check className="h-3 w-3 text-green-600" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {inv.label ?? '---'}
                      </td>
                      <td className="px-4 py-3">
                        {inv.revokedAt ? (
                          <Badge variant="destructive">{t("registration.statusRevoked")}</Badge>
                        ) : inv.usedAt ? (
                          <Badge variant="secondary">
                            {t("registration.statusUsedBy", { name: inv.usedBy?.name ?? inv.usedBy?.email })}
                          </Badge>
                        ) : inv.isActive ? (
                          <Badge variant="default">{t("registration.statusActive")}</Badge>
                        ) : (
                          <Badge variant="outline">{t("registration.statusExpired")}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {inv.isActive && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() =>
                              revokeInvite.mutate({ inviteId: inv.id })
                            }
                            disabled={revokeInvite.isPending}
                          >
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
