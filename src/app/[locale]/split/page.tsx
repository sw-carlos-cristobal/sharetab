"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { trpc } from "@/lib/trpc";
import { formatCents, centsToDecimal, parseToCents } from "@/lib/money";
import { calculateSplitTotals } from "@/lib/split-calculator";
import { loadingMessages } from "@/lib/loading-messages";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Camera, Loader2, Plus, Trash2, Check, Users, ArrowLeft, ArrowRight,
  Share2, Pencil, Image as ImageIcon, RefreshCw, Scissors,
} from "lucide-react";
import { toast } from "sonner";

type Step = "upload" | "processing" | "people" | "assign";

type GuestItem = {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
};

type ExtractedData = {
  merchantName?: string;
  date?: string;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  currency: string;
};

export default function GuestSplitPage() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("split");
  const [step, setStep] = useState<Step>("upload");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);

  // Data
  const [items, setItems] = useState<GuestItem[]>([]);
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [people, setPeople] = useState<string[]>([""]); // start with one empty name
  const [assignments, setAssignments] = useState<Record<number, Set<number>>>({}); // itemIdx -> Set<personIdx>
  const [paidByIndex, setPaidByIndex] = useState(0);
  const [tipOverride, setTipOverride] = useState("");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [showImage, setShowImage] = useState(false);
  const [correctionHint, setCorrectionHint] = useState("");
  const [showRescan, setShowRescan] = useState(false);

  // Editing
  const [editingItem, setEditingItem] = useState<number | null>(null);
  const [editValues, setEditValues] = useState({ name: "", quantity: "1", totalPrice: "" });
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", quantity: "1", totalPrice: "" });

  // Splitting
  const [splittingIndex, setSplittingIndex] = useState<number | null>(null);
  const [splitQuantity, setSplitQuantity] = useState("");

  // tRPC
  const processReceipt = trpc.guest.processReceipt.useMutation();
  const providerInfo = trpc.guest.getScanProviderInfo.useQuery();
  const receiptData = trpc.guest.getReceiptItems.useQuery(
    { receiptId: receiptId! },
    { enabled: !!receiptId && step === "people" }
  );
  const createSplit = trpc.guest.createSplit.useMutation();
  const createClaimSession = trpc.guest.createClaimSession.useMutation();

  const configuredProviderChain =
    providerInfo.data?.configuredProviders?.join(" -> ") ?? "loading...";
  const activeProvider = providerInfo.data?.activeProvider ?? "checking...";

  // Rotate loading messages
  useEffect(() => {
    if (step !== "processing") return;
    setLoadingMsgIdx(Math.floor(Math.random() * loadingMessages.length));
    const interval = setInterval(() => {
      setLoadingMsgIdx((i) => (i + 1) % loadingMessages.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [step]);

  // Load items when receipt data arrives
  useEffect(() => {
    if (receiptData.data && items.length === 0) {
      const { receipt, items: dbItems } = receiptData.data;
      setItems(dbItems.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        totalPrice: i.totalPrice,
      })));
      if (receipt.extractedData) {
        setExtracted(receipt.extractedData);
      }
      if (receipt.imagePath) {
        setImagePath(receipt.imagePath);
      }
    }
  }, [receiptData.data, items.length]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setErrorMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload?guest=true", {
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
      setImagePath(data.imagePath);
      setStep("processing");
      setUploading(false);

      // Start AI processing
      const result = await processReceipt.mutateAsync({ receiptId: data.receiptId });
      setExtracted({
        merchantName: result.merchantName,
        date: result.date,
        subtotal: result.subtotal,
        tax: result.tax,
        tip: result.tip,
        total: result.total,
        currency: result.currency,
      });
      setStep("people");
    } catch (err) {
      setUploading(false);
      setErrorMessage(err instanceof Error ? err.message : "Upload failed");
      setStep("upload");
    }
  }

  function removePerson(idx: number) {
    setPeople((p) => p.filter((_, i) => i !== idx));
    // Clean up assignments
    setAssignments((prev) => {
      const next: Record<number, Set<number>> = {};
      for (const [itemIdx, personSet] of Object.entries(prev)) {
        const newSet = new Set<number>();
        for (const pIdx of personSet) {
          if (pIdx < idx) newSet.add(pIdx);
          else if (pIdx > idx) newSet.add(pIdx - 1);
        }
        if (newSet.size > 0) next[parseInt(itemIdx)] = newSet;
      }
      return next;
    });
    if (paidByIndex >= idx && paidByIndex > 0) {
      setPaidByIndex((p) => p - 1);
    }
  }

  function updatePersonName(idx: number, name: string) {
    setPeople((p) => p.map((n, i) => (i === idx ? name : n)));
  }

  // Assignment
  function toggleAssignment(itemIdx: number, personIdx: number) {
    setAssignments((prev) => {
      const next = { ...prev };
      const current = new Set(next[itemIdx] ?? []);
      if (current.has(personIdx)) {
        current.delete(personIdx);
      } else {
        current.add(personIdx);
      }
      next[itemIdx] = current;
      return next;
    });
  }

  function assignAllToEveryone() {
    const validIndices = people
      .map((name, idx) => ({ name, idx }))
      .filter((p) => p.name.trim())
      .map((p) => p.idx);
    const next: Record<number, Set<number>> = {};
    for (let i = 0; i < items.length; i++) {
      next[i] = new Set(validIndices);
    }
    setAssignments(next);
  }

  // Item editing
  function startEditing(idx: number) {
    const item = items[idx];
    setEditingItem(idx);
    setEditValues({
      name: item.name,
      quantity: String(item.quantity),
      totalPrice: centsToDecimal(item.totalPrice),
    });
  }

  function saveEdit() {
    if (editingItem === null) return;
    const totalPrice = parseToCents(editValues.totalPrice);
    const quantity = parseInt(editValues.quantity) || 1;
    setItems((prev) => prev.map((item, i) =>
      i === editingItem
        ? { name: editValues.name, quantity, unitPrice: Math.round(totalPrice / quantity), totalPrice }
        : item
    ));
    setEditingItem(null);
  }

  function deleteItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
    setAssignments((prev) => {
      const next: Record<number, Set<number>> = {};
      for (const [key, val] of Object.entries(prev)) {
        const k = parseInt(key);
        if (k < idx) next[k] = val;
        else if (k > idx) next[k - 1] = val;
      }
      return next;
    });
  }

  function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    const totalPrice = parseToCents(newItem.totalPrice);
    const quantity = parseInt(newItem.quantity) || 1;
    if (!newItem.name || totalPrice <= 0) return;
    setItems((prev) => [...prev, {
      name: newItem.name,
      quantity,
      unitPrice: Math.round(totalPrice / quantity),
      totalPrice,
    }]);
    setAddingItem(false);
    setNewItem({ name: "", quantity: "1", totalPrice: "" });
  }

  // Split item into two rows
  function handleSplitItem(index: number) {
    const qty = Number(splitQuantity);
    const item = items[index];
    if (!item || !Number.isSafeInteger(qty) || qty < 1 || qty >= item.quantity) return;

    const maxNewTotal = item.totalPrice - 1;
    if (maxNewTotal <= 0) return;

    const newTotalPrice = Math.min(item.unitPrice * qty, maxNewTotal);
    const remainingQty = item.quantity - qty;
    const remainingTotalPrice = item.totalPrice - newTotalPrice;

    if (newTotalPrice <= 0 || remainingTotalPrice <= 0) return;

    const updated = [...items];
    updated[index] = { ...item, quantity: remainingQty, totalPrice: remainingTotalPrice };
    updated.splice(index + 1, 0, {
      name: item.name,
      quantity: qty,
      unitPrice: item.unitPrice,
      totalPrice: newTotalPrice,
    });
    setItems(updated);

    // Shift assignments: indices after the insertion point need to be incremented
    const newAssignments: Record<number, Set<number>> = {};
    for (const [key, value] of Object.entries(assignments)) {
      const k = parseInt(key);
      if (k > index) {
        newAssignments[k + 1] = value;
      } else {
        newAssignments[k] = value;
      }
    }
    setAssignments(newAssignments);

    // Shift index-based UI state so edits don't target the wrong item
    setEditingItem((prev) => (prev !== null && prev > index ? prev + 1 : prev));
    setSplittingIndex(null);
  }

  // Calculate totals
  const tip = tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : (extracted?.tip ?? 0);
  const currency = extracted?.currency ?? "USD";

  const getPerPersonTotals = useCallback(() => {
    if (!extracted || items.length === 0) return [];
    const assignmentList = Object.entries(assignments)
      .filter(([, s]) => s.size > 0)
      .map(([itemIdx, personSet]) => ({
        itemIndex: parseInt(itemIdx),
        personIndices: Array.from(personSet),
      }));

    return calculateSplitTotals({
      items,
      assignments: assignmentList,
      tax: extracted.tax,
      tip,
      peopleCount: people.length,
    });
  }, [items, assignments, extracted, tip, people.length]);

  const perPersonTotals = step === "assign" ? getPerPersonTotals() : [];
  const assignedCount = Object.values(assignments).filter((s) => s.size > 0).length;
  const allAssigned = assignedCount === items.length && items.length > 0;
  const validPeople = people.filter((n) => n.trim().length > 0);

  async function handleCreateSplit() {
    if (!extracted || !allAssigned || validPeople.length < 1) return;

    // Build index mapping from unfiltered people → filtered validPeople
    const indexMap = new Map<number, number>();
    let validIdx = 0;
    for (let i = 0; i < people.length; i++) {
      if (people[i].trim()) {
        indexMap.set(i, validIdx++);
      }
    }

    const assignmentList = Object.entries(assignments)
      .filter(([, s]) => s.size > 0)
      .map(([itemIdx, personSet]) => ({
        itemIndex: parseInt(itemIdx),
        personIndices: Array.from(personSet)
          .filter((pi) => indexMap.has(pi))
          .map((pi) => indexMap.get(pi)!),
      }))
      .filter((a) => a.personIndices.length > 0);

    const remappedPaidBy = indexMap.get(paidByIndex) ?? 0;

    try {
      const result = await createSplit.mutateAsync({
        receiptId: receiptId ?? undefined,
        receiptData: { ...extracted, tip },
        items,
        people: validPeople.map((n) => ({ name: n })),
        assignments: assignmentList,
        paidByIndex: remappedPaidBy,
        tipOverride: tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : undefined,
      });
      router.push(`/split/${result.shareToken}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create split");
    }
  }

  async function handleShareForClaiming() {
    if (!extracted || validPeople.length < 1) return;

    try {
      const result = await createClaimSession.mutateAsync({
        receiptId: receiptId ?? undefined,
        receiptData: { ...extracted, tip },
        items,
        creatorName: people[paidByIndex]?.trim() || validPeople[0],
        paidByName: people[paidByIndex]?.trim() || validPeople[0],
      });
      router.push(`/split/${result.shareToken}/claim`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create claiming session");
    }
  }

  const initials = (name: string) =>
    name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "?";

  return (
    <div className="space-y-6 pb-24">
      {/* Step: Upload */}
      {step === "upload" && (
        <div className="space-y-6">
          <div className="text-center space-y-2 pt-8">
            <h1 className="text-3xl font-bold tracking-tight">{t("upload.title")}</h1>
            <p className="text-muted-foreground">
              {t("upload.subtitle")}
            </p>
          </div>

          {errorMessage && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {/* Camera capture button - mobile optimized */}
          <label className="flex flex-col items-center gap-4 rounded-2xl bg-primary p-8 text-primary-foreground cursor-pointer active:scale-[0.98] transition-transform" data-testid="guest-snap-upload">
            <div className="rounded-full bg-primary-foreground/20 p-4">
              <Camera className="h-10 w-10" />
            </div>
            <span className="text-xl font-semibold">{t("upload.snapBill")}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              capture="environment"
              onChange={handleFileUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>

          <div className="relative flex items-center justify-center">
            <span className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </span>
            <span className="relative bg-background px-4 text-sm text-muted-foreground uppercase">
              {t("upload.or")}
            </span>
          </div>

          {/* Gallery upload */}
          <label className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-muted-foreground/25 p-8 cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98]" data-testid="guest-gallery-upload">
            <div className="rounded-full bg-muted p-4">
              <ImageIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <span className="text-lg font-medium text-muted-foreground">{t("upload.chooseGallery")}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              onChange={handleFileUpload}
              disabled={uploading}
              className="hidden"
              data-testid="guest-file-input"
            />
          </label>

          {uploading && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("upload.uploading")}
            </div>
          )}
        </div>
      )}

      {/* Step: Processing */}
      {step === "processing" && (
        <div className="flex flex-col items-center justify-center gap-6 py-20" data-testid="guest-processing">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <div className="text-center space-y-2 max-w-xs">
            <p className="font-semibold text-lg">{t("processing.title")}</p>
            <p className="text-sm text-muted-foreground animate-fade-in">
              {loadingMessages[loadingMsgIdx]}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("processing.activeProvider")} <span className="font-medium text-foreground">{activeProvider}</span>
              {" · "}{t("processing.fallbackChain")} <span className="font-medium text-foreground">{configuredProviderChain}</span>
            </p>
          </div>
        </div>
      )}

      {/* Step: People */}
      {step === "people" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep("upload")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-xl font-bold" data-testid="guest-people-step">{t("people.title")}</h2>
          </div>

          <p className="text-sm text-muted-foreground">
            {t("people.subtitle")}
          </p>

          {/* Person list */}
          <div className="space-y-3">
            {people.map((name, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarFallback className="text-sm bg-primary/10 text-primary">
                    {name.trim() ? initials(name) : `P${idx + 1}`}
                  </AvatarFallback>
                </Avatar>
                <Input
                  value={name}
                  onChange={(e) => updatePersonName(idx, e.target.value)}
                  placeholder={t("people.personPlaceholder", { index: idx + 1 })}
                  className="h-12 text-base"
                  data-testid={`person-input-${idx}`}
                />
                {people.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removePerson(idx)}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            className="w-full h-12"
            onClick={() => setPeople((p) => [...p, ""])}
            data-testid="add-person-btn"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("people.addPerson")}
          </Button>

          {/* Who paid? */}
          <div className="space-y-2">
            <Label>{t("people.whoPaid")}</Label>
            <select
              value={paidByIndex}
              onChange={(e) => setPaidByIndex(parseInt(e.target.value))}
              className="flex h-12 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm"
            >
              {people.map((name, idx) => (
                <option key={idx} value={idx}>
                  {name.trim() || t("people.personPlaceholder", { index: idx + 1 })}
                </option>
              ))}
            </select>
          </div>

          {/* Next button - sticky bottom */}
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
            <div className="mx-auto max-w-lg space-y-3">
              <Button
                className="w-full h-14 text-lg"
                disabled={validPeople.length < 1}
                onClick={() => setStep("assign")}
                data-testid="next-assign-btn"
              >
                {t("people.nextAssign")}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
              {!showRescan ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setShowRescan(true)}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("people.rescanCorrections")}
                </Button>
              ) : (
                <Card>
                  <CardContent className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      {t("people.rescanDescription")}
                    </p>
                    <textarea
                      placeholder={t("people.rescanPlaceholder")}
                      value={correctionHint}
                      onChange={(e) => setCorrectionHint(e.target.value)}
                      rows={3}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={() => {
                          if (!correctionHint.trim() || !receiptId) return;
                          setStep("processing");
                          setShowRescan(false);
                          processReceipt.mutate(
                            { receiptId, correctionHint: correctionHint.trim() },
                            {
                              onSuccess: (data) => {
                                setItems([]); // will be refetched
                                setExtracted({
                                  merchantName: data.merchantName ?? undefined,
                                  date: data.date ?? undefined,
                                  subtotal: data.subtotal,
                                  tax: data.tax,
                                  tip: data.tip,
                                  total: data.total,
                                  currency: data.currency,
                                });
                                setAssignments({});
                                setStep("people");
                              },
                              onError: (err) => {
                                setErrorMessage(err.message);
                                setStep("people");
                              },
                            }
                          );
                        }}
                        disabled={!correctionHint.trim()}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {t("people.rescan")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { setShowRescan(false); setCorrectionHint(""); }}
                      >
                        {t("people.cancel")}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Step: Assign */}
      {step === "assign" && extracted && (
        <div className="space-y-4" data-testid="guest-assign-step">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep("people")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-xl font-bold">{t("assign.title")}</h2>
          </div>

          {/* Receipt image toggle */}
          {imagePath && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowImage(!showImage)}
            >
              <ImageIcon className="mr-2 h-4 w-4" />
              {showImage ? t("assign.hideReceipt") : t("assign.viewReceipt")}
            </Button>
          )}

          {showImage && imagePath && (
            <Card>
              <CardContent className="py-3">
                <img
                  src={`/api/uploads/${imagePath}`}
                  alt="Receipt"
                  className="mx-auto max-h-[400px] rounded-md object-contain"
                />
              </CardContent>
            </Card>
          )}

          {/* Receipt summary */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {extracted.merchantName ?? t("assign.receiptSummary")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("assign.subtotal")}</span>
                <span>{formatCents(extracted.subtotal, currency, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("assign.tax")}</span>
                <span>{formatCents(extracted.tax, currency, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("assign.tip")}</span>
                <span>{formatCents(tip, currency, locale)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>{t("assign.total")}</span>
                <span>{formatCents(extracted.subtotal + extracted.tax + tip, currency, locale)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Tip override */}
          <div className="space-y-2">
            <Label htmlFor="guest-tip">{t("assign.tipOverrideLabel")}</Label>
            <Input
              id="guest-tip"
              type="number"
              step="0.01"
              min="0"
              placeholder={t("assign.tipDetected", { amount: (extracted.tip / 100).toFixed(2) })}
              value={tipOverride}
              onChange={(e) => setTipOverride(e.target.value)}
              className="h-12"
            />
          </div>

          {/* Quick actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={assignAllToEveryone} data-testid="guest-split-all-btn">
              <Users className="mr-2 h-4 w-4" />
              {t("assign.splitAllEqually")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddingItem(true)} data-testid="guest-add-item-btn">
              <Plus className="mr-2 h-4 w-4" />
              {t("assign.addItem")}
            </Button>
          </div>

          {/* Add new item form */}
          {addingItem && (
            <Card className="border-primary/50">
              <CardContent className="py-3">
                <form onSubmit={handleAddItem} className="space-y-2">
                  <Input
                    placeholder={t("assign.itemNamePlaceholder")}
                    value={newItem.name}
                    onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                    required
                    className="h-12"
                  />
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder={t("assign.qtyPlaceholder")}
                      value={newItem.quantity}
                      onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                      className="w-20 h-12"
                      min="1"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      placeholder={t("assign.pricePlaceholder")}
                      value={newItem.totalPrice}
                      onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                      className="flex-1 h-12"
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" data-testid="guest-add-item-submit">{t("assign.add")}</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setAddingItem(false)}>{t("assign.cancel")}</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Items with assignment */}
          <div className="space-y-2">
            <Label>{t("assign.tapToAssign", { assigned: assignedCount, total: items.length })}</Label>
            {items.map((item, itemIdx) => {
              const assigned = assignments[itemIdx] ?? new Set();
              const isEditing = editingItem === itemIdx;

              return (
                <Card key={itemIdx} className={assigned.size === 0 ? "border-amber-300" : ""}>
                  <CardContent className="py-3">
                    {isEditing ? (
                      <div className="mb-2 space-y-2">
                        <Input
                          value={editValues.name}
                          onChange={(e) => setEditValues((p) => ({ ...p, name: e.target.value }))}
                          placeholder={t("assign.itemNamePlaceholder")}
                          className="h-12"
                        />
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            value={editValues.quantity}
                            onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                            className="w-20 h-12"
                            placeholder={t("assign.qtyPlaceholder")}
                            min="1"
                          />
                          <Input
                            type="number"
                            step="0.01"
                            value={editValues.totalPrice}
                            onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                            className="flex-1 h-12"
                            placeholder={t("assign.pricePlaceholder")}
                          />
                        </div>
                        <div className="flex gap-1">
                          <Button type="button" size="sm" onClick={saveEdit}>{t("assign.save")}</Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingItem(null)}>{t("assign.cancel")}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{item.name}</span>
                          {item.quantity > 1 && (
                            <span className="text-xs text-muted-foreground">x{item.quantity}</span>
                          )}
                          <button type="button" onClick={() => startEditing(itemIdx)} className="text-muted-foreground hover:text-foreground p-1">
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteItem(itemIdx)}
                            className="text-muted-foreground hover:text-destructive p-1"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                          {item.quantity > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSplittingIndex(itemIdx);
                                setSplitQuantity("1");
                              }}
                              className="text-muted-foreground hover:text-foreground p-1"
                              title={t("assign.split")}
                              aria-label={t("assign.split") + ` ${item.name}`}
                              data-testid={`guest-split-btn-${itemIdx}`}
                            >
                              <Scissors className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <span className="font-semibold">{formatCents(item.totalPrice, currency, locale)}</span>
                      </div>
                    )}
                    {/* Inline split form */}
                    {splittingIndex === itemIdx && (() => {
                      const parsed = Number(splitQuantity);
                      const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                      return (
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{t("assign.splitOff")}</span>
                          <Input
                            type="number"
                            min={1}
                            max={item.quantity - 1}
                            value={splitQuantity}
                            onChange={(e) => setSplitQuantity(e.target.value)}
                            className="w-16 h-7 text-xs"
                            data-testid={`guest-split-qty-${itemIdx}`}
                          />
                          <span className="text-xs text-muted-foreground">{t("assign.splitOfTotal", { total: item.quantity })}</span>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={!validQty}
                            onClick={() => handleSplitItem(itemIdx)}
                            data-testid={`guest-split-submit-${itemIdx}`}
                          >
                            {t("assign.split")}
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSplittingIndex(null)}>
                            {t("assign.cancel")}
                          </Button>
                        </div>
                      );
                    })()}
                    {/* Person toggle buttons */}
                    <div className="flex flex-wrap gap-1.5">
                      {people.map((name, personIdx) => {
                        if (!name.trim()) return null;
                        const isAssigned = assigned.has(personIdx);
                        return (
                          <button
                            key={personIdx}
                            type="button"
                            onClick={() => toggleAssignment(itemIdx, personIdx)}
                            className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm transition-colors min-h-[36px] ${
                              isAssigned
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                            }`}
                          >
                            <Avatar className="h-5 w-5">
                              <AvatarFallback className="text-[9px]">{initials(name)}</AvatarFallback>
                            </Avatar>
                            {name.split(" ")[0]}
                            {isAssigned && <Check className="h-3 w-3" />}
                          </button>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Per-person summary */}
          {perPersonTotals.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t("assign.perPersonTotals")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {perPersonTotals.map((pt) => (
                  <div key={pt.personIndex} className="flex justify-between text-sm">
                    <span>{people[pt.personIndex]?.trim() || t("people.personPlaceholder", { index: pt.personIndex + 1 })}</span>
                    <span className="font-medium">{formatCents(pt.total, currency, locale)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Next button - sticky bottom */}
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
            <div className="mx-auto max-w-lg space-y-3">
              <Button
                className="w-full h-14 text-lg"
                disabled={!allAssigned || createSplit.isPending}
                onClick={handleCreateSplit}
                data-testid="create-split-btn"
              >
                {createSplit.isPending
                  ? t("assign.creatingSplit")
                  : !allAssigned
                    ? t("assign.assignAllItems", { remaining: items.length - assignedCount })
                    : t("assign.createSplitButton")}
                {allAssigned && !createSplit.isPending && <Share2 className="ml-2 h-5 w-5" />}
              </Button>
              <Button
                variant="outline"
                className="w-full h-12"
                disabled={validPeople.length < 1 || createClaimSession.isPending}
                onClick={handleShareForClaiming}
                data-testid="share-for-claiming-btn"
              >
                {createClaimSession.isPending
                  ? t("assign.creatingSession")
                  : t("assign.shareForClaiming")}
                {!createClaimSession.isPending && <Users className="ml-2 h-5 w-5" />}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                {t("assign.shareHint")}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
