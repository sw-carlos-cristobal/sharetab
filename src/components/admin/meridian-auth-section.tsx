"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Bot,
  KeyRound,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Bell,
  Copy,
} from "lucide-react";

export function MeridianAuthSection() {
  const utils = trpc.useUtils();
  const searchParams = useSearchParams();
  const router = useRouter();

  const authStatus = trpc.admin.getMeridianAuthStatus.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const notifyPref = trpc.admin.getMeridianNotifyPreference.useQuery();

  const startLogin = trpc.admin.startMeridianLogin.useMutation({
    onSuccess: (data) => {
      setLoginUrl(data.url);
      setLoginState("waiting_for_code");
    },
    onError: (err) => {
      setLoginState("error");
      setLoginError(err.message);
    },
  });

  const completeLogin = trpc.admin.completeMeridianLogin.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        setLoginState("success");
        utils.admin.getMeridianAuthStatus.invalidate();
        utils.admin.getSystemHealth.invalidate();
      } else {
        setLoginState("error");
        setLoginError(data.error ?? "Login failed");
      }
    },
    onError: (err) => {
      setLoginState("error");
      setLoginError(err.message);
    },
  });

  const cancelMutation = trpc.admin.cancelMeridianLogin.useMutation({
    onSuccess: () => {
      resetLoginState();
    },
  });

  const logoutMutation = trpc.admin.logoutMeridian.useMutation({
    onSuccess: () => {
      resetLoginState();
      utils.admin.getMeridianAuthStatus.invalidate();
      utils.admin.getSystemHealth.invalidate();
    },
  });

  const setNotifyPref = trpc.admin.setMeridianNotifyPreference.useMutation({
    onSuccess: () => {
      utils.admin.getMeridianNotifyPreference.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const [loginState, setLoginState] = useState<
    "idle" | "starting" | "waiting_for_code" | "submitting" | "success" | "error"
  >("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function resetLoginState() {
    setLoginState("idle");
    setLoginUrl(null);
    setLoginCode("");
    setLoginError(null);
  }

  // Handle OAuth callback redirect params
  useEffect(() => {
    const authResult = searchParams.get("meridian_auth");
    const authError = searchParams.get("meridian_error");
    if (authResult === "success") {
      setLoginState("success");
      utils.admin.getMeridianAuthStatus.invalidate();
      utils.admin.getSystemHealth.invalidate();
      router.replace("/admin");
    } else if (authError) {
      setLoginState("error");
      setLoginError(decodeURIComponent(authError));
      router.replace("/admin");
    }
  }, [searchParams, utils, router]);

  // Don't render if not using meridian
  const status = authStatus.data;
  if (!status || "status" in status && status.status === "not_applicable") {
    return null;
  }

  const isHealthy = status.status === "healthy";
  const statusColor = isHealthy
    ? "bg-green-500"
    : status.status === "not_running"
      ? "bg-gray-400"
      : "bg-red-500";

  const statusLabel = isHealthy
    ? "Authenticated"
    : status.status === "not_running"
      ? "Proxy not running"
      : "Authentication expired";

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Meridian Authentication</h2>
      </div>

      <div className="grid gap-4 @2xl:grid-cols-2">
        {/* Auth Status Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bot className="h-4 w-4" />
              Claude OAuth Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
              <span className="text-sm font-medium">{statusLabel}</span>
              {isHealthy && status.email && (
                <Badge variant="outline" className="text-xs">
                  {status.email}
                </Badge>
              )}
            </div>

            {status.error && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {status.error}
              </p>
            )}

            {/* Login Flow */}
            {!isHealthy && loginState === "idle" && (
              <Button
                size="sm"
                onClick={() => {
                  setLoginState("starting");
                  startLogin.mutate();
                }}
                disabled={status.loginInProgress}
              >
                {status.loginInProgress ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Login in progress...
                  </>
                ) : (
                  "Re-authenticate"
                )}
              </Button>
            )}

            {isHealthy && loginState === "idle" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
              >
                {logoutMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Logging out...
                  </>
                ) : (
                  "Log out"
                )}
              </Button>
            )}

            {loginState === "starting" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Starting login flow...
              </div>
            )}

            {loginState === "waiting_for_code" && loginUrl && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm">
                  <span className="font-semibold">Step 1:</span> Click the link
                  below to sign in with Claude.
                </p>
                <div className="flex items-center gap-2">
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-primary underline break-all"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    Open authentication page
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(loginUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                  >
                    {copied ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="font-semibold">Step 2:</span> After
                    authorizing, copy the{" "}
                    <span className="font-semibold text-primary">
                      URL from your browser&apos;s address bar
                    </span>{" "}
                    and paste it below.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Do not copy the code shown on the page — paste the full URL
                    starting with https://platform.claude.com/...
                  </p>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 rounded-md border px-3 py-1.5 text-sm bg-background"
                    placeholder="https://platform.claude.com/oauth/code/callback?code=..."
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={!loginCode.trim() || completeLogin.isPending}
                    onClick={() => {
                      setLoginState("submitting");
                      completeLogin.mutate({ code: loginCode.trim() });
                    }}
                  >
                    {completeLogin.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Submit"
                    )}
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    cancelMutation.mutate();
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}

            {loginState === "submitting" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Completing login...
              </div>
            )}

            {loginState === "success" && (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                Login successful! Authentication restored.
                <Button variant="ghost" size="sm" onClick={resetLoginState}>
                  Dismiss
                </Button>
              </div>
            )}

            {loginState === "error" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <XCircle className="h-4 w-4" />
                  {loginError}
                </div>
                <Button variant="outline" size="sm" onClick={resetLoginState}>
                  Try again
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Notification Preferences Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Bell className="h-4 w-4" />
              Auth Expiry Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              How often to receive email alerts when Claude authentication
              expires.
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
                <SelectItem value="once">Once per incident</SelectItem>
                <SelectItem value="1h">Every hour</SelectItem>
                <SelectItem value="6h">Every 6 hours</SelectItem>
                <SelectItem value="24h">Every 24 hours</SelectItem>
              </SelectContent>
            </Select>
            {setNotifyPref.isPending && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Saving...
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
