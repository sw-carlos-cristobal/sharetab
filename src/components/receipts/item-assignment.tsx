"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useLocale } from "next-intl";
import { trpc } from "@/lib/trpc";
import { formatCents, centsToDecimal, parseToCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Check, Users, Pencil, Trash2, Plus, Image as ImageIcon } from "lucide-react";

type Member = { id: string; name: string | null };

type Assignments = Record<string, Set<string>>; // receiptItemId -> Set<userId>

export function ItemAssignment({
  groupId,
  receiptId,
  members,
  onComplete,
}: {
  groupId: string;
  receiptId: string;
  members: Member[];
  onComplete: () => void;
}) {
  const locale = useLocale();
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

  // Initialize title from merchant name when data loads
  useMemo(() => {
    if (receiptData.data?.receipt.extractedData?.merchantName && !title) {
      setTitle(receiptData.data.receipt.extractedData.merchantName);
    }
  }, [receiptData.data, title]);

  if (receiptData.isLoading) {
    return <p className="text-muted-foreground">Loading items...</p>;
  }

  if (!receiptData.data) {
    return <p className="text-destructive">Could not load receipt data.</p>;
  }

  const { receipt, items } = receiptData.data;
  const extracted = receipt.extractedData;
  if (!extracted) {
    return <p className="text-destructive">No extracted data available.</p>;
  }

  const tip = tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : extracted.tip;

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
    const totalPrice = parseToCents(editValues.totalPrice);
    const quantity = parseInt(editValues.quantity) || 1;
    updateItem.mutate({
      itemId,
      name: editValues.name,
      quantity,
      totalPrice,
      unitPrice: Math.round(totalPrice / quantity),
    });
  }

  function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    const totalPrice = parseToCents(newItem.totalPrice);
    const quantity = parseInt(newItem.quantity) || 1;
    if (!newItem.name || totalPrice <= 0) return;
    addItem.mutate({
      receiptId,
      name: newItem.name,
      quantity,
      unitPrice: Math.round(totalPrice / quantity),
      totalPrice,
    });
  }

  // Calculate per-person totals
  function getPerPersonTotals(): Map<string, number> {
    const userSubtotals = new Map<string, number>();

    for (const item of items) {
      const assigned = assignments[item.id];
      if (!assigned || assigned.size === 0) continue;

      const perPerson = Math.floor(item.totalPrice / assigned.size);
      const remainder = item.totalPrice - perPerson * assigned.size;
      const userIds = Array.from(assigned);

      for (let i = 0; i < userIds.length; i++) {
        const amount = perPerson + (i < remainder ? 1 : 0);
        userSubtotals.set(userIds[i], (userSubtotals.get(userIds[i]) ?? 0) + amount);
      }
    }

    const actualSubtotal = Array.from(userSubtotals.values()).reduce((a, b) => a + b, 0);
    const totalAmount = actualSubtotal + extracted!.tax + tip;

    const userTotals = new Map<string, number>();
    let allocated = 0;
    const entries = Array.from(userSubtotals.entries());

    for (let i = 0; i < entries.length; i++) {
      const [userId, itemTotal] = entries[i];
      if (i === entries.length - 1) {
        userTotals.set(userId, totalAmount - allocated);
      } else {
        const proportion = actualSubtotal > 0 ? itemTotal / actualSubtotal : 0;
        const userTax = Math.round(extracted!.tax * proportion);
        const userTip = Math.round(tip * proportion);
        const total = itemTotal + userTax + userTip;
        userTotals.set(userId, total);
        allocated += total;
      }
    }

    return userTotals;
  }

  const perPersonTotals = getPerPersonTotals();
  const assignedItemCount = Object.values(assignments).filter((s) => s.size > 0).length;
  const allAssigned = assignedItemCount === items.length;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!paidById || !allAssigned) return;

    createExpense.mutate({
      groupId,
      receiptId,
      title,
      paidById,
      tipOverride: tipOverride !== "" ? Math.round(parseFloat(tipOverride) * 100) : undefined,
      assignments: Object.entries(assignments)
        .filter(([, userIds]) => userIds.size > 0)
        .map(([receiptItemId, userIds]) => ({
          receiptItemId,
          userIds: Array.from(userIds),
        })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Receipt image toggle */}
      {receipt.imagePath && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowImage(!showImage)}
        >
          <ImageIcon className="mr-2 h-4 w-4" />
          {showImage ? "Hide Receipt Image" : "View Receipt Image"}
        </Button>
      )}

      {showImage && receipt.imagePath && (
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
                src={`/api/uploads/${receipt.imagePath}`}
                alt="Receipt"
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
                  Reset view
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Receipt summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Receipt Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {extracted.merchantName && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Merchant</span>
              <span>{extracted.merchantName}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCents(extracted.subtotal, extracted.currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tax</span>
            <span>{formatCents(extracted.tax, extracted.currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tip</span>
            <span>{formatCents(tip, extracted.currency, locale)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCents(extracted.subtotal + extracted.tax + tip, extracted.currency, locale)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Expense details */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-2">
            <Label htmlFor="title">Expense title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Dinner at Restaurant"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="paidBy">Paid by</Label>
            <select
              id="paidBy"
              value={paidById}
              onChange={(e) => setPaidById(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              <option value="">Select member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? "Unnamed"}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tip">Tip override (optional)</Label>
            <Input
              id="tip"
              type="number"
              step="0.01"
              min="0"
              placeholder={`Detected: ${(extracted.tip / 100).toFixed(2)}`}
              value={tipOverride}
              onChange={(e) => setTipOverride(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Quick actions */}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={assignAllToEveryone}>
          <Users className="mr-2 h-4 w-4" />
          Split all equally
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAddingItem(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add item
        </Button>
      </div>

      {/* Add new item form */}
      {addingItem && (
        <Card className="border-primary/50">
          <CardContent className="py-3">
            <form onSubmit={handleAddItem} className="space-y-2">
              <div className="flex gap-2">
                <Input
                  placeholder="Item name"
                  value={newItem.name}
                  onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                  required
                  className="flex-1"
                />
                <Input
                  type="number"
                  placeholder="Qty"
                  value={newItem.quantity}
                  onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                  className="w-16"
                  min="1"
                />
                <Input
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={newItem.totalPrice}
                  onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                  className="w-24"
                  required
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={addItem.isPending}>
                  {addItem.isPending ? "Adding..." : "Add"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAddingItem(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Item assignment */}
      <div className="space-y-2">
        <Label>Assign items ({assignedItemCount}/{items.length} assigned)</Label>
        {items.map((item) => {
          const assigned = assignments[item.id] ?? new Set();
          const isEditing = editingItem === item.id;

          return (
            <Card key={item.id} className={assigned.size === 0 ? "border-amber-300" : ""}>
              <CardContent className="py-3">
                {isEditing ? (
                  <div className="mb-2 space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={editValues.name}
                        onChange={(e) => setEditValues((p) => ({ ...p, name: e.target.value }))}
                        className="flex-1"
                        placeholder="Item name"
                      />
                      <Input
                        type="number"
                        value={editValues.quantity}
                        onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                        className="w-16"
                        placeholder="Qty"
                        min="1"
                      />
                      <Input
                        type="number"
                        step="0.01"
                        value={editValues.totalPrice}
                        onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                        className="w-24"
                        placeholder="Price"
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button type="button" size="sm" onClick={() => saveEdit(item.id)} disabled={updateItem.isPending}>
                        Save
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditingItem(null)}>
                        Cancel
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
                          if (confirm(`Remove "${item.name}"?`)) {
                            deleteItem.mutate({ itemId: item.id });
                          }
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <span className="font-semibold">
                      {formatCents(item.totalPrice, extracted.currency, locale)}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {members.map((m) => {
                    const isAssigned = assigned.has(m.id);
                    const initials = m.name
                      ? m.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")
                          .toUpperCase()
                          .slice(0, 2)
                      : "?";
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleAssignment(item.id, m.id)}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                          isAssigned
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:bg-muted/80"
                        }`}
                      >
                        <Avatar className="h-4 w-4">
                          <AvatarFallback className="text-[8px]">
                            {initials}
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Per-person totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {members.map((m) => {
              const total = perPersonTotals.get(m.id);
              if (!total) return null;
              return (
                <div key={m.id} className="flex justify-between text-sm">
                  <span>{m.name ?? "Unnamed"}</span>
                  <span className="font-medium">
                    {formatCents(total, extracted.currency, locale)}
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
      >
        {createExpense.isPending
          ? "Creating expense..."
          : !allAssigned
            ? `Assign all items (${items.length - assignedItemCount} remaining)`
            : "Create Expense from Receipt"}
      </Button>
    </form>
  );
}
