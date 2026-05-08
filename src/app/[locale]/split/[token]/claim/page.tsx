"use client";

import { use, useState, useMemo } from "react";
import { useLocale } from "next-intl";
import { trpc } from "@/lib/trpc";
import { formatCents } from "@/lib/money";
import { calculateSplitTotals } from "@/lib/split-calculator";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, Users, Receipt, ArrowRight } from "lucide-react";
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

export default function ClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const locale = useLocale();

  // --- State ---
  const [name, setName] = useState("");
  const [personIndex, setPersonIndex] = useState<number | null>(null);
  const [personToken, setPersonToken] = useState<string | null>(null);
  const [claimedItems, setClaimedItems] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // --- tRPC ---
  const session = trpc.guest.getSession.useQuery(
    { token },
    { refetchInterval: (query) => query.state.data?.status === "finalized" ? false : 3000 }
  );

  const joinSession = trpc.guest.joinSession.useMutation({
    onSuccess: (data) => {
      setPersonIndex(data.personIndex);
      setPersonToken(data.personToken);
      // Initialize claimed items from current server assignments
      const currentClaims =
        session.data?.assignments
          .filter((a) => a.personIndices.includes(data.personIndex))
          .map((a) => a.itemIndex) ?? [];
      setClaimedItems(new Set(currentClaims));
      toast.success("Joined the session!");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const claimItems = trpc.guest.claimItems.useMutation({
    onSuccess: () => {
      toast.success("Claims saved!");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  // --- Derived state ---
  const hasJoined = personIndex !== null;

  // Compute which claimed items differ from the server state (dirty indicator)
  const serverClaims = useMemo(() => {
    if (personIndex === null || !session.data) return new Set<number>();
    return new Set(
      session.data.assignments
        .filter((a) => a.personIndices.includes(personIndex))
        .map((a) => a.itemIndex)
    );
  }, [session.data, personIndex]);

  const hasUnsavedChanges = useMemo(() => {
    if (personIndex === null) return false;
    if (claimedItems.size !== serverClaims.size) return true;
    for (const idx of claimedItems) {
      if (!serverClaims.has(idx)) return true;
    }
    return false;
  }, [claimedItems, serverClaims, personIndex]);

  // Calculate per-person totals using the local claims merged with server assignments
  const splitTotals = useMemo(() => {
    if (!session.data) return [];

    // Build assignments: start with server, override this person's claims locally
    const serverAssignments = session.data.assignments;
    let mergedAssignments: { itemIndex: number; personIndices: number[] }[];

    if (personIndex !== null) {
      // Rebuild assignments by merging local claims for this person
      const assignmentMap = new Map<number, Set<number>>();
      for (const a of serverAssignments) {
        assignmentMap.set(a.itemIndex, new Set(a.personIndices));
      }
      // Remove this person from all items, then re-add claimed ones
      for (const [, persons] of assignmentMap) {
        persons.delete(personIndex);
      }
      for (const itemIdx of claimedItems) {
        if (!assignmentMap.has(itemIdx)) {
          assignmentMap.set(itemIdx, new Set());
        }
        assignmentMap.get(itemIdx)!.add(personIndex);
      }
      mergedAssignments = Array.from(assignmentMap.entries())
        .filter(([, persons]) => persons.size > 0)
        .map(([itemIndex, persons]) => ({
          itemIndex,
          personIndices: Array.from(persons),
        }));
    } else {
      mergedAssignments = serverAssignments;
    }

    return calculateSplitTotals({
      items: session.data.items,
      assignments: mergedAssignments,
      tax: session.data.receiptData.tax,
      tip: session.data.receiptData.tip,
      peopleCount: session.data.people.length,
    });
  }, [session.data, personIndex, claimedItems]);

  // --- Handlers ---
  function handleJoin() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Please enter your name");
      return;
    }
    joinSession.mutate({ token, name: trimmed });
  }

  function toggleClaim(itemIndex: number) {
    setClaimedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemIndex)) next.delete(itemIndex);
      else next.add(itemIndex);
      return next;
    });
  }

  async function saveClaims() {
    if (personIndex === null || !personToken) return;
    setSaving(true);
    try {
      await claimItems.mutateAsync({
        token,
        personIndex,
        personToken,
        claimedItemIndices: Array.from(claimedItems),
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
        <p className="text-muted-foreground">Loading session...</p>
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
          <h2 className="text-xl font-bold">Session not found</h2>
          <p className="text-muted-foreground">
            {session.error.message.includes("expired")
              ? "This session has expired."
              : "This session link is invalid or has been removed."}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/split" />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          Split your own bill
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
          <h2 className="text-xl font-bold">Session finalized</h2>
          <p className="text-muted-foreground">
            This claiming session has been finalized. View the summary below.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href={`/split/${token}`} />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          View summary
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
            {data.receiptData.merchantName ?? "Bill Split"}
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
              <span className="font-semibold text-lg">Total Bill</span>
              <span className="text-2xl font-bold text-primary">
                {formatCents(data.receiptData.total, currency, locale)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* People already in session */}
        {data.people.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" />
                People in this session ({data.people.length})
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Join this session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name-input" className="text-sm font-medium">
                Your name
              </label>
              <Input
                id="name-input"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin();
                }}
                autoFocus
              />
            </div>
            <Button
              className="w-full"
              onClick={handleJoin}
              disabled={!name.trim() || joinSession.isPending}
            >
              {joinSession.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Joining...
                </>
              ) : (
                <>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  Join
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
          {data.receiptData.merchantName ?? "Bill Split"}
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
            <span className="font-semibold text-lg">Total Bill</span>
            <span className="text-2xl font-bold text-primary">
              {formatCents(data.receiptData.total, currency, locale)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* People in session */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            People in this session ({data.people.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {data.people.map((person, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${
                  idx === personIndex
                    ? "bg-primary/10 ring-2 ring-primary"
                    : "bg-muted"
                }`}
              >
                <Avatar className="h-6 w-6">
                  <AvatarFallback
                    className={`text-[10px] font-semibold ${colors[idx % colors.length]}`}
                  >
                    {initials(person.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">
                  {person.name}
                  {idx === personIndex && " (you)"}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Items to claim */}
      <div className="space-y-3">
        <h3 className="font-semibold text-base">
          Tap to claim your items
          {hasUnsavedChanges && (
            <Badge variant="secondary" className="ml-2">
              Unsaved changes
            </Badge>
          )}
        </h3>
        {data.items.map((item, idx) => {
          const isClaimed = claimedItems.has(idx);
          // Find other claimants from server state
          const otherClaimants =
            data.assignments
              .find((a) => a.itemIndex === idx)
              ?.personIndices.filter((pi) => pi !== personIndex) ?? [];

          return (
            <Card
              key={idx}
              role="button"
              aria-pressed={isClaimed}
              tabIndex={0}
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
                      <span className="font-semibold shrink-0">
                        {formatCents(item.totalPrice, currency, locale)}
                      </span>
                    </div>

                    {/* Other claimants */}
                    {otherClaimants.length > 0 && (
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-xs text-muted-foreground">
                          Also claimed by:
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
          );
        })}
      </div>

      {/* Per-person totals */}
      {splitTotals.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-base">Per-person totals</h3>
          {splitTotals.map((person) => {
            const personName =
              data.people[person.personIndex]?.name ??
              `Person ${person.personIndex + 1}`;
            const isMe = person.personIndex === personIndex;

            return (
              <Card
                key={person.personIndex}
                className={isMe ? "ring-2 ring-primary" : ""}
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
                        {isMe && " (you)"}
                      </span>
                    </div>
                    <span className="text-lg font-bold text-primary">
                      {formatCents(person.total, currency, locale)}
                    </span>
                  </div>
                  {(person.tax > 0 || person.tip > 0) && (
                    <div className="ml-11 mt-1 flex gap-3 text-xs text-muted-foreground">
                      <span>
                        Items: {formatCents(person.itemTotal, currency, locale)}
                      </span>
                      {person.tax > 0 && (
                        <span>
                          Tax: {formatCents(person.tax, currency, locale)}
                        </span>
                      )}
                      {person.tip > 0 && (
                        <span>
                          Tip: {formatCents(person.tip, currency, locale)}
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
          Split your own bill
        </Link>
        <span className="text-muted-foreground mx-2">or</span>
        <Link
          href="/register"
          className="text-sm font-medium text-primary hover:underline"
        >
          Create an account
        </Link>
      </div>

      {/* Save button - sticky bottom */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
        <div className="mx-auto max-w-lg">
          <Button
            className="w-full h-14"
            onClick={saveClaims}
            disabled={saving || !hasUnsavedChanges}
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Saving...
              </>
            ) : hasUnsavedChanges ? (
              <>
                <Check className="mr-2 h-5 w-5" />
                Save my claims
              </>
            ) : (
              <>
                <Check className="mr-2 h-5 w-5" />
                Claims saved
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
