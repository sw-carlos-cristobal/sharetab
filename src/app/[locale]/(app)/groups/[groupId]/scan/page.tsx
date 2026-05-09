"use client";

import { Suspense, use, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2, Camera, RefreshCw, Users } from "lucide-react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ItemAssignment } from "@/components/receipts/item-assignment";
import { loadingMessages } from "@/lib/loading-messages";

type Step = "upload" | "processing" | "assign" | "error";

export default function ScanReceiptPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  return (
    <Suspense>
      <ScanReceiptContent params={params} />
    </Suspense>
  );
}

function ScanReceiptContent({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("expenses.scan");
  const { data: authSession } = useSession();
  const resumeReceiptId = searchParams.get("receiptId");
  const group = trpc.groups.get.useQuery({ groupId });
  const providerInfo = trpc.receipts.getScanProviderInfo.useQuery();

  const [step, setStep] = useState<Step>(resumeReceiptId ? "assign" : "upload");
  const [receiptId, setReceiptId] = useState<string | null>(resumeReceiptId);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const [correctionHint, setCorrectionHint] = useState("");
  const [showRescan, setShowRescan] = useState(false);

  // Rotate loading messages while processing
  useEffect(() => {
    if (step !== "processing") return;
    setLoadingMsgIdx(Math.floor(Math.random() * loadingMessages.length));
    const interval = setInterval(() => {
      setLoadingMsgIdx((i) => (i + 1) % loadingMessages.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [step]);

  const processReceipt = trpc.receipts.processReceipt.useMutation({
    onSuccess: () => setStep("assign"),
    onError: (err) => {
      setErrorMessage(err.message);
      setStep("error");
    },
  });

  const shareForClaiming = trpc.guest.createClaimSession.useMutation();
  const receiptData = trpc.receipts.getReceiptItems.useQuery(
    { receiptId: receiptId! },
    { enabled: step === "assign" && !!receiptId }
  );

  async function handleShareForClaiming() {
    if (!receiptId || !receiptData.data) return;
    const { receipt, items } = receiptData.data;
    const extracted = receipt.extractedData;
    if (!extracted) return;

    const currentMembers = members.filter((m) => m.name);
    if (currentMembers.length < 1) return;

    const myId = authSession?.user?.id;
    const myMember = myId ? currentMembers.find(m => m.id === myId) : undefined;
    const myName = myMember?.name ?? authSession?.user?.name ?? currentMembers[0]?.name ?? "Unknown";

    try {
      const result = await shareForClaiming.mutateAsync({
        receiptId,
        receiptData: {
          merchantName: extracted.merchantName,
          date: extracted.date,
          subtotal: extracted.subtotal,
          tax: extracted.tax,
          tip: extracted.tip ?? 0,
          total: extracted.total ?? (extracted.subtotal + extracted.tax + (extracted.tip ?? 0)),
          currency: extracted.currency ?? "USD",
        },
        items: items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          totalPrice: i.totalPrice,
        })),
        creatorName: myName,
        paidByName: myName,
      });
      router.push(`/split/${result.shareToken}/claim`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create claiming session");
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setErrorMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        let message = "Upload failed";
        try {
          const data = await res.json();
          message = data.error ?? message;
        } catch {}
        throw new Error(message);
      }

      const data = await res.json();
      setReceiptId(data.receiptId);
      setStep("processing");
      setUploading(false);

      // Start AI processing with groupId
      processReceipt.mutate({ receiptId: data.receiptId, groupId });
    } catch (err) {
      setUploading(false);
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
      setStep("error");
    }
  }

  function handleExpenseCreated() {
    router.push(`/groups/${groupId}`);
  }


  const members =
    group.data?.members.map((m) => ({
      id: m.user.id,
      name: m.user.placeholderName ?? m.user.name ?? m.user.email,
    })) ?? [];

  const configuredProviderChain =
    providerInfo.data?.configuredProviders?.join(" -> ") ?? "loading...";
  const activeProvider = providerInfo.data?.activeProvider ?? "checking...";

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
      </div>

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              {t("upload")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("uploadDescription")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("activeProvider")} <span className="font-medium text-foreground">{activeProvider}</span>
              {" · "}{t("fallbackChain")} <span className="font-medium text-foreground">{configuredProviderChain}</span>
            </p>

            <div className="space-y-2">
              <Label htmlFor="receipt">{t("receiptImage")}</Label>
              <Input
                id="receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                onChange={handleFileUpload}
                disabled={uploading}
                className="cursor-pointer"
                data-testid="scan-file-input"
              />
            </div>

            {uploading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("uploading")}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === "processing" && (
        <Card data-testid="scan-processing">
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-center space-y-2">
              <p className="font-medium">{t("processing")}</p>
              <p className="text-xs text-muted-foreground">
                {t("using")} <span className="font-medium text-foreground">{activeProvider}</span>
                {" · "}{t("chain")} <span className="font-medium text-foreground">{configuredProviderChain}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {loadingMessages[loadingMsgIdx]}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "assign" && receiptId && (
        <>
          <ItemAssignment
            key={receiptId}
            groupId={groupId}
            receiptId={receiptId}
            members={members}
            onComplete={handleExpenseCreated}
            onSaveForLater={() => router.push(`/groups/${groupId}`)}
          />
          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs">{t("or")}</span>
            <div className="flex-1 h-px bg-border" />
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={handleShareForClaiming}
            disabled={shareForClaiming.isPending || !authSession?.user?.id || !receiptData.data?.receipt?.extractedData || !receiptData.data?.items?.length || members.length < 1}
            data-testid="group-share-claiming-btn"
          >
            <Users className="mr-2 h-4 w-4" />
            {shareForClaiming.isPending ? t("creatingSession") : t("shareForClaiming")}
          </Button>
          <div className="space-y-2">
            {!showRescan ? (
              <Button
                variant="outline"
                onClick={() => setShowRescan(true)}
                data-testid="scan-rescan-btn"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("rescanCorrections")}
              </Button>
            ) : (
              <Card>
                <CardContent className="space-y-3 pt-4">
                  <p className="text-sm text-muted-foreground">
                    {t("rescanDescription")}
                  </p>
                  <textarea
                    placeholder={t("rescanPlaceholder")}
                    value={correctionHint}
                    onChange={(e) => setCorrectionHint(e.target.value)}
                    rows={3}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => {
                        if (!correctionHint.trim()) return;
                        setStep("processing");
                        setShowRescan(false);
                        processReceipt.mutate({ receiptId, groupId, correctionHint: correctionHint.trim() });
                      }}
                      disabled={!correctionHint.trim()}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t("rescan")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => { setShowRescan(false); setCorrectionHint(""); }}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

      {step === "error" && (
        <Card className="border-destructive/50">
          <CardContent className="space-y-4 py-6">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("upload")}>
                {t("retry")}
              </Button>
              {receiptId && (
                <Button
                  onClick={() => {
                    setStep("processing");
                    processReceipt.mutate({ receiptId, groupId });
                  }}
                >
                  {t("retryProcessing")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
