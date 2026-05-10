"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc";
import { formatCents, centsToDecimal, parseToCents } from "@/lib/money";
import { calculateSplitTotals } from "@/lib/split-calculator";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Check, Users, Pencil, Trash2, Plus, Image as ImageIcon, Scissors, Bookmark } from "lucide-react";
import { toast } from "sonner";

type Member = { id: string; name: string | null };

type Assignments = Record<string, Set<string>>; // receiptItemId -> Set<userId>

export function ItemAssignment({
  groupId,
  receiptId,
  members,
  onComplete,
  onSaveForLater,
}: {
  groupId: string;
  receiptId: string;
  members: Member[];
  onComplete: () => void;
  onSaveForLater?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("expenses.receipt");
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId });
  const utils = trpc.useUtils();

  const [assignments, setAssignments] = useState<Assignments>({});
  const [title, setTitle] = useState("");
  const [paidById, setPaidById] = useState("");
  const [tipOverride, setTipOverride] = useState<string>("");
  const [showImage, setShowImage] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastTouchDist = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ name: string; quantity: string; totalPrice: string }>({ name: "", quantity: "", totalPrice: "" });
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({ name: "", quantity: "1", totalPrice: "" });
  const [splittingItem, setSplittingItem] = useState<string | null>(null);
  const [splitQuantity, setSplitQuantity] = useState("");

  const createExpense = trpc.receipts.assignItemsAndCreateExpense.useMutation({
    onSuccess: onComplete,
  });
  const updateItem = trpc.receipts.updateItem.useMutation({
    onSuccess: () => {
      setEditingItem(null);
      utils.receipts.getReceiptItems.invalidate({ receiptId });
    },
  });
  const deleteItem = trpc.receipts.deleteItem.useMutation({
    onSuccess: () => utils.receipts.getReceiptItems.invalidate({ receiptId }),
  });
  const addItem = trpc.receipts.addItem.useMutation({
    onSuccess: () => {
      setAddingItem(false);
      setNewItem({ name: "", quantity: "1", totalPrice: "" });
      utils.receipts.getReceiptItems.invalidate({ receiptId });
    },
  });
  const splitItem = trpc.receipts.splitItem.useMutation({
    onSuccess: () => utils.receipts.getReceiptItems.invalidate({ receiptId }),
  });
  const saveForLater = trpc.receipts.saveForLater.useMutation({
    onSuccess: () => onSaveForLater?.(),
  });

  // Reset zoom/pan when image is hidden
  useEffect(() => {
    if (!showImage) { setZoom(1); setPan({ x: 0, y: 0 }); }
  }, [showImage]);

  // Wheel zoom — must be non-passive to call preventDefault
  useEffect(() => {
    const el = imageContainerRef.current;
    if (!el || !showImage) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => Math.min(Math.max(z * factor, 1), 5));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [showImage]);

  // Restore saved state (paidById, assignments) when receipt data loads.
  // Runs on every data change but only sets state when server data has values
  // and local state hasn't been set yet. This handles the case where the first
  // render gets cached data (without paidById) and the refetch brings fresh data.
  const hasRestoredRef = useRef(false);

  /* eslint-disable react-hooks/set-state-in-effect -- init from async query data */
  useEffect(() => {
    if (!receiptData.data || hasRestoredRef.current) return;
    const data = receiptData.data;

    if (data.receipt.extractedData?.merchantName && !title) {
      setTitle(data.receipt.extractedData.merchantName);
    }

    const hasSavedPaidBy = !!data.receipt.paidById;
    const hasSavedAssignments = data.items.some(
      (item: { assignments?: unknown[] }) => item.assignments && item.assignments.length > 0
    );

    if (hasSavedPaidBy || hasSavedAssignments) {
      if (hasSavedPaidBy) {
        setPaidById(data.receipt.paidById!);
      }
      const restored: Assignments = {};
      for (const item of data.items) {
        if (item.assignments && item.assignments.length > 0) {
          restored[item.id] = new Set(item.assignments.map((a: { userId: string }) => a.userId));
        }
      }
      if (Object.keys(restored).length > 0) {
        setAssignments(restored);
      }
      hasRestoredRef.current = true;
    }
  }, [receiptData.data]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { receipt, items } = receiptData.data ?? { receipt: null, items: [] };
  const extracted = receipt?.extractedData ?? null;
  const parsedTip = parseFloat(tipOverride);
  const tip = extracted && tipOverride !== "" && isFinite(parsedTip) ? Math.round(parsedTip * 100) : (extracted?.tip ?? 0);

  // Note (Finding #29): toggleAssignment and assignAllToEveryone are intentionally
  // duplicated from split/page.tsx. This component uses Record<string, Set<string>>
  // (id-based) while split/page uses Record<number, Set<number>> (index-based).
  // The different key types make a shared abstraction more complex than the duplication.
  function toggleAssignment(itemId: string, userId: string) {
    setAssignments((prev) => {
      const next = { ...prev };
      const current = new Set(next[itemId] ?? []);
      if (current.has(userId)) {
        current.delete(userId);
      } else {
        current.add(userId);
      }
      next[itemId] = current;
      return next;
    });
  }

  function assignAllToEveryone() {
    const next: Assignments = {};
    for (const item of items) {
      next[item.id] = new Set(members.map((m) => m.id));
    }
    setAssignments(next);
  }

  function startEditing(item: { id: string; name: string; quantity: number; totalPrice: number }) {
    setEditingItem(item.id);
    setEditValues({
      name: item.name,
      quantity: String(item.quantity),
      totalPrice: centsToDecimal(item.totalPrice),
    });
  }

  function saveEdit(itemId: string) {
    const trimmedName = editValues.name.trim();
    if (!trimmedName) { toast.error(t("validationNameRequired")); return; }
    const totalPrice = parseToCents(editValues.totalPrice);
    if (totalPrice <= 0) { toast.error(t("validationPricePositive")); return; }
    const quantity = parseInt(editValues.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) { toast.error(t("validationQtyPositive")); return; }
    updateItem.mutate({
      itemId,
      name: trimmedName,
      quantity,
      totalPrice,
      unitPrice: Math.round(totalPrice / quantity),
    });
  }

  function handleAddItem() {
    const totalPrice = parseToCents(newItem.totalPrice);
    const quantity = parseInt(newItem.quantity) || 1;
    if (!newItem.name.trim() || totalPrice <= 0 || quantity < 1) return;
    addItem.mutate({
      receiptId,
      name: newItem.name,
      quantity,
      unitPrice: Math.round(totalPrice / quantity),
      totalPrice,
    });
  }

  // Calculate per-person totals using shared calculateSplitTotals (Finding #30).
  // Memoized to avoid recomputation on every render (Finding #36).
  const perPersonTotals = useMemo(() => {
    // Build member-id -> index mapping for calculateSplitTotals
    const memberIdToIndex = new Map<string, number>();
    members.forEach((m, i) => memberIdToIndex.set(m.id, i));

    const assignmentList = Object.entries(assignments)
      .filter(([, userIds]) => userIds.size > 0)
      .map(([receiptItemId, userIds]) => {
        const itemIdx = items.findIndex((it) => it.id === receiptItemId);
        return {
          itemIndex: itemIdx,
          personIndices: Array.from(userIds)
            .map((uid) => memberIdToIndex.get(uid))
            .filter((idx): idx is number => idx !== undefined),
        };
      })
      .filter((a) => a.itemIndex >= 0 && a.personIndices.length > 0);

    const results = calculateSplitTotals({
      items,
      assignments: assignmentList,
      tax: extracted?.tax ?? 0,
      tip,
      peopleCount: members.length,
    });

    // Map back from person indices to member IDs
    const totals = new Map<string, number>();
    for (const r of results) {
      const member = members[r.personIndex];
      if (member) totals.set(member.id, r.total);
    }
    return totals;
  }, [items, assignments, members, extracted, tip]);
  const assignedItemCount = Object.values(assignments).filter((s) => s.size > 0).length;
  const allAssigned = items.length > 0 && assignedItemCount === items.length;

  // Precompute member initials to avoid recalculation every render (Finding #37)
  const memberInitials = useMemo(
    () =>
      new Map(
        members.map((m) => [
          m.id,
          m.name
            ? m.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
            : "?",
        ])
      ),
    [members]
  );

  if (receiptData.isLoading) {
    return <p className="text-muted-foreground">{t("loadingItems")}</p>;
  }
  if (!receiptData.data) {
    return <p className="text-destructive">{t("noReceiptData")}</p>;
  }
  if (!extracted) {
    return <p className="text-destructive">{t("noExtractedData")}</p>;
  }

  // After early returns, these are guaranteed non-null
  const safeReceipt = receipt!;
  const safeExtracted = extracted;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || !allAssigned) return;

    createExpense.mutate({
      groupId,
      receiptId,
      title,
      paidById,
      tipOverride: tipOverride !== "" && isFinite(parseFloat(tipOverride)) ? Math.round(parseFloat(tipOverride) * 100) : undefined,
      assignments: Object.entries(assignments)
        .filter(([, userIds]) => userIds.size > 0)
        .map(([receiptItemId, userIds]) => ({
          receiptItemId,
          userIds: Array.from(userIds),
        })),
    });
  }

  function handleSaveForLater() {
    saveForLater.mutate({
      groupId,
      receiptId,
      paidById: paidById || null,
      assignments: Object.entries(assignments)
        .filter(([, userIds]) => userIds.size > 0)
        .map(([receiptItemId, userIds]) => ({
          receiptItemId,
          userIds: Array.from(userIds),
        })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="item-assignment-form">
      {/* Receipt image toggle */}
      {safeReceipt.imagePath && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowImage(!showImage)}
        >
          <ImageIcon className="mr-2 h-4 w-4" />
          {showImage ? t("hideImage") : t("viewImage")}
        </Button>
      )}

      {showImage && safeReceipt.imagePath && (
        <Card>
          <CardContent className="p-0 overflow-hidden rounded-lg">
            <div
              ref={imageContainerRef}
              className="relative overflow-hidden rounded-t-lg bg-muted/30"
              style={{
                height: 400,
                cursor: isDragging ? "grabbing" : "grab",
                touchAction: "none",
                userSelect: "none",
              }}
              onMouseDown={(e) => {
                setIsDragging(true);
                dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
              }}
              onMouseMove={(e) => {
                if (!isDragging || !dragStart.current) return;
                setPan({
                  x: dragStart.current.panX + e.clientX - dragStart.current.x,
                  y: dragStart.current.panY + e.clientY - dragStart.current.y,
                });
              }}
              onMouseUp={() => { setIsDragging(false); dragStart.current = null; }}
              onMouseLeave={() => { setIsDragging(false); dragStart.current = null; }}
              onDoubleClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
              onTouchStart={(e) => {
                if (e.touches.length === 2) {
                  const dx = e.touches[0].clientX - e.touches[1].clientX;
                  const dy = e.touches[0].clientY - e.touches[1].clientY;
                  lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
                } else {
                  dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX: pan.x, panY: pan.y };
                }
              }}
              onTouchMove={(e) => {
                if (e.touches.length === 2 && lastTouchDist.current !== null) {
                  const dx = e.touches[0].clientX - e.touches[1].clientX;
                  const dy = e.touches[0].clientY - e.touches[1].clientY;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  const factor = dist / lastTouchDist.current;
                  setZoom((z) => Math.min(Math.max(z * factor, 1), 5));
                  lastTouchDist.current = dist;
                } else if (e.touches.length === 1 && dragStart.current) {
                  setPan({
                    x: dragStart.current.panX + e.touches[0].clientX - dragStart.current.x,
                    y: dragStart.current.panY + e.touches[0].clientY - dragStart.current.y,
                  });
                }
              }}
              onTouchEnd={() => { lastTouchDist.current = null; dragStart.current = null; }}
            >
              <img
                src={`/api/uploads/${safeReceipt.imagePath}`}
                alt={t("receiptImageAlt")}
                draggable={false}
                className="h-full w-full object-contain pointer-events-none"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center center",
                  transition: isDragging ? "none" : "transform 0.05s ease-out",
                }}
              />
            </div>
            {zoom > 1 && (
              <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground border-t">
                <span>{Math.round(zoom * 100)}%</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                >
                  {t("resetView")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Receipt summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("receiptSummary")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {safeExtracted.merchantName && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("merchant")}</span>
              <span>{safeExtracted.merchantName}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("subtotal")}</span>
            <span>{formatCents(safeExtracted.subtotal, safeExtracted.currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("tax")}</span>
            <span>{formatCents(safeExtracted.tax, safeExtracted.currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("tip")}</span>
            <span>{formatCents(tip, safeExtracted.currency, locale)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>{t("total")}</span>
            <span>{formatCents(safeExtracted.subtotal + safeExtracted.tax + tip, safeExtracted.currency, locale)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Expense details */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-2">
            <Label htmlFor="title">{t("expenseTitle")}</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("expenseTitlePlaceholder")}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="paidBy">{t("paidBy")}</Label>
            <select
              id="paidBy"
              value={paidById}
              onChange={(e) => setPaidById(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              data-testid="paid-by-select"
            >
              <option value="">{t("selectMember")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? t("unnamed")}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tip">{t("tipOverride")}</Label>
            <Input
              id="tip"
              type="number"
              step="0.01"
              min="0"
              placeholder={t("tipDetected", { amount: formatCents(safeExtracted.tip, safeExtracted.currency, locale) })}
              value={tipOverride}
              onChange={(e) => setTipOverride(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Quick actions */}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={assignAllToEveryone} data-testid="split-all-btn">
          <Users className="mr-2 h-4 w-4" />
          {t("splitAllEqually")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAddingItem(true)}
          data-testid="add-item-btn"
        >
          <Plus className="mr-2 h-4 w-4" />
          {t("addItem")}
        </Button>
      </div>

      {/* Add new item form */}
      {addingItem && (
        <Card className="border-primary/50" data-testid="add-item-form">
          <CardContent className="py-3">
            <div className="space-y-2" onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !addItem.isPending) { e.preventDefault(); handleAddItem(); } }}>
              <div className="flex gap-2">
                <Input
                  placeholder={t("itemNamePlaceholder")}
                  value={newItem.name}
                  onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                  className="flex-1"
                />
                <Input
                  type="number"
                  placeholder={t("qtyPlaceholder")}
                  value={newItem.quantity}
                  onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                  className="w-16"
                  min="1"
                />
                <Input
                  type="number"
                  step="0.01"
                  placeholder={t("pricePlaceholder")}
                  value={newItem.totalPrice}
                  onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                  className="w-24"
                />
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={addItem.isPending} onClick={handleAddItem}>
                  {addItem.isPending ? t("adding") : t("add")}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAddingItem(false)}>
                  {t("cancel")}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Item assignment */}
      <div className="space-y-2">
        <Label>{t("assignItems", { assigned: assignedItemCount, total: items.length })}</Label>
        {items.map((item) => {
          const assigned = assignments[item.id] ?? new Set();
          const isEditing = editingItem === item.id;

          return (
            <Card key={item.id} className={assigned.size === 0 ? "border-amber-300" : ""} data-testid={`item-card-${item.id}`}>
              <CardContent className="py-3">
                {isEditing ? (
                  <div className="mb-2 space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={editValues.name}
                        onChange={(e) => setEditValues((p) => ({ ...p, name: e.target.value }))}
                        className="flex-1"
                        placeholder={t("itemNamePlaceholder")}
                      />
                      <Input
                        type="number"
                        value={editValues.quantity}
                        onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                        className="w-16"
                        placeholder={t("qtyPlaceholder")}
                        min="1"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        value={editValues.totalPrice}
                        onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                        className="w-24"
                        placeholder={t("pricePlaceholder")}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button type="button" size="sm" onClick={() => saveEdit(item.id)} disabled={updateItem.isPending}>
                        {t("save")}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditingItem(null)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{item.name}</span>
                      {item.quantity > 1 && (
                        <span className="text-xs text-muted-foreground">
                          x{item.quantity}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => startEditing(item)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t("removeConfirm", { name: item.name }))) {
                            deleteItem.mutate({ itemId: item.id });
                          }
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      {item.quantity > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            setSplittingItem(item.id);
                            setSplitQuantity("1");
                          }}
                          className="text-muted-foreground hover:text-foreground"
                          title={t("split")}
                          aria-label={t("splitAriaLabel", { name: item.name })}
                          data-testid={`split-btn-${item.id}`}
                        >
                          <Scissors className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <span className="font-semibold">
                      {formatCents(item.totalPrice, safeExtracted.currency, locale)}
                    </span>
                  </div>
                )}
                {!isEditing && splittingItem === item.id && (() => {
                  const parsed = Number(splitQuantity);
                  const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                  return (
                    <div className="mb-2 flex items-center gap-2" data-testid="split-form">
                      <span className="text-xs text-muted-foreground">{t("splitOff")}</span>
                      <Input
                        type="number"
                        min={1}
                        max={item.quantity - 1}
                        value={splitQuantity}
                        onChange={(e) => setSplitQuantity(e.target.value)}
                        className="w-16 h-7 text-xs"
                        data-testid="split-qty-input"
                      />
                      <span className="text-xs text-muted-foreground">{t("splitOfTotal", { total: item.quantity })}</span>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={splitItem.isPending || !validQty}
                        data-testid="split-submit"
                        onClick={() => {
                          if (!validQty) return;
                          splitItem.mutate({ itemId: item.id, splitQuantity: parsed });
                          setSplittingItem(null);
                        }}
                      >
                        {t("split")}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSplittingItem(null)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  );
                })()}
                <div className="flex flex-wrap gap-1.5">
                  {members.map((m) => {
                    const isAssigned = assigned.has(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleAssignment(item.id, m.id)}
                        data-testid={`member-toggle-${m.id}`}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                          isAssigned
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        <Avatar className="h-4 w-4">
                          <AvatarFallback className="text-[8px]">
                            {memberInitials.get(m.id) ?? "?"}
                          </AvatarFallback>
                        </Avatar>
                        {m.name?.split(" ")[0] ?? "?"}
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
      {perPersonTotals.size > 0 && (
        <Card data-testid="per-person-totals">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("perPersonTotals")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {members.map((m) => {
              const total = perPersonTotals.get(m.id);
              if (!total) return null;
              return (
                <div key={m.id} className="flex justify-between text-sm">
                  <span>{m.name ?? t("unnamed")}</span>
                  <span className="font-medium">
                    {formatCents(total, safeExtracted.currency, locale)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {createExpense.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {createExpense.error.message}
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={createExpense.isPending || !allAssigned || !paidById}
        data-testid="create-expense-btn"
      >
        {createExpense.isPending
          ? t("creatingExpense")
          : !allAssigned
            ? t("assignAllItems", { remaining: items.length - assignedItemCount })
            : t("createExpense")}
      </Button>

      {onSaveForLater && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleSaveForLater}
          disabled={saveForLater.isPending}
          data-testid="save-for-later-btn"
        >
          <Bookmark className="mr-2 h-4 w-4" />
          {saveForLater.isPending ? t("saving") : t("saveForLater")}
        </Button>
      )}
    </form>
  );
}
