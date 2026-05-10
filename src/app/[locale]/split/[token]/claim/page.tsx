"use client";

import { use, useState, useMemo, useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { storedClaimIdentitySchema, type StoredClaimIdentity } from "@/lib/guest-session";
import { calculateSplitTotals } from "@/lib/split-calculator";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, Users, Receipt, ArrowRight, Image as ImageIcon, Pencil, X, Link2, Scissors } from "lucide-react";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";

// Shared avatar color palette (matches the existing split page)
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

function initials(name: string): string {
  return (
    name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "?"
  );
}

function getStoredClaimIdentity(token: string): StoredClaimIdentity | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(`sharetab-claim:${token}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const identity = storedClaimIdentitySchema.safeParse(parsed);
    return identity.success ? identity.data : null;
  } catch {
    return null;
  }
}

function setStoredClaimIdentity(token: string, identity: StoredClaimIdentity) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`sharetab-claim:${token}`, JSON.stringify(identity));
  } catch {
    // Non-fatal: failing to persist rejoin state should not block the claim flow.
  }
}

export default function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const locale = useLocale();
  const t = useTranslations("split.claim");

  // --- State ---
  const [name, setName] = useState("");
  const [personIndex, setPersonIndex] = useState<number | null>(null);
  const [myPersonIndex, setMyPersonIndex] = useState<number | null>(null);
  const [personToken, setPersonToken] = useState<string | null>(null);
  const [claimedItems, setClaimedItems] = useState<Map<number, Set<number>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showImage, setShowImage] = useState(false);
  const [editingPersonIdx, setEditingPersonIdx] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [splittingItemIdx, setSplittingItemIdx] = useState<number | null>(null);
  const [splitQty, setSplitQty] = useState("");

  // --- tRPC ---
  const session = trpc.guest.getSession.useQuery(
    { token },
    { refetchInterval: (query) => (query.state.data?.status === "finalized" || query.state.error) ? false : 3000 }
  );

  const editPersonName = trpc.guest.editPersonName.useMutation({
    onSuccess: () => {
      setEditingPersonIdx(null);
      setEditingName("");
      toast.success(t("nameUpdated"));
    },
    onError: (err) => toast.error(err.message),
  });

  const removePerson = trpc.guest.removePerson.useMutation({
    onSuccess: (_data, variables) => {
      const removedIdx = variables.targetIndex;
      if (removedIdx === myPersonIndex) {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(`sharetab-claim:${token}`);
        }
        setClaimedItems(new Map());
        setPersonIndex(null);
        setMyPersonIndex(null);
        setPersonToken(null);
      } else {
        setClaimedItems((prev) => {
          const next = new Map<number, Set<number>>();
          for (const [pIdx, itemSet] of prev) {
            if (pIdx === removedIdx) continue;
            const newPIdx = pIdx > removedIdx ? pIdx - 1 : pIdx;
            next.set(newPIdx, itemSet);
          }
          return next;
        });
        setPersonIndex((prev) => {
          if (prev === null) return null;
          return prev > removedIdx ? prev - 1 : prev;
        });
        setMyPersonIndex((prev) => {
          if (prev === null) return null;
          return prev > removedIdx ? prev - 1 : prev;
        });
      }
      toast.success(t("personRemoved"));
    },
    onError: (err) => toast.error(err.message),
  });

  const splitClaimItem = trpc.guest.splitClaimItem.useMutation({
    onSuccess: (_data, variables) => {
      const splitIdx = variables.itemIndex;
      setSplittingItemIdx(null);
      setSplitQty("");
      // Remap claimed item indices: items after the split point shift +1 (Finding #4).
      // Only invalidate the split item itself; preserve unsaved edits for other items.
      setClaimedItems((prev) => {
        const next = new Map<number, Set<number>>();
        for (const [personIdx, itemSet] of prev) {
          const remapped = new Set<number>();
          for (const itemIdx of itemSet) {
            if (itemIdx === splitIdx) {
              // Keep claim on the original (now-reduced) item
              remapped.add(itemIdx);
            } else if (itemIdx > splitIdx) {
              remapped.add(itemIdx + 1);
            } else {
              remapped.add(itemIdx);
            }
          }
          next.set(personIdx, remapped);
        }
        return next;
      });
    },
    onError: (err) => toast.error(err.message),
  });

  const autoRejoinAttempted = useRef(false);

  const joinSession = trpc.guest.joinSession.useMutation({
    onSuccess: (data, variables) => {
      setPersonIndex(data.personIndex);
      setMyPersonIndex(data.personIndex);
      setPersonToken(data.personToken);
      setStoredClaimIdentity(token, {
        name: variables.name,
        personToken: data.personToken,
      });
      // Initialize claimed items from server assignments for ALL people
      const map = new Map<number, Set<number>>();
      if (session.data) {
        for (const a of session.data.assignments) {
          for (const pi of a.personIndices) {
            if (!map.has(pi)) map.set(pi, new Set());
            map.get(pi)!.add(a.itemIndex);
          }
        }
      }
      setClaimedItems(map);
      if (!autoRejoinAttempted.current) {
        toast.success(t("joinedSession"));
      }
    },
    onError: (error) => {
      if (!autoRejoinAttempted.current) {
        toast.error(error.message);
      }
    },
  });

  // Auto-rejoin from localStorage when session data loads
  useEffect(() => {
    if (autoRejoinAttempted.current || personIndex !== null || !session.data) return;
    if (session.data.status !== "claiming") return;

    const stored = getStoredClaimIdentity(token);
    if (!stored) return;

    autoRejoinAttempted.current = true;
    joinSession.mutate({
      token,
      name: stored.name,
    });
  }, [session.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const claimItems = trpc.guest.claimItems.useMutation({
    onSuccess: (result) => {
      if (result.conflicts && result.conflicts.length > 0) {
        const names = [...new Set(result.conflicts.flatMap(c => c.claimedBy))];
        toast.warning(t("claimConflict", { names: names.join(", "), count: result.conflicts.length }));
      } else {
        toast.success(t("claimsSavedToast"));
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // --- Derived state ---
  const hasJoined = personIndex !== null;

  // Compute server claims for all people
  const serverClaimsMap = useMemo(() => {
    if (!session.data) return new Map<number, Set<number>>();
    const map = new Map<number, Set<number>>();
    for (const a of session.data.assignments) {
      for (const pi of a.personIndices) {
        if (!map.has(pi)) map.set(pi, new Set());
        map.get(pi)!.add(a.itemIndex);
      }
    }
    return map;
  }, [session.data]);

  const currentClaims = claimedItems.get(personIndex ?? -1) ?? new Set<number>();
  const currentServerClaims = serverClaimsMap.get(personIndex ?? -1) ?? new Set<number>();

  const hasUnsavedChanges = useMemo(() => {
    if (personIndex === null) return false;
    if (currentClaims.size !== currentServerClaims.size) return true;
    for (const idx of currentClaims) {
      if (!currentServerClaims.has(idx)) return true;
    }
    return false;
  }, [currentClaims, currentServerClaims, personIndex]);

  // Which items are claimed by anyone (for sorting unclaimed first)
  const claimedByAnyone = useMemo(() => {
    if (!session.data) return new Set<number>();
    return new Set(
      session.data.assignments
        .filter(a => a.personIndices.length > 0)
        .map(a => a.itemIndex)
    );
  }, [session.data]);

  const sortedItemIndices = useMemo(() => {
    if (!session.data) return [];
    const unclaimed = session.data.items.map((_, idx) => idx).filter(idx => !claimedByAnyone.has(idx));
    const claimed = session.data.items.map((_, idx) => idx).filter(idx => claimedByAnyone.has(idx));
    return [...unclaimed, ...claimed];
  }, [session.data, claimedByAnyone]);

  // Calculate per-person totals using the full local claims Map merged with server assignments
  const splitTotals = useMemo(() => {
    if (!session.data) return [];

    const serverAssignments = session.data.assignments;

    if (claimedItems.size > 0) {
      // Build assignment map from server state
      const assignmentMap = new Map<number, Set<number>>();
      for (const a of serverAssignments) {
        assignmentMap.set(a.itemIndex, new Set(a.personIndices));
      }
      // Override with local claims for each person that has local state
      for (const [pi, items] of claimedItems) {
        // Remove this person from all items
        for (const [, persons] of assignmentMap) {
          persons.delete(pi);
        }
        // Re-add their claimed items
        for (const itemIdx of items) {
          if (!assignmentMap.has(itemIdx)) {
            assignmentMap.set(itemIdx, new Set());
          }
          assignmentMap.get(itemIdx)!.add(pi);
        }
      }
      const mergedAssignments = Array.from(assignmentMap.entries())
        .filter(([, persons]) => persons.size > 0)
        .map(([itemIndex, persons]) => ({
          itemIndex,
          personIndices: Array.from(persons),
        }));

      return calculateSplitTotals({
        items: session.data.items,
        assignments: mergedAssignments,
        tax: session.data.receiptData.tax,
        tip: session.data.receiptData.tip,
        peopleCount: session.data.people.length,
      });
    }

    return calculateSplitTotals({
      items: session.data.items,
      assignments: serverAssignments,
      tax: session.data.receiptData.tax,
      tip: session.data.receiptData.tip,
      peopleCount: session.data.people.length,
    });
  }, [session.data, claimedItems]);

  // --- Handlers ---
  function handleJoin() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t("pleaseEnterName"));
      return;
    }
    joinSession.mutate({ token, name: trimmed });
  }

  function toggleClaim(itemIndex: number) {
    if (personIndex === null) return;
    setClaimedItems((prev) => {
      const next = new Map(prev);
      const personClaims = new Set(next.get(personIndex) ?? []);
      if (personClaims.has(itemIndex)) personClaims.delete(itemIndex);
      else personClaims.add(itemIndex);
      next.set(personIndex, personClaims);
      return next;
    });
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    toast.success(t("linkCopied"));
  }

  async function saveClaims() {
    if (personIndex === null || !personToken) return;
    setSaving(true);
    try {
      const claims = claimedItems.get(personIndex) ?? new Set<number>();
      await claimItems.mutateAsync({
        token,
        personIndex,
        personToken,
        claimedItemIndices: Array.from(claims),
      });
    } finally {
      setSaving(false);
    }
  }

  // --- Loading state ---
  if (session.isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">{t("loadingSession")}</p>
      </div>
    );
  }

  // --- Error state ---
  if (session.error) {
    return (
      <div className="text-center space-y-6 py-20">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Receipt className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold">{t("sessionNotFound")}</h2>
          <p className="text-muted-foreground">
            {session.error.message.includes("expired")
              ? t("sessionExpired")
              : t("sessionInvalid")}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/split" />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          {t("splitYourOwn")}
        </Button>
      </div>
    );
  }

  const data = session.data!;
  const currency = data.receiptData.currency;

  // --- Finalized state ---
  if (data.status === "finalized") {
    return (
      <div className="text-center space-y-6 py-20">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Check className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold">{t("sessionFinalized")}</h2>
          <p className="text-muted-foreground">
            {t("sessionFinalizedDescription")}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href={`/split/${token}`} />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          {t("viewSummary")}
        </Button>
      </div>
    );
  }

  // --- Step 1: Enter name ---
  if (!hasJoined) {
    return (
      <div className="space-y-6 pb-8">
        {/* Header */}
        <div className="text-center space-y-1 pt-4">
          <h1 className="text-2xl font-bold">
            {data.receiptData.merchantName ?? t("billSplit")}
          </h1>
          {data.receiptData.date && (
            <p className="text-sm text-muted-foreground">
              {data.receiptData.date}
            </p>
          )}
        </div>

        {/* Total */}
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="py-4">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-lg">{t("totalBill")}</span>
              <span className="text-2xl font-bold text-primary">
                {formatCents(data.receiptData.total, currency, locale)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Copy link */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copyLink}
          data-testid="copy-link-btn"
        >
          <Link2 className="mr-2 h-4 w-4" />
          {t("copyLink")}
        </Button>

        {/* Receipt image viewer */}
        {data.receiptImagePath && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowImage(!showImage)}
              data-testid="toggle-receipt-image"
            >
              <ImageIcon className="mr-2 h-4 w-4" />
              {showImage ? t("hideReceipt") : t("viewReceipt")}
            </Button>
            {showImage && (
              <Card>
                <CardContent className="p-2">
                  <img
                    src={`/api/uploads/${data.receiptImagePath}`}
                    alt={t("receiptImage")}
                    className="w-full rounded-md"
                    data-testid="receipt-image"
                  />
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* People already in session */}
        {data.people.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" />
                {t("peopleInSession", { count: data.people.length })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {data.people.map((person, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5"
                  >
                    <Avatar className="h-6 w-6">
                      <AvatarFallback
                        className={`text-[10px] font-semibold ${colors[idx % colors.length]}`}
                      >
                        {initials(person.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">{person.name}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Join form */}
        <Card data-testid="claim-join-form">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("joinSession")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name-input" className="text-sm font-medium">
                {t("yourName")}
              </label>
              <Input
                id="name-input"
                placeholder={t("enterName")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin();
                }}
                autoFocus
                data-testid="claim-name-input"
              />
            </div>
            {/* Rejoin as existing participant */}
            {data.people.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t("orRejoinAs")}</p>
                <div className="flex flex-wrap gap-2">
                  {data.people.map((person, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setName(person.name);
                        setTimeout(() => {
                          joinSession.mutate({ token, name: person.name });
                        }, 100);
                      }}
                      className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 hover:bg-muted/80 transition-colors"
                      data-testid={`rejoin-person-${idx}`}
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarFallback
                          className={`text-[10px] font-semibold ${colors[idx % colors.length]}`}
                        >
                          {initials(person.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium">{person.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Button
              className="w-full"
              onClick={handleJoin}
              disabled={!name.trim() || joinSession.isPending}
              data-testid="claim-join-btn"
            >
              {joinSession.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("joining")}
                </>
              ) : (
                <>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  {t("join")}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // --- Step 2: Claim items ---
  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="text-center space-y-1 pt-4">
        <h1 className="text-2xl font-bold">
          {data.receiptData.merchantName ?? t("billSplit")}
        </h1>
        {data.receiptData.date && (
          <p className="text-sm text-muted-foreground">
            {data.receiptData.date}
          </p>
        )}
      </div>

      {/* Total */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="py-4">
          <div className="flex justify-between items-center">
            <span className="font-semibold text-lg">{t("totalBill")}</span>
            <span className="text-2xl font-bold text-primary">
              {formatCents(data.receiptData.total, currency, locale)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Copy link */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copyLink}
        data-testid="copy-link-btn"
      >
        <Link2 className="mr-2 h-4 w-4" />
        {t("copyLink")}
      </Button>

      {/* Receipt image viewer */}
      {data.receiptImagePath && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowImage(!showImage)}
            data-testid="toggle-receipt-image"
          >
            <ImageIcon className="mr-2 h-4 w-4" />
            {showImage ? t("hideReceipt") : t("viewReceipt")}
          </Button>
          {showImage && (
            <Card>
              <CardContent className="p-2">
                <img
                  src={`/api/uploads/${data.receiptImagePath}`}
                  alt={t("receiptImage")}
                  className="w-full rounded-md"
                  data-testid="receipt-image"
                />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* People in session */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            {t("peopleInSession", { count: data.people.length })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {data.people.map((person, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
                  idx === myPersonIndex
                    ? "bg-primary/10 ring-1 ring-primary"
                    : "bg-muted"
                }`}
              >
                <Avatar className="h-6 w-6 shrink-0">
                  <AvatarFallback
                    className={`text-[10px] font-semibold ${colors[idx % colors.length]}`}
                  >
                    {initials(person.name)}
                  </AvatarFallback>
                </Avatar>
                {editingPersonIdx === idx ? (
                  <form
                    className="flex flex-1 items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!editingName.trim() || !personToken) return;
                      editPersonName.mutate({
                        token,
                        personToken,
                        targetIndex: idx,
                        newName: editingName.trim(),
                      });
                    }}
                  >
                    <Input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="h-7 text-sm"
                      autoFocus
                      aria-label={t("editName")}
                      data-testid={`edit-name-input-${idx}`}
                    />
                    <Button type="submit" size="sm" variant="ghost" className="h-7 px-2" disabled={editPersonName.isPending}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingPersonIdx(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium">
                      {person.name}
                      {idx === myPersonIndex && ` ${t("you")}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPersonIdx(idx);
                        setEditingName(person.name);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1"
                      aria-label={t("editName")}
                      data-testid={`edit-person-${idx}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {data.people.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t("removePersonConfirm", { name: person.name }))) {
                            removePerson.mutate({
                              token,
                              personToken: personToken!,
                              targetIndex: idx,
                            });
                          }
                        }}
                        className="text-muted-foreground hover:text-destructive p-1"
                        aria-label={t("removePerson")}
                        data-testid={`remove-person-${idx}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Claim as selector */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("claimingFor")}</p>
        <div className="flex flex-wrap gap-2">
          {data.people.map((person, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                // Sync local claims from server for the target person if not yet edited
                if (!claimedItems.has(idx)) {
                  setClaimedItems((prev) => {
                    const next = new Map(prev);
                    const serverSet = serverClaimsMap.get(idx) ?? new Set<number>();
                    next.set(idx, new Set(serverSet));
                    return next;
                  });
                }
                setPersonIndex(idx);
              }}
              data-testid={`switch-person-${idx}`}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors ${
                idx === personIndex
                  ? "bg-primary text-primary-foreground ring-2 ring-primary"
                  : "bg-muted hover:bg-muted/80"
              }`}
            >
              <Avatar className="h-6 w-6">
                <AvatarFallback
                  className={`text-[10px] font-semibold ${idx === personIndex ? "bg-primary-foreground/20 text-primary-foreground" : colors[idx % colors.length]}`}
                >
                  {initials(person.name)}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">
                {person.name}
                {idx === myPersonIndex && ` ${t("you")}`}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Items to claim */}
      <div className="space-y-3">
        <h3 className="font-semibold text-base">
          {t("tapToClaim")}
          {hasUnsavedChanges && (
            <Badge variant="secondary" className="ml-2">
              {t("unsavedChanges")}
            </Badge>
          )}
        </h3>
        {sortedItemIndices.map((idx, sortPosition) => {
          const item = data.items[idx]!;
          const isClaimed = (claimedItems.get(personIndex!) ?? new Set()).has(idx);
          // Find other claimants from server state
          const otherClaimants =
            data.assignments
              .find((a) => a.itemIndex === idx)
              ?.personIndices.filter((pi) => pi !== personIndex) ?? [];

          // Show separator before the first claimed item
          const isFirstClaimed =
            claimedByAnyone.has(idx) &&
            (sortPosition === 0 || !claimedByAnyone.has(sortedItemIndices[sortPosition - 1]!));

          return (
            <div key={idx}>
              {isFirstClaimed && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground">{t("alreadyClaimed")}</span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              )}
              <Card
                role="button"
                aria-pressed={isClaimed}
                tabIndex={0}
                data-testid={`claim-item-${idx}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleClaim(idx);
                  }
                }}
                className={`cursor-pointer transition-all ${
                  isClaimed
                    ? "ring-2 ring-primary bg-primary/5"
                    : "hover:bg-muted/50"
                }`}
                onClick={() => toggleClaim(idx)}
              >
                <CardContent className="py-3">
                  <div className="flex items-center gap-3">
                    {/* Claim indicator */}
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                        isClaimed
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {isClaimed && <Check className="h-4 w-4" />}
                    </div>

                    {/* Item details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`font-medium truncate ${
                            isClaimed ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {item.name}
                          {item.quantity > 1 && (
                            <span className="text-muted-foreground ml-1">
                              x{item.quantity}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          {item.quantity > 1 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSplittingItemIdx(idx);
                                setSplitQty("1");
                              }}
                              className="text-muted-foreground hover:text-foreground p-1"
                              aria-label={t("splitItem")}
                              data-testid={`split-claim-item-${idx}`}
                            >
                              <Scissors className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <span className="font-semibold">
                            {formatCents(item.totalPrice, currency, locale)}
                          </span>
                        </div>
                      </div>

                      {/* Split form */}
                      {splittingItemIdx === idx && (() => {
                        const parsed = Number(splitQty);
                        const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                        return (
                          <div
                            className="flex items-center gap-2 mt-2"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <span className="text-xs text-muted-foreground">{t("splitOff")}</span>
                            <Input
                              type="number"
                              min={1}
                              max={item.quantity - 1}
                              value={splitQty}
                              onChange={(e) => setSplitQty(e.target.value)}
                              className="w-16 h-7 text-xs"
                              aria-label={t("splitOff")}
                              data-testid={`split-qty-input-${idx}`}
                            />
                            <span className="text-xs text-muted-foreground">{t("splitOfTotal", { total: item.quantity })}</span>
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={splitClaimItem.isPending || !validQty}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!validQty || !personToken) return;
                                splitClaimItem.mutate({
                                  token,
                                  personToken,
                                  itemIndex: idx,
                                  splitQuantity: parsed,
                                });
                              }}
                            >
                              {t("splitButton")}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={(e) => { e.stopPropagation(); setSplittingItemIdx(null); }}
                            >
                              {t("cancelButton")}
                            </Button>
                          </div>
                        );
                      })()}

                      {/* Other claimants */}
                      {otherClaimants.length > 0 && (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-muted-foreground">
                            {t("alsoClaimedBy")}
                          </span>
                          <div className="flex -space-x-1">
                            {otherClaimants.map((pi) => (
                              <Avatar key={pi} className="h-5 w-5 border-2 border-background">
                                <AvatarFallback
                                  className={`text-[8px] font-semibold ${colors[pi % colors.length]}`}
                                >
                                  {initials(data.people[pi]?.name ?? "?")}
                                </AvatarFallback>
                              </Avatar>
                            ))}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {otherClaimants
                              .map((pi) => data.people[pi]?.name ?? "?")
                              .join(", ")}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>

      {/* Per-person totals */}
      {splitTotals.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-base">{t("perPersonTotals")}</h3>
          {splitTotals.map((person) => {
            const personName =
              data.people[person.personIndex]?.name ??
              t("personFallback", { index: person.personIndex + 1 });
            const isMe = person.personIndex === myPersonIndex;
            const isActive = person.personIndex === personIndex;

            return (
              <Card
                key={person.personIndex}
                className={isActive ? "ring-2 ring-primary" : ""}
              >
                <CardContent className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback
                          className={`text-xs font-semibold ${colors[person.personIndex % colors.length]}`}
                        >
                          {initials(personName)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">
                        {personName}
                        {isMe && ` ${t("you")}`}
                      </span>
                    </div>
                    <span className="text-lg font-bold text-primary">
                      {formatCents(person.total, currency, locale)}
                    </span>
                  </div>
                  {(person.tax > 0 || person.tip > 0) && (
                    <div className="ml-11 mt-1 flex gap-3 text-xs text-muted-foreground">
                      <span>
                        {t("items", { amount: formatCents(person.itemTotal, currency, locale) })}
                      </span>
                      {person.tax > 0 && (
                        <span>
                          {t("taxAmount", { amount: formatCents(person.tax, currency, locale) })}
                        </span>
                      )}
                      {person.tip > 0 && (
                        <span>
                          {t("tipAmount", { amount: formatCents(person.tip, currency, locale) })}
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* CTA */}
      <div className="text-center">
        <Link
          href="/split"
          className="text-sm font-medium text-primary hover:underline"
        >
          {t("splitYourOwn")}
        </Link>
        <span className="text-muted-foreground mx-2">{t("or")}</span>
        <Link
          href="/register"
          className="text-sm font-medium text-primary hover:underline"
        >
          {t("createAccount")}
        </Link>
      </div>

      {/* Save button - sticky bottom */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
        <div className="mx-auto max-w-lg">
          <Button
            className="w-full h-14"
            onClick={saveClaims}
            disabled={saving || !hasUnsavedChanges}
            data-testid="save-claims-btn"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                {t("saving")}
              </>
            ) : hasUnsavedChanges ? (
              <>
                <Check className="mr-2 h-5 w-5" />
                {t("saveClaimsFor", { name: data.people[personIndex!]?.name ?? "" })}
              </>
            ) : (
              <>
                <Check className="mr-2 h-5 w-5" />
                {t("claimsSaved")}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
