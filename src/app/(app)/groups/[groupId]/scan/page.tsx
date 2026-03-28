"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Upload, Loader2, Camera } from "lucide-react";
import Link from "next/link";
import { ItemAssignment } from "@/components/receipts/item-assignment";

type Step = "upload" | "processing" | "assign" | "error";

export default function ScanReceiptPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const router = useRouter();
  const group = trpc.groups.get.useQuery({ groupId });

  const [step, setStep] = useState<Step>("upload");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [uploading, setUploading] = useState(false);

  const processReceipt = trpc.receipts.processReceipt.useMutation({
    onSuccess: () => setStep("assign"),
    onError: (err) => {
      setErrorMessage(err.message);
      setStep("error");
    },
  });

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
        const data = await res.json();
        throw new Error(data.error ?? "Upload failed");
      }

      const data = await res.json();
      setReceiptId(data.receiptId);
      setStep("processing");
      setUploading(false);

      // Start AI processing
      processReceipt.mutate({ receiptId: data.receiptId });
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
      name: m.user.name,
    })) ?? [];

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" render={<Link href={`/groups/${groupId}`} />}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">Scan Receipt</h1>
      </div>

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              Upload a receipt
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Take a photo or upload an image of your receipt. AI will extract the
              items, tax, and tip so you can assign them to group members.
            </p>

            <div className="space-y-2">
              <Label htmlFor="receipt">Receipt image</Label>
              <Input
                id="receipt"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                onChange={handleFileUpload}
                disabled={uploading}
                className="cursor-pointer"
              />
            </div>

            {uploading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading...
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === "processing" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-center">
              <p className="font-medium">Processing receipt...</p>
              <p className="text-sm text-muted-foreground">
                AI is extracting items from your receipt. This may take a few seconds.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "assign" && receiptId && (
        <ItemAssignment
          groupId={groupId}
          receiptId={receiptId}
          members={members}
          onComplete={handleExpenseCreated}
        />
      )}

      {step === "error" && (
        <Card className="border-destructive/50">
          <CardContent className="space-y-4 py-6">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("upload")}>
                Try again
              </Button>
              {receiptId && (
                <Button
                  onClick={() => {
                    setStep("processing");
                    processReceipt.mutate({ receiptId });
                  }}
                >
                  Retry processing
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
