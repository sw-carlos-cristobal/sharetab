"use client";

import { useRef, useState } from "react";
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
  FlaskConical,
  Upload,
  AlertCircle,
  X,
} from "lucide-react";

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

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

  const logoutMutation = trpc.admin.logoutOpenAICodex.useMutation({
    onSuccess: () => {
      resetLoginState();
      utils.admin.getOpenAICodexAuthStatus.invalidate();
      utils.admin.getSystemHealth.invalidate();
    },
  });

  const testProvider = trpc.admin.testAIProvider.useMutation({
    onSettled: () => utils.admin.getAuditLog.invalidate(),
  });

  const [loginState, setLoginState] = useState<
    "idle" | "starting" | "waiting_for_code" | "submitting" | "success" | "error"
  >("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const [testFile, setTestFile] = useState<{
    name: string;
    base64: string;
    mimeType: string;
  } | null>(null);

  function resetLoginState() {
    setLoginState("idle");
    setLoginUrl(null);
    setLoginCode("");
    setLoginError(null);
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (!ACCEPTED_TYPES.includes(selected.type)) return;
    if (selected.size > 5 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      setTestFile({ name: selected.name, base64, mimeType: selected.type });
      testProvider.reset();
    };
    reader.readAsDataURL(selected);
  };

  const clearFile = () => {
    setTestFile(null);
    testProvider.reset();
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleTest = () => {
    if (!testFile) return;
    testProvider.mutate({
      providerName: "openai-codex",
      imageBase64: testFile.base64,
      mimeType: testFile.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
    });
  };

  const status = authStatus.data;
  if (!status || "status" in status && status.status === "not_applicable") {
    return null;
  }

  const isHealthy = status.status === "healthy";
  const isDegraded = status.status === "degraded";
  const isWaitingForCode =
    loginState === "waiting_for_code" || (loginState === "idle" && status.loginInProgress);
  const statusColor = isHealthy ? "bg-green-500" : isDegraded ? "bg-yellow-500" : "bg-red-500";
  const statusLabel = isHealthy
    ? "Authenticated"
    : isDegraded
      ? "Service degraded"
      : "Authentication required";

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

          {!isHealthy && loginState === "idle" && !status.loginInProgress && (
            <Button
              size="sm"
              onClick={() => {
                setLoginState("starting");
                startLogin.mutate();
              }}
            >
              Authenticate with ChatGPT
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

          {isWaitingForCode && (
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm">
                <span className="font-semibold">Step 1:</span>{" "}
                {loginUrl
                  ? "Open the login link and finish the ChatGPT authorization flow."
                  : "Finish the ChatGPT authorization flow you already started."}
              </p>
              {loginUrl ? (
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
              ) : (
                <p className="text-xs text-muted-foreground">
                  A login is already in progress. If you opened the ChatGPT auth page before
                  refreshing, paste the callback URL below. Otherwise cancel and start again.
                </p>
              )}
              <div className="space-y-1">
                <p className="text-sm">
                  <span className="font-semibold">Step 2:</span> After login, copy
                  the final browser URL and paste it below.
                </p>
                <p className="text-xs text-muted-foreground">
                  The OpenAI flow redirects to localhost:1455. That callback is
                  expected to fail in the browser here, so copy the full redirected
                  URL from the address bar.
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
                disabled={cancelMutation.isPending}
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

          {/* Test Receipt Extraction */}
          {isHealthy && loginState === "idle" && (
            <>
              <div className="border-t pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Test Receipt Extraction
                </p>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept={ACCEPTED_TYPES.join(",")}
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => fileRef.current?.click()}
                    disabled={testProvider.isPending}
                  >
                    <Upload className="mr-1 h-3 w-3" />
                    {testFile ? "Change" : "Upload"}
                  </Button>
                  {testFile && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="max-w-32 truncate">{testFile.name}</span>
                      <button
                        onClick={clearFile}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={!testFile || testProvider.isPending}
                    onClick={handleTest}
                  >
                    {testProvider.isPending ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <FlaskConical className="mr-1 h-3 w-3" />
                    )}
                    Test
                  </Button>
                </div>
              </div>

              {testProvider.isSuccess && (
                <div className="space-y-1">
                  <p className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2 className="h-3 w-3" />
                    Responded in {testProvider.data.durationMs}ms
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                    {JSON.stringify(testProvider.data.result, null, 2)}
                  </pre>
                </div>
              )}

              {testProvider.isError && (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertCircle className="h-3 w-3" />
                  {testProvider.error.message}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
