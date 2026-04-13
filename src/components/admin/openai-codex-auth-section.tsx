"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  KeyRound,
  Loader2,
  CheckCircle2,
  Copy,
  ExternalLink,
} from "lucide-react";

export function OpenAICodexAuthSection() {
  const utils = trpc.useUtils();
  const authStatus = trpc.admin.getOpenAICodexAuthStatus.useQuery(undefined, {
    refetchInterval: 15_000,
  });

  const startLogin = trpc.admin.startOpenAICodexLogin.useMutation({
    onSuccess: (data) => {
      setLoginUrl(data.url);
      setLoginState("waiting_for_code");
    },
    onError: (err) => {
      setLoginState("error");
      setLoginError(err.message);
    },
  });

  const completeLogin = trpc.admin.completeOpenAICodexLogin.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        setLoginState("success");
        utils.admin.getOpenAICodexAuthStatus.invalidate();
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

  const cancelMutation = trpc.admin.cancelOpenAICodexLogin.useMutation({
    onSuccess: () => resetLoginState(),
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

  const status = authStatus.data;
  if (!status || "status" in status && status.status === "not_applicable") {
    return null;
  }

  const isHealthy = status.status === "healthy";
  const statusColor = isHealthy ? "bg-green-500" : "bg-red-500";
  const statusLabel = isHealthy ? "Authenticated" : "Authentication required";

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">ChatGPT OAuth</h2>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Bot className="h-4 w-4" />
            OpenAI Codex Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
            <span className="text-sm font-medium">{statusLabel}</span>
            {"email" in status && status.email && (
              <Badge variant="outline" className="text-xs">
                {status.email}
              </Badge>
            )}
            {"planType" in status && status.planType && (
              <Badge variant="outline" className="text-xs">
                {status.planType}
              </Badge>
            )}
          </div>

          {"error" in status && status.error && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {status.error}
            </p>
          )}

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
                "Authenticate with ChatGPT"
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
                <span className="font-semibold">Step 1:</span> Open the login link
                and finish the ChatGPT authorization flow.
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
                  <span className="font-semibold">Step 2:</span> After login,
                  copy the final browser URL and paste it below.
                </p>
                <p className="text-xs text-muted-foreground">
                  The OpenAI flow redirects to <code>localhost:1455</code>. That
                  callback is expected to fail in the browser here, so copy the
                  full redirected URL from the address bar.
                </p>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 rounded-md border px-3 py-1.5 text-sm bg-background"
                  placeholder="http://localhost:1455/auth/callback?code=..."
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
                onClick={() => cancelMutation.mutate()}
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
            <div className="text-sm text-green-600 dark:text-green-400">
              ChatGPT OAuth authentication completed.
            </div>
          )}

          {loginState === "error" && loginError && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {loginError}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
