"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  Share2, Copy, Pencil, Image as ImageIcon, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

type Step = "upload" | "processing" | "people" | "assign" | "review";

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
  const [step, setStep] = useState<Step>("upload");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);

  // Data
  const [items, setItems] = useState<GuestItem[]>([]);
  const [extracted, setExtracted] = useState<ExtractedData | null>(null);
  const [people, setPeople] = useState<string[]>([""]); // start with one empty name
  const [newPersonName, setNewPersonName] = useState("");
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

  // tRPC
  const processReceipt = trpc.guest.processReceipt.useMutation();
  const providerInfo = trpc.guest.getScanProviderInfo.useQuery();
  const receiptData = trpc.guest.getReceiptItems.useQuery(
    { receiptId: receiptId! },
    { enabled: !!receiptId && step === "people" }
  );
  const createSplit = trpc.guest.createSplit.useMutation();

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
        const data = await res.json();
        throw new Error(data.error ?? "Upload failed");
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

  // People management
  function addPerson() {
    const name = newPersonName.trim();
    if (!name) return;
    setPeople((p) => [...p, name]);
    setNewPersonName("");
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
    const next: Record<number, Set<number>> = {};
    for (let i = 0; i < items.length; i++) {
      next[i] = new Set(people.map((_, idx) => idx));
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

  const perPersonTotals = step === "assign" || step === "review" ? getPerPersonTotals() : [];
  const assignedCount = Object.values(assignments).filter((s) => s.size > 0).length;
  const allAssigned = assignedCount === items.length && items.length > 0;
  const validPeople = people.filter((n) => n.trim().length > 0);

  async function handleCreateSplit() {
    if (!extracted || !allAssigned || validPeople.length < 1) return;

    const assignmentList = Object.entries(assignments)
      .filter(([, s]) => s.size > 0)
      .map(([itemIdx, personSet]) => ({
        itemIndex: parseInt(itemIdx),
        personIndices: Array.from(personSet),
      }));

    try {
      const result = await createSplit.mutateAsync({
        receiptId: receiptId ?? undefined,
        receiptData: { ...extracted, tip },
        items,
        people: validPeople.map((n) => ({ name: n })),
        assignments: assignmentList,
        paidByIndex,
        tipOverride: tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : undefined,
      });
      router.push(`/split/${result.shareToken}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create split");
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
            <h1 className="text-3xl font-bold tracking-tight">Split a bill</h1>
            <p className="text-muted-foreground">
              Snap a photo of your receipt. No account needed.
            </p>
          </div>

          {errorMessage && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {/* Camera capture button - mobile optimized */}
          <label className="flex flex-col items-center gap-4 rounded-2xl bg-primary p-8 text-primary-foreground cursor-pointer active:scale-[0.98] transition-transform">
            <div className="rounded-full bg-primary-foreground/20 p-4">
              <Camera className="h-10 w-10" />
            </div>
            <span className="text-xl font-semibold">Snap a Bill</span>
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
              Or
            </span>
          </div>

          {/* Gallery upload */}
          <label className="flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed border-muted-foreground/25 p-8 cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.98]">
            <div className="rounded-full bg-muted p-4">
              <ImageIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <span className="text-lg font-medium text-muted-foreground">Choose from Gallery</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              onChange={handleFileUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>

          {uploading && (
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Uploading...
            </div>
          )}
        </div>
      )}

      {/* Step: Processing */}
      {step === "processing" && (
        <div className="flex flex-col items-center justify-center gap-6 py-20">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <div className="text-center space-y-2 max-w-xs">
            <p className="font-semibold text-lg">Processing receipt...</p>
            <p className="text-sm text-muted-foreground animate-fade-in">
              {loadingMessages[loadingMsgIdx]}
            </p>
            <p className="text-xs text-muted-foreground">
              Active provider: <span className="font-medium text-foreground">{activeProvider}</span>
              {" · "}Fallback chain: <span className="font-medium text-foreground">{configuredProviderChain}</span>
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
            <h2 className="text-xl font-bold">Who&apos;s splitting?</h2>
          </div>

          <p className="text-sm text-muted-foreground">
            Add the names of everyone sharing this bill.
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
                  placeholder={`Person ${idx + 1}`}
                  className="h-12 text-base"
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
          >
            <Plus className="mr-2 h-4 w-4" />
            Add person
          </Button>

          {/* Who paid? */}
          <div className="space-y-2">
            <Label>Who paid the bill?</Label>
            <select
              value={paidByIndex}
              onChange={(e) => setPaidByIndex(parseInt(e.target.value))}
              className="flex h-12 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm"
            >
              {people.map((name, idx) => (
                <option key={idx} value={idx}>
                  {name.trim() || `Person ${idx + 1}`}
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
              >
                Next: Assign Items
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
              {!showRescan ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setShowRescan(true)}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Rescan with corrections
                </Button>
              ) : (
                <Card>
                  <CardContent className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      Describe what needs to be corrected and AI will re-scan the receipt.
                    </p>
                    <textarea
                      placeholder='e.g., "The total should be $45.99" or "There are 3 tacos, not 1"'
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
                        Rescan
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { setShowRescan(false); setCorrectionHint(""); }}
                      >
                        Cancel
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
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setStep("people")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-xl font-bold">Assign items</h2>
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
              {showImage ? "Hide Receipt" : "View Receipt"}
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
                {extracted.merchantName ?? "Receipt Summary"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCents(extracted.subtotal, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span>{formatCents(extracted.tax, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tip</span>
                <span>{formatCents(tip, currency)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span>{formatCents(extracted.subtotal + extracted.tax + tip, currency)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Tip override */}
          <div className="space-y-2">
            <Label htmlFor="guest-tip">Tip override (optional)</Label>
            <Input
              id="guest-tip"
              type="number"
              step="0.01"
              min="0"
              placeholder={`Detected: ${(extracted.tip / 100).toFixed(2)}`}
              value={tipOverride}
              onChange={(e) => setTipOverride(e.target.value)}
              className="h-12"
            />
          </div>

          {/* Quick actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={assignAllToEveryone}>
              <Users className="mr-2 h-4 w-4" />
              Split all equally
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAddingItem(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add item
            </Button>
          </div>

          {/* Add new item form */}
          {addingItem && (
            <Card className="border-primary/50">
              <CardContent className="py-3">
                <form onSubmit={handleAddItem} className="space-y-2">
                  <Input
                    placeholder="Item name"
                    value={newItem.name}
                    onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                    required
                    className="h-12"
                  />
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="Qty"
                      value={newItem.quantity}
                      onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                      className="w-20 h-12"
                      min="1"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Price"
                      value={newItem.totalPrice}
                      onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                      className="flex-1 h-12"
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm">Add</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setAddingItem(false)}>Cancel</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Items with assignment */}
          <div className="space-y-2">
            <Label>Tap people to assign ({assignedCount}/{items.length})</Label>
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
                          placeholder="Item name"
                          className="h-12"
                        />
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            value={editValues.quantity}
                            onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                            className="w-20 h-12"
                            placeholder="Qty"
                            min="1"
                          />
                          <Input
                            type="number"
                            step="0.01"
                            value={editValues.totalPrice}
                            onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                            className="flex-1 h-12"
                            placeholder="Price"
                          />
                        </div>
                        <div className="flex gap-1">
                          <Button type="button" size="sm" onClick={saveEdit}>Save</Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingItem(null)}>Cancel</Button>
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
                        </div>
                        <span className="font-semibold">{formatCents(item.totalPrice, currency)}</span>
                      </div>
                    )}
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
                <CardTitle className="text-base">Per-person totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {perPersonTotals.map((t) => (
                  <div key={t.personIndex} className="flex justify-between text-sm">
                    <span>{people[t.personIndex]?.trim() || `Person ${t.personIndex + 1}`}</span>
                    <span className="font-medium">{formatCents(t.total, currency)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Next button - sticky bottom */}
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
            <div className="mx-auto max-w-lg">
              <Button
                className="w-full h-14 text-lg"
                disabled={!allAssigned || createSplit.isPending}
                onClick={handleCreateSplit}
              >
                {createSplit.isPending
                  ? "Creating split..."
                  : !allAssigned
                    ? `Assign all items (${items.length - assignedCount} left)`
                    : "Create Split & Get Link"}
                {allAssigned && !createSplit.isPending && <Share2 className="ml-2 h-5 w-5" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
