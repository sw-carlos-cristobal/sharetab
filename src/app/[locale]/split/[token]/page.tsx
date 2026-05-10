"use client";

import { use, useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Copy, Share2, Receipt, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";

export default function SharedSplitPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const locale = useLocale();
  const tv = useTranslations("split.venmo");
  const [venmoHandle, setVenmoHandle] = useState("");
  const split = trpc.guest.getSplit.useQuery({ token });
  const venmoSetting = trpc.admin.getVenmoEnabled.useQuery();

  useEffect(() => {
    const saved = localStorage.getItem("sharetab-venmo-handle");
    if (saved) setVenmoHandle(saved);
  }, []);

  if (split.isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading split...</p>
      </div>
    );
  }

  if (split.error) {
    return (
      <div className="text-center space-y-6 py-20">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Receipt className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold">Split not found</h2>
          <p className="text-muted-foreground">
            {split.error.message.includes("expired")
              ? "This split has expired. Splits are available for 7 days."
              : "This split link is invalid or has been removed."}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/split" />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          Split your own bill
        </Button>
      </div>
    );
  }

  const data = split.data!;
  const currency = data.receiptData.currency;
  const paidBy = data.people[data.paidByIndex]?.name ?? "Someone";

  async function handleShare() {
    const url = window.location.href;
    const text = `Bill split from ${data.receiptData.merchantName ?? "a receipt"} — ${formatCents(data.receiptData.total, currency, locale)} total`;

    if (navigator.share) {
      try {
        await navigator.share({ title: "Bill Split", text, url });
      } catch {
        // User cancelled
      }
    } else {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied to clipboard");
  }

  const initials = (name: string) =>
    name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "?";

  // Color palette for avatars
  const colors = [
    "bg-red-100 text-red-700",
    "bg-blue-100 text-blue-700",
    "bg-green-100 text-green-700",
    "bg-purple-100 text-purple-700",
    "bg-amber-100 text-amber-700",
    "bg-pink-100 text-pink-700",
    "bg-teal-100 text-teal-700",
    "bg-indigo-100 text-indigo-700",
  ];

  return (
    <div className="space-y-6 pb-24" data-testid="split-result">
      {/* Header */}
      <div className="text-center space-y-1 pt-4">
        <h1 className="text-2xl font-bold">
          {data.receiptData.merchantName ?? "Bill Split"}
        </h1>
        {data.receiptData.date && (
          <p className="text-sm text-muted-foreground">{data.receiptData.date}</p>
        )}
        <p className="text-sm text-muted-foreground">
          Paid by <span className="font-medium text-foreground">{paidBy}</span>
        </p>
        {venmoSetting.data?.enabled && (
          <div className="flex items-center justify-center gap-2 mt-2">
            <Input
              placeholder={tv("handlePlaceholder")}
              value={venmoHandle}
              onChange={(e) => {
                setVenmoHandle(e.target.value);
                localStorage.setItem("sharetab-venmo-handle", e.target.value);
              }}
              className="h-8 text-sm max-w-48"
              data-testid="venmo-handle-input"
            />
          </div>
        )}
      </div>

      {/* Total */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="py-4">
          <div className="flex justify-between items-center">
            <span className="font-semibold text-lg">Total Bill</span>
            <span className="text-2xl font-bold text-primary">
              {formatCents(data.receiptData.total, currency, locale)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Per-person breakdown */}
      <div className="space-y-3">
        <h3 className="font-semibold text-base">Each person owes</h3>
        {data.summary.map((person, idx) => {
          // Find which items this person was assigned to
          const personItems = data.assignments
            .filter((a) => a.personIndices.includes(person.personIndex))
            .map((a) => data.items[a.itemIndex])
            .filter(Boolean);

          return (
            <Card key={idx} data-testid={`person-card-${idx}`}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className={`text-sm font-semibold ${colors[idx % colors.length]}`}>
                        {initials(person.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="font-semibold">{person.name}</span>
                  </div>
                  <span className="text-xl font-bold text-primary">
                    {formatCents(person.total, currency, locale)}
                  </span>
                </div>

                {/* Item details */}
                <div className="space-y-1 text-sm text-muted-foreground">
                  {personItems.map((item, i) => (
                    <div key={i} className="flex justify-between">
                      <span>{item.name}</span>
                      <span>{formatCents(item.totalPrice, currency, locale)}</span>
                    </div>
                  ))}
                  {person.tax > 0 && (
                    <div className="flex justify-between">
                      <span>Tax</span>
                      <span>{formatCents(person.tax, currency, locale)}</span>
                    </div>
                  )}
                  {person.tip > 0 && (
                    <div className="flex justify-between">
                      <span>Tip</span>
                      <span>{formatCents(person.tip, currency, locale)}</span>
                    </div>
                  )}
                </div>

                {venmoSetting.data?.enabled && venmoHandle && person.personIndex !== data.paidByIndex && (
                  <a
                    href={`https://venmo.com/${encodeURIComponent(venmoHandle)}?txn=pay&amount=${(person.total / 100).toFixed(2)}&note=${encodeURIComponent(`ShareTab: ${data.receiptData.merchantName ?? 'Bill split'}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-[#008CFF] px-4 py-2 text-sm font-medium text-white hover:bg-[#0070CC] transition-colors"
                    data-testid={`venmo-pay-${idx}`}
                  >
                    {tv("payVia", { amount: formatCents(person.total, currency, locale) })}
                  </a>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Receipt breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Receipt details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCents(data.receiptData.subtotal, currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tax</span>
            <span>{formatCents(data.receiptData.tax, currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tip</span>
            <span>{formatCents(data.receiptData.tip, currency, locale)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCents(data.receiptData.total, currency, locale)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Expiry notice */}
      <p className="text-xs text-center text-muted-foreground">
        This split link expires on {new Date(data.expiresAt).toLocaleDateString()}.
      </p>

      {/* CTA */}
      <div className="text-center">
        <Link href="/split" className="text-sm font-medium text-primary hover:underline">
          Split your own bill
        </Link>
        <span className="text-muted-foreground mx-2">or</span>
        <Link href="/register" className="text-sm font-medium text-primary hover:underline">
          Create an account
        </Link>
      </div>

      {/* Share buttons - sticky bottom */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
        <div className="mx-auto max-w-lg flex gap-2">
          <Button variant="outline" className="flex-1 h-14" onClick={handleCopy} data-testid="copy-link-btn">
            <Copy className="mr-2 h-5 w-5" />
            Copy Link
          </Button>
          <Button className="flex-1 h-14" onClick={handleShare} data-testid="share-btn">
            <Share2 className="mr-2 h-5 w-5" />
            Share
          </Button>
        </div>
      </div>
    </div>
  );
}
