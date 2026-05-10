"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { data: session, update } = useSession();
  const router = useRouter();
  const [name, setName] = useState(session?.user?.name ?? "");
  const [venmoUsername, setVenmoUsername] = useState("");
  const [hasSaved, setHasSaved] = useState(false);

  const profile = trpc.auth.getProfile.useQuery();

  useEffect(() => {
    // Only sync from session on initial load, not after a save
    // (the session JWT may still have the stale name)
    if (session?.user?.name && !hasSaved) {
      setName(session.user.name);
    }
  }, [session?.user?.name, hasSaved]);

  useEffect(() => {
    if (profile.data?.venmoUsername && !hasSaved) {
      setVenmoUsername(profile.data.venmoUsername);
    }
  }, [profile.data?.venmoUsername, hasSaved]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const updateProfile = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      setHasSaved(true);
      await update();
      router.refresh();
    },
  });

  const changePassword = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    updateProfile.mutate({ name, venmoUsername: venmoUsername.trim() || null });
  }

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) return;
    changePassword.mutate({ currentPassword, newPassword });
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t("profile.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("profile.email")}</Label>
              <Input id="email" value={session?.user?.email ?? ""} disabled />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">{t("profile.name")}</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="venmo">{t("profile.venmo")}</Label>
              <Input
                id="venmo"
                value={venmoUsername}
                onChange={(e) => setVenmoUsername(e.target.value)}
                placeholder={t("profile.venmoPlaceholder")}
                data-testid="venmo-username-input"
              />
            </div>
            <Button type="submit" disabled={updateProfile.isPending} data-testid="save-profile-btn">
              {updateProfile.isPending ? t("profile.saving") : t("profile.save")}
            </Button>
            {updateProfile.isSuccess && (
              <p className="text-sm text-green-600">{t("profile.saved")}</p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("password.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">{t("password.current")}</Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                minLength={1}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">{t("password.new")}</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t("password.confirm")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
              />
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="text-sm text-red-600">{t("password.mismatch")}</p>
              )}
            </div>
            <Button
              type="submit"
              disabled={changePassword.isPending || newPassword !== confirmPassword || !currentPassword || !newPassword}
            >
              {changePassword.isPending ? t("password.submitting") : t("password.submit")}
            </Button>
            {changePassword.isSuccess && (
              <p className="text-sm text-green-600">{t("password.success")}</p>
            )}
            {changePassword.error && (
              <p className="text-sm text-red-600">{changePassword.error.message}</p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
