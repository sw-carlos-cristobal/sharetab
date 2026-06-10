"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Rendered only once the profile has loaded, so all fields can be
// initialized directly from the data (no sync-from-query effects that
// could clobber in-progress edits).
function ProfileForm({
  email,
  initialName,
  initialVenmoUsername,
}: {
  email: string;
  initialName: string;
  initialVenmoUsername: string;
}) {
  const t = useTranslations("settings");
  const { update } = useSession();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [venmoUsername, setVenmoUsername] = useState(initialVenmoUsername);

  const updateProfile = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      await update();
      router.refresh();
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    updateProfile.mutate({
      name,
      venmoUsername: venmoUsername.trim() || null,
    });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("profile.email")}</Label>
        <Input id="email" value={email} disabled />
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
      {updateProfile.error && (
        <p className="text-sm text-red-600">{updateProfile.error.message}</p>
      )}
    </form>
  );
}

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { data: session } = useSession();

  const profile = trpc.auth.getProfile.useQuery();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const changePassword = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
  });

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
          {profile.data ? (
            <ProfileForm
              email={profile.data.email ?? session?.user?.email ?? ""}
              initialName={profile.data.name ?? session?.user?.name ?? ""}
              initialVenmoUsername={profile.data.venmoUsername ?? ""}
            />
          ) : (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                  <div className="h-9 w-full animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
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
