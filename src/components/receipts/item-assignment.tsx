'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import {
  amountInputStep,
  formatCents,
  centsToDecimal,
  convertAmount,
  currencyStep,
  editedAmount,
  parseToCents,
} from '@/lib/money';
import { calculateReceiptSplitTotals, receiptAssignmentList } from '@/lib/split-calculator';
import { COMMON_CURRENCIES } from '@/lib/currencies';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { chipLabels } from '@/lib/avatar';
import { Check, Users, Pencil, Trash2, Plus, Image as ImageIcon, Scissors, Bookmark } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';

type Member = { id: string; name: string | null };

type Assignments = Record<string, Set<string>>; // receiptItemId -> Set<userId>

export function ItemAssignment({
  groupId,
  groupCurrency,
  receiptId,
  members,
  onComplete,
  onSaveForLater,
}: {
  groupId: string;
  groupCurrency: string;
  receiptId: string;
  members: Member[];
  onComplete: () => void;
  onSaveForLater?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations('expenses.receipt');
  // The currency and rate fields say what the expense form's do
  const tNew = useTranslations('expenses.new');
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId });
  // Who tRPC acts as: the impersonated user while an admin impersonates, where
  // useSession() would still report the admin
  const profile = trpc.auth.getProfile.useQuery();
  const utils = trpc.useUtils();

  const [assignments, setAssignments] = useState<Assignments>({});
  const [title, setTitle] = useState('');
  const [paidById, setPaidById] = useState('');
  const [tipOverride, setTipOverride] = useState<string>('');
  const [showImage, setShowImage] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastTouchDist = useRef<number | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ name: string; quantity: string; totalPrice: string }>({
    name: '',
    quantity: '',
    totalPrice: '',
  });
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', quantity: '1', totalPrice: '' });
  const [splittingItem, setSplittingItem] = useState<string | null>(null);
  const [splitQuantity, setSplitQuantity] = useState('');
  const [removeItem, setRemoveItem] = useState<{ id: string; name: string } | null>(null);
  // A rate entered by hand, for the currency it was typed for: once the receipt's currency changes
  // (here or on another device) it no longer applies (#361)
  const [useManualRate, setUseManualRate] = useState(false);
  const [manualRate, setManualRate] = useState({ currency: '', text: '' });

  // A refused Create, Save for later or item delete may mean the receipt changed since the page loaded it (an
  // item added, deleted or repriced), so load it again to show what's there now. Not awaited: the
  // mutation reports its error once onError returns
  function reloadAfterError() {
    void utils.receipts.getReceiptItems.invalidate({ receiptId });
  }
  const createExpense = trpc.receipts.assignItemsAndCreateExpense.useMutation({
    onSuccess: onComplete,
    onError: (e) => {
      // No rate could be found for the receipt's currency: ask for one, with the checkbox and field the expense form has (#361)
      if (e.data?.messageKey === 'exchangeRateUnavailable') setUseManualRate(true);
      reloadAfterError();
    },
  });
  // Saved on the receipt (#361). Pending until the receipt has reloaded, so the selector doesn't
  // show the old currency in between
  const setCurrency = trpc.receipts.setCurrency.useMutation({
    onSuccess: () => utils.receipts.getReceiptItems.invalidate({ receiptId }),
    onError: (e) => {
      toast.error(e.message);
      reloadAfterError();
    },
  });
  const updateItem = trpc.receipts.updateItem.useMutation({
    onSuccess: () => {
      setEditingItem(null);
      utils.receipts.getReceiptItems.invalidate({ receiptId });
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteItem = trpc.receipts.deleteItem.useMutation({
    onSuccess: (_, { itemId }) => {
      // Its people go with it (#411)
      setAssignments((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      utils.receipts.getReceiptItems.invalidate({ receiptId });
    },
    // Deleted on another device, say: show the receipt as it is now
    onError: (e) => {
      toast.error(e.message);
      reloadAfterError();
    },
  });
  const addItem = trpc.receipts.addItem.useMutation({
    onSuccess: () => {
      setAddingItem(false);
      setNewItem({ name: '', quantity: '1', totalPrice: '' });
      utils.receipts.getReceiptItems.invalidate({ receiptId });
    },
    onError: (e) => toast.error(e.message),
  });
  const splitItem = trpc.receipts.splitItem.useMutation({
    onSuccess: () => utils.receipts.getReceiptItems.invalidate({ receiptId }),
    onError: (e) => toast.error(e.message),
  });
  const saveForLater = trpc.receipts.saveForLater.useMutation({
    onSuccess: () => {
      // A read of the receipt started before the save would otherwise be reused, and fill the form
      // with what it held, when the receipt is reopened (#412). Invalidating cancels it and reads
      // the receipt again, also when the page was left while saving (`all` includes a query no
      // page shows any more)
      void utils.receipts.getReceiptItems.invalidate({ receiptId }, { refetchType: 'all' });
      onSaveForLater?.();
    },
    onError: (e) => {
      toast.error(e.message);
      reloadAfterError();
    },
  });

  // Toggle the image. Zoom/pan reset on every toggle (fresh view when
  // opening, cleanup when hiding), and the visibility flip is a functional
  // update so rapid successive clicks can't act on a stale captured value.
  function toggleImage() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setShowImage((prev) => !prev);
  }

  // Wheel zoom — must be non-passive to call preventDefault
  useEffect(() => {
    const el = imageContainerRef.current;
    if (!el || !showImage) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((z) => Math.min(Math.max(z * factor, 1), 5));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [showImage]);

  // Fill the form once (#412): the title (the saved one, else the merchant's name) and whatever
  // Save for later kept (tip, payer, assignments). Only from the first successful fetch to finish
  // after this mount that has the scan's data: a page reopened soon after a save first gets the cached
  // receipt, which may hold values saved before the last save, and a fetch that fails keeps it.
  // The form stays hidden until then (below), so nothing can be typed or saved over it. Never
  // again after that, so a later refetch can't refill a title cleared to type another, or replace
  // edits with what someone else saved meanwhile.
  const [formFilled, setFormFilled] = useState(false);
  const hasFreshData = receiptData.isSuccess && receiptData.isFetchedAfterMount;

  /* eslint-disable react-hooks/set-state-in-effect -- init from async query data */
  useEffect(() => {
    const data = receiptData.data;
    if (formFilled || !hasFreshData || !data?.receipt.extractedData) return;
    setFormFilled(true);
    const { receipt: saved } = data;

    setTitle(saved.title ?? saved.extractedData?.merchantName ?? '');
    if (saved.tipOverride !== null) {
      setTipOverride(centsToDecimal(saved.tipOverride, saved.extractedData?.currency));
    }
    if (saved.paidById) {
      setPaidById(saved.paidById);
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
  }, [receiptData.data, hasFreshData, formFilled]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { receipt, items } = receiptData.data ?? { receipt: null, items: [] };
  const extracted = receipt?.extractedData ?? null;
  // The currency the money fields are in and the split is calculated in: the receipt's, or the
  // one being saved (#335)
  const fieldCurrency = setCurrency.isPending ? setCurrency.variables.currency : extracted?.currency;
  const parsedTip = parseFloat(tipOverride);
  // The tip typed over the scanned one, in cents; what Create Expense and Save for later send. One
  // with decimals in a currency that has none counts as not entered, as an exact share does (#335)
  const typedTipCents = tipOverride !== '' && isFinite(parsedTip) ? Math.round(parsedTip * 100) : null;
  const tipOverrideCents =
    typedTipCents !== null && typedTipCents % currencyStep(fieldCurrency) === 0 ? typedTipCents : null;
  const tip = extracted && tipOverrideCents !== null ? tipOverrideCents : (extracted?.tip ?? 0);
  // Until someone picks a payer or a saved one loads, default to the current user (when
  // they're in the group), as Add Expense does (#271, #265)
  const currentUserId = profile.data?.id;
  const defaultPaidById = currentUserId && members.some((m) => m.id === currentUserId) ? currentUserId : '';
  const effectivePaidById = paidById || defaultPaidById;

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
      totalPrice: centsToDecimal(item.totalPrice, fieldCurrency),
    });
  }

  function saveEdit(itemId: string) {
    const trimmedName = editValues.name.trim();
    if (!trimmedName) {
      toast.error(t('validationNameRequired'));
      return;
    }
    // A price left as it opened keeps its stored amount, hundredths and all (#335)
    const stored = items.find((item) => item.id === itemId)?.totalPrice;
    const totalPrice =
      stored === undefined
        ? parseToCents(editValues.totalPrice, fieldCurrency)
        : editedAmount(editValues.totalPrice, stored, fieldCurrency);
    if (totalPrice <= 0) {
      toast.error(t('validationPricePositive'));
      return;
    }
    const quantity = parseInt(editValues.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      toast.error(t('validationQtyPositive'));
      return;
    }
    updateItem.mutate({
      itemId,
      name: trimmedName,
      quantity,
      totalPrice,
      unitPrice: Math.round(totalPrice / quantity),
    });
  }

  function handleAddItem() {
    const totalPrice = parseToCents(newItem.totalPrice, fieldCurrency);
    const quantity = parseInt(newItem.quantity) || 1;
    if (!newItem.name.trim() || totalPrice <= 0 || quantity < 1) return;
    addItem.mutate({
      receiptId,
      name: newItem.name.trim(),
      quantity,
      unitPrice: Math.round(totalPrice / quantity),
      totalPrice,
    });
  }

  // What the totals below show, and what Create Expense and Save for later send: the current items
  // that have someone. Read through `items`, so an item deleted on another device doesn't count (#411).
  const assignmentList = useMemo(() => receiptAssignmentList(items, assignments), [items, assignments]);
  // The server calculates the expense with the same function and the same list, and saves it only
  // if each person's total is the one shown here (#364). Memoized to avoid recomputation on every
  // render (Finding #36). In whole units of a currency with no decimals (#335), the currency
  // being the one the server will read: Create Expense waits for a currency change to save
  const step = currencyStep(fieldCurrency);
  const shownTotals = useMemo(
    () => calculateReceiptSplitTotals({ items, assignments: assignmentList, tax: extracted?.tax ?? 0, tip, step }),
    [items, assignmentList, extracted, tip, step],
  );
  const perPersonTotals = useMemo(
    () => new Map(shownTotals.map((person) => [person.userId, person.total])),
    [shownTotals],
  );
  const assignedItemCount = assignmentList.length;
  const allAssigned = items.length > 0 && assignedItemCount === items.length;

  // Precompute member initials to avoid recalculation every render (Finding #37)
  const memberInitials = useMemo(
    () =>
      new Map(
        members.map((m) => [
          m.id,
          m.name
            ? m.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .toUpperCase()
                .slice(0, 2)
            : '?',
        ]),
      ),
    [members],
  );
  // First names, or whole names where two people share one (#277)
  const memberLabels = useMemo(() => {
    const labels = chipLabels(members.map((m) => m.name));
    return new Map(members.map((m, i) => [m.id, labels[i]]));
  }, [members]);

  if (receiptData.isLoading) {
    return <p className="text-muted-foreground">{t('loadingItems')}</p>;
  }
  if (!receiptData.data) {
    return <p className="text-destructive">{t('noReceiptData')}</p>;
  }
  if (!extracted) {
    return <p className="text-destructive">{t('noExtractedData')}</p>;
  }
  // Until the form is filled from fresh data: the receipt may be the cached copy from before a save
  if (!formFilled) {
    return receiptData.isError && !receiptData.isFetching ? (
      <p className="text-destructive">{t('noReceiptData')}</p>
    ) : (
      <p className="text-muted-foreground">{t('loadingItems')}</p>
    );
  }

  // After early returns, these are guaranteed non-null
  const safeReceipt = receipt!;
  const safeExtracted = extracted;

  // The receipt's currency (its group's when the scan couldn't tell, #361), or the one being saved
  const currency = setCurrency.isPending ? setCurrency.variables.currency : safeExtracted.currency;
  const isDifferentCurrency = currency !== groupCurrency;
  // The common currencies, and the receipt's and the group's when they aren't among them
  const currencyOptions = [...new Set([...COMMON_CURRENCIES.map((c) => c.code as string), currency, groupCurrency])];
  const manualRateText = manualRate.currency === currency ? manualRate.text : '';
  const parsedManualRate = parseFloat(manualRateText);
  const manualRateValid = useManualRate && isFinite(parsedManualRate) && parsedManualRate > 0;
  const expenseTotal = shownTotals.reduce((sum, person) => sum + person.total, 0);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectivePaidById || !allAssigned) return;

    createExpense.mutate({
      groupId,
      receiptId,
      title,
      paidById: effectivePaidById,
      tipOverride: tipOverrideCents ?? undefined,
      assignments: assignmentList,
      expectedShares: shownTotals.map((person) => ({ userId: person.userId, amount: person.total })),
      expectedCurrency: currency,
      ...(isDifferentCurrency && manualRateValid ? { exchangeRate: parsedManualRate } : {}),
    });
  }

  function handleSaveForLater() {
    saveForLater.mutate({
      groupId,
      receiptId,
      paidById: effectivePaidById || null,
      // Kept so the receipt reopens with them, for anyone in the group (#412)
      title,
      tipOverride: tipOverrideCents,
      assignments: assignmentList,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="item-assignment-form">
      {/* Receipt image toggle */}
      {safeReceipt.imagePath && (
        <Button type="button" variant="outline" size="sm" onClick={toggleImage}>
          <ImageIcon className="mr-2 h-4 w-4" />
          {showImage ? t('hideImage') : t('viewImage')}
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
                cursor: isDragging ? 'grabbing' : 'grab',
                touchAction: 'none',
                userSelect: 'none',
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
              onMouseUp={() => {
                setIsDragging(false);
                dragStart.current = null;
              }}
              onMouseLeave={() => {
                setIsDragging(false);
                dragStart.current = null;
              }}
              onDoubleClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              onTouchStart={(e) => {
                if (e.touches.length === 2) {
                  const touch0 = e.touches[0];
                  const touch1 = e.touches[1];
                  if (!touch0 || !touch1) return;
                  const dx = touch0.clientX - touch1.clientX;
                  const dy = touch0.clientY - touch1.clientY;
                  lastTouchDist.current = Math.sqrt(dx * dx + dy * dy);
                } else {
                  const touch0 = e.touches[0];
                  if (!touch0) return;
                  dragStart.current = { x: touch0.clientX, y: touch0.clientY, panX: pan.x, panY: pan.y };
                }
              }}
              onTouchMove={(e) => {
                if (e.touches.length === 2 && lastTouchDist.current !== null) {
                  const touch0 = e.touches[0];
                  const touch1 = e.touches[1];
                  if (!touch0 || !touch1) return;
                  const dx = touch0.clientX - touch1.clientX;
                  const dy = touch0.clientY - touch1.clientY;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  const factor = dist / lastTouchDist.current;
                  setZoom((z) => Math.min(Math.max(z * factor, 1), 5));
                  lastTouchDist.current = dist;
                } else if (e.touches.length === 1 && dragStart.current) {
                  const touch0 = e.touches[0];
                  if (!touch0) return;
                  setPan({
                    x: dragStart.current.panX + touch0.clientX - dragStart.current.x,
                    y: dragStart.current.panY + touch0.clientY - dragStart.current.y,
                  });
                }
              }}
              onTouchEnd={() => {
                lastTouchDist.current = null;
                dragStart.current = null;
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded
                  receipt photo with unknown natural dimensions, rendered inside a
                  pinch-zoom/pan viewport; next/image would need either server-side
                  dimension probing or a fill+aspect-ratio layout change, out of scope
                  here */}
              <img
                src={`/api/uploads/${safeReceipt.imagePath}`}
                alt={t('receiptImageAlt')}
                draggable={false}
                className="h-full w-full object-contain pointer-events-none"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: 'center center',
                  transition: isDragging ? 'none' : 'transform 0.05s ease-out',
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
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  {t('resetView')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Receipt summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('receiptSummary')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {safeExtracted.merchantName && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('merchant')}</span>
              <span>{safeExtracted.merchantName}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('subtotal')}</span>
            <span>{formatCents(safeExtracted.subtotal, currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('tax')}</span>
            <span>{formatCents(safeExtracted.tax, currency, locale)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('tip')}</span>
            <span>{formatCents(tip, currency, locale)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-semibold">
            <span>{t('total')}</span>
            <span>{formatCents(safeExtracted.subtotal + safeExtracted.tax + tip, currency, locale)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Expense details */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="space-y-2">
            <Label htmlFor="title">{t('expenseTitle')}</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('expenseTitlePlaceholder')}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="paidBy">{t('paidBy')}</Label>
            <select
              id="paidBy"
              value={effectivePaidById}
              onChange={(e) => setPaidById(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              data-testid="paid-by-select"
            >
              <option value="">{t('selectMember')}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? t('unnamed')}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="receipt-currency">{tNew('currency')}</Label>
            <select
              id="receipt-currency"
              value={currency}
              onChange={(e) => setCurrency.mutate({ receiptId, currency: e.target.value })}
              disabled={setCurrency.isPending}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              data-testid="receipt-currency-select"
            >
              {currencyOptions.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          {isDifferentCurrency && (
            <div
              className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/50"
              data-testid="receipt-rate"
            >
              <p className="text-blue-800 dark:text-blue-200">
                {tNew('differentCurrencyNote', { expenseCurrency: currency, groupCurrency })}
              </p>
              <label className="mt-2 flex items-center gap-1.5 text-xs text-blue-700 dark:text-blue-300">
                <input
                  type="checkbox"
                  checked={useManualRate}
                  onChange={(e) => setUseManualRate(e.target.checked)}
                  className="rounded"
                />
                {tNew('manualRateOverride')}
              </label>
              {useManualRate ? (
                <div className="mt-2">
                  <Input
                    type="number"
                    step="any"
                    min="0.000001"
                    aria-label={tNew('exchangeRatePlaceholder', { from: currency, to: groupCurrency })}
                    placeholder={tNew('exchangeRatePlaceholder', { from: currency, to: groupCurrency })}
                    value={manualRateText}
                    onChange={(e) => setManualRate({ currency, text: e.target.value })}
                    data-testid="receipt-rate-input"
                  />
                  {manualRateValid && expenseTotal > 0 && (
                    <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">
                      {tNew('convertedAmount', {
                        amount: formatCents(
                          convertAmount(expenseTotal, parsedManualRate, groupCurrency),
                          groupCurrency,
                          locale,
                        ),
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">{tNew('autoRateNote')}</p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="tip">{t('tipOverride')}</Label>
            <Input
              id="tip"
              type="number"
              step={amountInputStep(currency)}
              min="0"
              placeholder={t('tipDetected', { amount: formatCents(safeExtracted.tip, currency, locale) })}
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
          {t('splitAllEqually')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAddingItem(true)}
          data-testid="add-item-btn"
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('addItem')}
        </Button>
      </div>

      {/* Add new item form */}
      {addingItem && (
        <Card className="border-primary/50" data-testid="add-item-form">
          <CardContent className="py-3">
            <div
              className="space-y-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !addItem.isPending) {
                  e.preventDefault();
                  handleAddItem();
                }
              }}
            >
              <div className="flex gap-2">
                <Input
                  placeholder={t('itemNamePlaceholder')}
                  value={newItem.name}
                  onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                  className="flex-1"
                />
                <Input
                  type="number"
                  placeholder={t('qtyPlaceholder')}
                  value={newItem.quantity}
                  onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                  className="w-16"
                  min="1"
                />
                <Input
                  type="number"
                  step={amountInputStep(currency)}
                  placeholder={t('pricePlaceholder')}
                  value={newItem.totalPrice}
                  onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                  className="w-24"
                />
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={addItem.isPending} onClick={handleAddItem}>
                  {addItem.isPending ? t('adding') : t('add')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAddingItem(false)}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Item assignment */}
      <div className="space-y-2">
        <Label>{t('assignItems', { assigned: assignedItemCount, total: items.length })}</Label>
        {items.map((item) => {
          const assigned = assignments[item.id] ?? new Set();
          const isEditing = editingItem === item.id;

          return (
            <Card
              key={item.id}
              className={assigned.size === 0 ? 'border-amber-300' : ''}
              data-testid={`item-card-${item.id}`}
            >
              <CardContent className="py-3">
                {isEditing ? (
                  <div className="mb-2 space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={editValues.name}
                        onChange={(e) => setEditValues((p) => ({ ...p, name: e.target.value }))}
                        className="flex-1"
                        placeholder={t('itemNamePlaceholder')}
                      />
                      <Input
                        type="number"
                        value={editValues.quantity}
                        onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                        className="w-16"
                        placeholder={t('qtyPlaceholder')}
                        min="1"
                      />
                      <Input
                        type="number"
                        step={amountInputStep(currency)}
                        value={editValues.totalPrice}
                        onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                        className="w-24"
                        placeholder={t('pricePlaceholder')}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button type="button" size="sm" onClick={() => saveEdit(item.id)} disabled={updateItem.isPending}>
                        {t('save')}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEditingItem(null)}>
                        {t('cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{item.name}</span>
                      {item.quantity > 1 && <span className="text-xs text-muted-foreground">x{item.quantity}</span>}
                      <button
                        type="button"
                        onClick={() => startEditing(item)}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={t('editItem', { name: item.name })}
                        title={t('editItem', { name: item.name })}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoveItem({ id: item.id, name: item.name })}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={t('removeItem', { name: item.name })}
                        title={t('removeItem', { name: item.name })}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      {item.quantity > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            setSplittingItem(item.id);
                            setSplitQuantity('1');
                          }}
                          className="text-muted-foreground hover:text-foreground"
                          title={t('split')}
                          aria-label={t('splitAriaLabel', { name: item.name })}
                          data-testid={`split-btn-${item.id}`}
                        >
                          <Scissors className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <span className="font-semibold">{formatCents(item.totalPrice, currency, locale)}</span>
                  </div>
                )}
                {!isEditing &&
                  splittingItem === item.id &&
                  (() => {
                    const parsed = Number(splitQuantity);
                    const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                    return (
                      <div className="mb-2 flex items-center gap-2" data-testid="split-form">
                        <span className="text-xs text-muted-foreground">{t('splitOff')}</span>
                        <Input
                          type="number"
                          min={1}
                          max={item.quantity - 1}
                          value={splitQuantity}
                          onChange={(e) => setSplitQuantity(e.target.value)}
                          className="w-16 h-7 text-xs"
                          data-testid="split-qty-input"
                        />
                        <span className="text-xs text-muted-foreground">
                          {t('splitOfTotal', { total: item.quantity })}
                        </span>
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
                          {t('split')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setSplittingItem(null)}
                        >
                          {t('cancel')}
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
                        className={`flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors ${
                          isAssigned
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                      >
                        <Avatar className="h-4 w-4">
                          <AvatarFallback className="text-[8px]">{memberInitials.get(m.id) ?? '?'}</AvatarFallback>
                        </Avatar>
                        <span
                          data-testid="chip-label"
                          className="min-w-0 text-left [overflow-wrap:anywhere]"
                          title={m.name ?? undefined}
                        >
                          {memberLabels.get(m.id) ?? '?'}
                        </span>
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
            <CardTitle className="text-base">{t('perPersonTotals')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {members.map((m) => {
              const total = perPersonTotals.get(m.id);
              if (!total) return null;
              return (
                <div key={m.id} className="flex justify-between text-sm">
                  <span>{m.name ?? t('unnamed')}</span>
                  <span className="font-medium" data-testid={`person-total-${m.id}`}>
                    {formatCents(total, currency, locale)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {createExpense.error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{createExpense.error.message}</div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={createExpense.isPending || setCurrency.isPending || !allAssigned || !effectivePaidById}
        data-testid="create-expense-btn"
      >
        {createExpense.isPending
          ? t('creatingExpense')
          : !allAssigned
            ? t('assignAllItems', { remaining: items.length - assignedItemCount })
            : t('createExpense')}
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
          {saveForLater.isPending ? t('saving') : t('saveForLater')}
        </Button>
      )}
      <ConfirmDialog
        open={removeItem !== null}
        onOpenChange={(open) => !open && setRemoveItem(null)}
        title={t('removeTitle', { name: removeItem?.name ?? '' })}
        description={t('removeDescription')}
        confirmLabel={t('remove')}
        onConfirm={() => removeItem && deleteItem.mutate({ itemId: removeItem.id })}
      />
    </form>
  );
}
