'use client';

import { use, useState, useMemo, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { copyToClipboard } from '@/lib/clipboard';
import {
  claimStorageKey,
  joinKeyFor,
  personalLinkHash,
  readPersonalLinkToken,
  resumeOutcome,
  shouldRetryResume,
  storedClaimIdentitySchema,
  type ClaimIdentity,
  type PendingJoin,
  type StoredClaimIdentity,
} from '@/lib/guest-session';
import { calculateSplitTotals } from '@/lib/split-calculator';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Check,
  Loader2,
  Users,
  Receipt,
  ArrowRight,
  Image as ImageIcon,
  Pencil,
  X,
  Link2,
  MonitorSmartphone,
  Scissors,
} from 'lucide-react';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { buildVenmoPayUrl, isValidVenmoHandle } from '@/lib/venmo';
import { getInitials, guestAvatarColor } from '@/lib/avatar';

function getStoredClaimIdentity(token: string): StoredClaimIdentity | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(claimStorageKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const identity = storedClaimIdentitySchema.safeParse(parsed);
    return identity.success ? identity.data : null;
  } catch {
    return null;
  }
}

function removeStoredClaimIdentity(token: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(claimStorageKey(token));
  } catch {
    // Non-fatal, like setStoredClaimIdentity.
  }
}

function setStoredClaimIdentity(token: string, identity: StoredClaimIdentity) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(claimStorageKey(token), JSON.stringify(identity));
  } catch {
    // Non-fatal: failing to persist rejoin state should not block the claim flow.
  }
}

export default function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const locale = useLocale();
  const t = useTranslations('split.claim');
  const tv = useTranslations('split.venmo');
  const tc = useTranslations('common');

  // --- State ---
  const [name, setName] = useState('');
  const [groupSize, setGroupSize] = useState(1);
  const [personIndex, setPersonIndex] = useState<number | null>(null);
  const [myPersonIndex, setMyPersonIndex] = useState<number | null>(null);
  const [personToken, setPersonToken] = useState<string | null>(null);
  const [claimedItems, setClaimedItems] = useState<Map<number, Set<number>>>(new Map());
  const [saving, setSaving] = useState(false);
  const [showImage, setShowImage] = useState(false);
  const [editingPersonIdx, setEditingPersonIdx] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingGroupSize, setEditingGroupSize] = useState(1);
  const [splittingItemIdx, setSplittingItemIdx] = useState<number | null>(null);
  const [splitQty, setSplitQty] = useState('');
  const [venmoHandle, setVenmoHandle] = useState('');
  const venmoInitRef = useRef(false);
  const { data: authSession, status: authStatus } = useSession();

  // --- tRPC ---
  const venmoSetting = trpc.admin.getVenmoEnabled.useQuery();
  const profile = trpc.auth.getProfile.useQuery(undefined, {
    enabled: !!authSession?.user && !!venmoSetting.data?.enabled,
  });
  const utils = trpc.useUtils();
  const setPayerVenmoHandle = trpc.guest.setPayerVenmoHandle.useMutation({
    onSuccess: () => {
      utils.guest.getSession.invalidate({ token });
    },
  });
  const session = trpc.guest.getSession.useQuery(
    { token },
    { refetchInterval: (query) => (query.state.data?.status === 'FINALIZED' || query.state.error ? false : 3000) },
  );

  const editPersonName = trpc.guest.editPersonName.useMutation({
    onSuccess: () => {
      setEditingPersonIdx(null);
      setEditingName('');
      toast.success(t('nameUpdated'));
    },
    onError: (err) => toast.error(err.message),
  });

  const removePerson = trpc.guest.removePerson.useMutation({
    onSuccess: (_data, variables) => {
      const removedIdx = variables.targetIndex;
      if (removedIdx === myPersonIndex) {
        removeStoredClaimIdentity(token);
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
      toast.success(t('personRemoved'));
    },
    onError: (err) => toast.error(err.message),
  });

  const finalizeSession = trpc.guest.finalizeSession.useMutation({
    onSuccess: () => {
      session.refetch();
      toast.success(t('splitFinalized'));
    },
    onError: (err) => toast.error(err.message),
  });

  const splitClaimItem = trpc.guest.splitClaimItem.useMutation({
    onSuccess: (_data, variables) => {
      const splitIdx = variables.itemIndex;
      setSplittingItemIdx(null);
      setSplitQty('');
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
  // Set synchronously when a join or resume starts. `joining` below comes from React state,
  // which only updates after a render, so a fast double tap could otherwise send two joins.
  // The server would return the same person for both (same join key), but the second spends
  // the per-person join limit and toasts again.
  const joinInFlight = useRef(false);
  // Person token from a personal link (#me=...) this page was opened with, if any
  const linkedToken = useRef<string | null>(null);
  // The person a personal link names, waiting for the user to confirm it's them
  const [linkOffer, setLinkOffer] = useState<ClaimIdentity | null>(null);
  // A personal link the user accepted, while it's looked up again: the card may have been open
  // while people were removed, which would make its person index stale
  const confirmedLinkToken = useRef<string | null>(null);
  // The join this page sent and hasn't seen succeed (see startJoin). Kept in memory, not in
  // storage: a stored pending key could be read and redeemed for the person before this device
  // holds their token. A reload therefore can't replay a lost join.
  const pendingJoin = useRef<PendingJoin | null>(null);

  // Become this person on this device, and remember it for the next visit. Also settles any
  // pending personal link, so its card can't come back later and switch this device again.
  function adoptIdentity(identity: ClaimIdentity) {
    setLinkOffer(null);
    linkedToken.current = null;
    confirmedLinkToken.current = null;
    setPersonIndex(identity.personIndex);
    setMyPersonIndex(identity.personIndex);
    setPersonToken(identity.personToken);
    setStoredClaimIdentity(token, { name: identity.name, personToken: identity.personToken });
    pendingJoin.current = null;
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
  }

  // The server returns the person under their current name, which may differ from the name
  // typed (see startJoin)
  const joinSession = trpc.guest.joinSession.useMutation({
    onSuccess: (data) => {
      adoptIdentity(data);
      toast.success(t('joinedSession'));
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => {
      joinInFlight.current = false;
    },
  });
  // A returning device finds its person by token (names can be edited by anyone): the token
  // this device stored, or one from a personal link. See resumeOutcome for what each answer
  // does, and shouldRetryResume for which failures are retried.
  const resumeSession = trpc.guest.resumeSession.useMutation({
    retry: (failureCount, error) => shouldRetryResume(failureCount, error.data?.httpStatus),
    onSuccess: (data, variables) => {
      const confirmed = variables.personToken === confirmedLinkToken.current;
      const outcome = resumeOutcome({
        found: data !== null,
        fromLink: variables.personToken === linkedToken.current,
        confirmed,
        personToken: variables.personToken,
        storedToken: getStoredClaimIdentity(token)?.personToken,
      });
      if (data && outcome === 'confirm') {
        // Don't silently become someone else (a personal link can be mis-shared)
        setLinkOffer({ ...data, personToken: variables.personToken });
      } else if (data && outcome === 'adopt') {
        adoptIdentity({ ...data, personToken: variables.personToken });
        if (confirmed) toast.success(t('continuingAs', { name: data.name }));
      } else if (outcome === 'linkInvalid') {
        // The user opened a personal link on purpose, so say why it didn't work
        toast.error(t('personalLinkInvalid'));
        setLinkOffer(null);
        setTimeout(resumeStoredIdentity, 0);
      } else if (outcome === 'forget') {
        removeStoredClaimIdentity(token);
      } else if (outcome === 'stale') {
        setTimeout(resumeStoredIdentity, 0);
      }
    },
    onError: (error, variables) => {
      if (variables.personToken !== linkedToken.current) return;
      toast.error(error.message);
      setLinkOffer(null);
      setTimeout(resumeStoredIdentity, 0);
    },
    onSettled: () => {
      joinInFlight.current = false;
    },
  });
  const joining = joinSession.isPending || resumeSession.isPending;

  // Resume whoever this device is stored as: when a personal link doesn't work out, or when an
  // answer came back for a token that's no longer stored. Called on the next tick from
  // resumeSession callbacks (after its onSettled has run), and directly by declineLinkOffer.
  // Does nothing while a join or resume is in flight: that request's answer decides, and it
  // reads the link refs cleared here.
  function resumeStoredIdentity() {
    if (joinInFlight.current) return;
    linkedToken.current = null;
    confirmedLinkToken.current = null;
    const stored = getStoredClaimIdentity(token);
    if (!stored) return;
    joinInFlight.current = true;
    resumeSession.mutate({ token, personToken: stored.personToken });
  }

  // Look the link's token up again rather than trusting the card's person index. Does nothing
  // once the card was declined, even in the same tick before it re-renders (declining clears
  // linkedToken).
  function acceptLinkOffer() {
    if (!linkOffer || joinInFlight.current || linkedToken.current !== linkOffer.personToken) return;
    joinInFlight.current = true;
    confirmedLinkToken.current = linkOffer.personToken;
    resumeSession.mutate({ token, personToken: linkOffer.personToken });
  }

  // Guarded like accept: both buttons can be tapped before `joining` disables them
  function declineLinkOffer() {
    if (joinInFlight.current) return;
    setLinkOffer(null);
    resumeStoredIdentity();
  }

  // A join sends the token this device stored (so the server returns that person, e.g. when
  // resuming failed and they typed their name, which someone may have changed) and a join key.
  // The join key is kept (in memory) until this device becomes someone, and reused only to retry
  // the same name, so a join whose response was lost (e.g. a network drop) is replayed as the
  // same person. The server mints new people's tokens itself.
  function startJoin(input: { name: string; groupSize?: number }) {
    if (joinInFlight.current) return;
    joinInFlight.current = true;
    const personToken = getStoredClaimIdentity(token)?.personToken;
    const pending = joinKeyFor(input.name, pendingJoin.current);
    pendingJoin.current = pending;
    joinSession.mutate({ token, ...input, joinKey: pending.joinKey, ...(personToken ? { personToken } : {}) });
  }

  // Initialize venmo handle from split record, then creator's profile as fallback
  useEffect(() => {
    if (venmoInitRef.current) return;
    if (session.data?.payerVenmoHandle) {
      setVenmoHandle(session.data.payerVenmoHandle);
      venmoInitRef.current = true;
    } else if (session.data?.isCreator && profile.data?.venmoUsername) {
      setVenmoHandle(profile.data.venmoUsername);
      venmoInitRef.current = true;
    } else if (
      session.data &&
      !session.isLoading &&
      authStatus !== 'loading' &&
      (profile.isFetched || !authSession?.user)
    ) {
      venmoInitRef.current = true;
    }
  }, [session.data, profile.data?.venmoUsername, profile.isFetched, session.isLoading, authSession?.user, authStatus]);

  // Read a personal link's token, then take it out of the address bar and this tab's history
  // entry (the browser's global history keeps the URL that was opened).
  useEffect(() => {
    const linked = readPersonalLinkToken(window.location.hash);
    if (linked) {
      linkedToken.current = linked;
      const clean = window.location.pathname + window.location.search;
      // Next.js patches history.replaceState once its own effects run, after this page's on
      // first mount. Called on the next tick with null state, the patched version keeps Next's
      // internal history state (back/forward) and updates the router's URL, so the token
      // isn't written back from router memory later.
      setTimeout(() => window.history.replaceState(null, '', clean), 0);
    }
    // A personal link pasted into a tab already on this page only changes the fragment;
    // reload so it is read like a fresh open. Read the link from the event, not location.hash:
    // in debug runs on one build, the URL had already been rewritten without the fragment
    // between popstate and hashchange (the writer wasn't captured). Restore it, then reload.
    const onHashChange = (event: HashChangeEvent) => {
      if (!readPersonalLinkToken(new URL(event.newURL).hash)) return;
      window.history.replaceState(null, '', event.newURL);
      window.location.reload();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Rejoin as the person this device joined as (or the one a personal link names) once the
  // session loads, in any status: a finalized split still needs to know who you are. A
  // personal link is tried first; for someone other than this device's person it asks first.
  useEffect(() => {
    if (autoRejoinAttempted.current || personIndex !== null || !session.data) return;

    const personToken = linkedToken.current ?? getStoredClaimIdentity(token)?.personToken;
    if (!personToken) return;

    // A join the user already started wins; resuming now could adopt a different person
    if (joinInFlight.current) return;
    autoRejoinAttempted.current = true;
    joinInFlight.current = true;
    resumeSession.mutate({ token, personToken });
  }, [session.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const claimItems = trpc.guest.claimItems.useMutation({
    onSuccess: (result) => {
      // Sync local Map from server after save so hasAnyUnsavedChanges resets
      session.refetch();
      if (result.conflicts && result.conflicts.length > 0) {
        const names = [...new Set(result.conflicts.flatMap((c) => c.claimedBy))];
        toast.warning(t('claimConflict', { names: names.join(', '), count: result.conflicts.length }));
      } else {
        toast.success(t('claimsSavedToast'));
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

  const hasUnsavedChanges = useMemo(() => {
    if (personIndex === null) return false;
    const currentClaims = claimedItems.get(personIndex ?? -1) ?? new Set<number>();
    const currentServerClaims = serverClaimsMap.get(personIndex ?? -1) ?? new Set<number>();
    if (currentClaims.size !== currentServerClaims.size) return true;
    for (const idx of currentClaims) {
      if (!currentServerClaims.has(idx)) return true;
    }
    return false;
  }, [claimedItems, serverClaimsMap, personIndex]);

  // Check if ANY person has unsaved local edits (not just the currently selected one)
  const hasAnyUnsavedChanges = useMemo(() => {
    for (const [pIdx, localSet] of claimedItems) {
      const serverSet = serverClaimsMap.get(pIdx) ?? new Set<number>();
      if (localSet.size !== serverSet.size) return true;
      for (const idx of localSet) {
        if (!serverSet.has(idx)) return true;
      }
    }
    return false;
  }, [claimedItems, serverClaimsMap]);

  // All items have at least one saved claimant
  const allItemsClaimed = useMemo(() => {
    if (!session.data) return false;
    return session.data.items.every((_, idx) =>
      session.data!.assignments.some((a) => a.itemIndex === idx && a.personIndices.length > 0),
    );
  }, [session.data]);

  // Which items are claimed by anyone (for sorting unclaimed first)
  const claimedByAnyone = useMemo(() => {
    if (!session.data) return new Set<number>();
    return new Set(session.data.assignments.filter((a) => a.personIndices.length > 0).map((a) => a.itemIndex));
  }, [session.data]);

  const sortedItemIndices = useMemo(() => {
    if (!session.data) return [];
    const unclaimed = session.data.items.map((_, idx) => idx).filter((idx) => !claimedByAnyone.has(idx));
    const claimed = session.data.items.map((_, idx) => idx).filter((idx) => claimedByAnyone.has(idx));
    return [...unclaimed, ...claimed];
  }, [session.data, claimedByAnyone]);

  // Calculate per-person totals using the full local claims Map merged with server assignments
  const splitTotals = useMemo(() => {
    if (!session.data) return [];

    const serverAssignments = session.data.assignments;

    // Build personWeights from group sizes
    const personWeights = session.data.people.map((p) => p.groupSize ?? 1);
    const hasWeights = personWeights.some((w) => w > 1);
    const weightsParam = hasWeights ? { personWeights } : {};

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
        ...weightsParam,
      });
    }

    return calculateSplitTotals({
      items: session.data.items,
      assignments: serverAssignments,
      tax: session.data.receiptData.tax,
      tip: session.data.receiptData.tip,
      peopleCount: session.data.people.length,
      ...weightsParam,
    });
  }, [session.data, claimedItems]);

  // --- Handlers ---
  function handleJoin() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('pleaseEnterName'));
      return;
    }
    startJoin({ name: trimmed, ...(groupSize > 1 ? { groupSize } : {}) });
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
    // The plain share link; never carry a #fragment, which could hold a personal token
    const url = new URL(window.location.href);
    url.hash = '';
    if (await copyToClipboard(url.toString())) {
      toast.success(t('linkCopied'));
    } else {
      toast.error(tc('actions.copyFailed'));
    }
  }

  // Share this person's own link, so they can continue as themselves on another device
  async function sharePersonalLink() {
    if (!personToken) return;
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = personalLinkHash(personToken);
    const link = url.toString();
    // Web Share opens the device's share sheet (Messages, AirDrop, email); it only exists in a
    // secure context (HTTPS or localhost), otherwise the link is copied
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: t('personalLinkShareTitle'), url: link });
        toast.warning(t('personalLinkShared'));
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Otherwise fall back to copying
      }
    }
    if (await copyToClipboard(link)) {
      toast.success(t('personalLinkCopied'));
    } else {
      toast.error(tc('actions.copyFailed'));
    }
  }

  async function copyResultLink() {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace(/\/claim$/, '');
    url.search = '';
    url.hash = '';
    if (await copyToClipboard(url.toString())) {
      toast.success(t('linkCopied'));
    } else {
      toast.error(tc('actions.copyFailed'));
    }
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
        <p className="text-muted-foreground">{t('loadingSession')}</p>
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
          <h2 className="text-xl font-bold">{t('sessionNotFound')}</h2>
          <p className="text-muted-foreground">
            {session.error.message.includes('expired') ? t('sessionExpired') : t('sessionInvalid')}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/split" />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          {t('splitYourOwn')}
        </Button>
      </div>
    );
  }

  const data = session.data!;
  const currency = data.receiptData.currency;

  // This person's own link for their other devices (joined or finalized view), with the
  // warning shown before anything is sent
  const personalLinkButton = personToken && (
    <Button type="button" variant="outline" size="sm" onClick={sharePersonalLink} data-testid="personal-link-btn">
      <MonitorSmartphone className="mr-2 h-4 w-4" />
      {t('continueOnAnotherDevice')}
    </Button>
  );
  const personalLinkHint = personToken && (
    <p className="text-xs text-muted-foreground" data-testid="personal-link-hint">
      {t('personalLinkHint')}
    </p>
  );

  // Asks before this device becomes the person a personal link names. If this device joined
  // as someone else, says so: continuing replaces them here, and only their own personal link
  // brings them back.
  const replacedIdentity = linkOffer && getStoredClaimIdentity(token);
  const linkOfferCard = linkOffer && (
    <Card className="border-primary/40" data-testid="personal-link-offer">
      <CardContent className="space-y-3 py-4">
        <p className="font-medium">{t('personalLinkOfferTitle', { name: linkOffer.name })}</p>
        <p className="text-sm text-muted-foreground">{t('personalLinkOfferBody', { name: linkOffer.name })}</p>
        {replacedIdentity && replacedIdentity.personToken !== linkOffer.personToken && (
          <p className="text-sm text-muted-foreground" data-testid="personal-link-offer-replaces">
            {t('personalLinkOfferReplaces', { current: replacedIdentity.name, name: linkOffer.name })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={acceptLinkOffer}
            disabled={joining}
            data-testid="personal-link-accept"
          >
            {t('continueAs', { name: linkOffer.name })}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={declineLinkOffer}
            disabled={joining}
            data-testid="personal-link-decline"
          >
            {t('notThisPerson')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  // --- Finalized state ---
  if (data.status === 'FINALIZED') {
    return (
      <div className="space-y-6 pb-8">
        {linkOfferCard}
        <div className="text-center space-y-2 pt-4">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Check className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-xl font-bold">{t('sessionFinalized')}</h2>
          <p className="text-muted-foreground">{t('sessionFinalizedDescription')}</p>
        </div>

        {/* Total */}
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="py-4">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-lg">{t('totalBill')}</span>
              <span className="text-2xl font-bold text-primary">
                {formatCents(data.receiptData.total, currency, locale)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Venmo handle */}
        {venmoSetting.data?.enabled &&
          currency === 'USD' &&
          (data.isCreator ? (
            <div className="flex items-center justify-center gap-2">
              <Input
                placeholder={tv('handlePlaceholder')}
                aria-label={tv('handle')}
                value={venmoHandle}
                onChange={(e) => setVenmoHandle(e.target.value)}
                onBlur={() => {
                  const trimmed = venmoHandle.trim() || null;
                  if (trimmed !== (session.data?.payerVenmoHandle ?? null)) {
                    setPayerVenmoHandle.mutate({ token, handle: trimmed });
                  }
                }}
                className="h-8 text-sm max-w-48"
                data-testid="venmo-handle-input"
              />
            </div>
          ) : venmoHandle ? (
            <p className="text-sm text-muted-foreground text-center" data-testid="venmo-handle-display">
              Venmo: @{venmoHandle.replace(/^@/, '')}
            </p>
          ) : null)}

        {/* Per-person summary */}
        {data.summary && data.summary.length > 0 && (
          <div className="space-y-3">
            <h3 className="font-semibold text-base">{t('perPersonTotals')}</h3>
            {data.summary.map((person: { name: string; total: number; personIndex: number }) => (
              <Card key={person.personIndex}>
                <CardContent className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className={`text-xs font-semibold ${guestAvatarColor(person.personIndex)}`}>
                          {getInitials(person.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{person.name}</span>
                    </div>
                    <span className="text-lg font-bold text-primary">
                      {formatCents(person.total, currency, locale)}
                    </span>
                  </div>
                  {venmoSetting.data?.enabled &&
                    currency === 'USD' &&
                    isValidVenmoHandle(venmoHandle) &&
                    myPersonIndex !== data.paidByIndex &&
                    person.personIndex !== data.paidByIndex && (
                      <a
                        href={buildVenmoPayUrl(
                          venmoHandle,
                          person.total,
                          `ShareTab: ${data.receiptData.merchantName ?? 'Bill split'}`,
                        )!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-[#008CFF] px-4 py-2 text-sm font-medium text-white hover:bg-[#0070CC] transition-colors"
                        data-testid={`venmo-pay-${person.personIndex}`}
                      >
                        {tv('payVia', { amount: formatCents(person.total, currency, locale) })}
                      </a>
                    )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="space-y-3">
          <Button className="w-full" nativeButton={false} render={<Link href={`/split/${token}`} />}>
            <ArrowRight className="mr-2 h-4 w-4" />
            {t('viewSummary')}
          </Button>
          <Button variant="outline" className="w-full" onClick={copyResultLink} data-testid="copy-link-btn">
            <Link2 className="mr-2 h-4 w-4" />
            {t('copyLink')}
          </Button>
          {personalLinkButton}
          {personalLinkHint}
        </div>
      </div>
    );
  }

  // --- Step 1: Enter name ---
  if (!hasJoined) {
    return (
      <div className="space-y-6 pb-8">
        {/* Header */}
        <div className="text-center space-y-1 pt-4">
          <h1 className="text-2xl font-bold">{data.receiptData.merchantName ?? t('billSplit')}</h1>
          {data.receiptData.date && <p className="text-sm text-muted-foreground">{data.receiptData.date}</p>}
        </div>

        {/* Total */}
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="py-4">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-lg">{t('totalBill')}</span>
              <span className="text-2xl font-bold text-primary">
                {formatCents(data.receiptData.total, currency, locale)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Copy link */}
        <Button type="button" variant="outline" size="sm" onClick={copyLink} data-testid="copy-link-btn">
          <Link2 className="mr-2 h-4 w-4" />
          {t('copyLink')}
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
              {showImage ? t('hideReceipt') : t('viewReceipt')}
            </Button>
            {showImage && (
              <Card>
                <CardContent className="p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded
                      receipt photo with unknown natural dimensions; next/image would need
                      either server-side dimension probing or a fill+aspect-ratio layout
                      change, out of scope here */}
                  <img
                    src={`/api/uploads/${data.receiptImagePath}`}
                    alt={t('receiptImage')}
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
                {t('peopleInSession', { count: data.people.length })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {data.people.map((person, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5">
                    <Avatar className="h-6 w-6">
                      <AvatarFallback className={`text-[10px] font-semibold ${guestAvatarColor(idx)}`}>
                        {getInitials(person.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium">
                      {person.name}
                      {person.groupSize > 1 && ` (×${person.groupSize})`}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {linkOfferCard}

        {/* Join form */}
        <Card data-testid="claim-join-form">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('joinSession')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name-input" className="text-sm font-medium">
                {t('yourName')}
              </label>
              <Input
                id="name-input"
                placeholder={t('enterName')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleJoin();
                }}
                autoFocus
                data-testid="claim-name-input"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="group-size" className="text-sm font-medium">
                {t('groupSize')}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="group-size"
                  type="number"
                  min={1}
                  max={20}
                  value={groupSize}
                  onChange={(e) => setGroupSize(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  className="w-20"
                  data-testid="group-size-input"
                />
                <span className="text-xs text-muted-foreground">{t('groupSizeHint')}</span>
              </div>
            </div>
            {/* Join as a listed person nobody has joined as yet (e.g. the payer); people who
                already joined can only be rejoined from the device holding their token. */}
            {data.people.some((person) => !person.hasJoined) && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('orJoinAs')}</p>
                <div className="flex flex-wrap gap-2">
                  {data.people.map((person, idx) =>
                    person.hasJoined ? null : (
                      <button
                        key={idx}
                        type="button"
                        disabled={joining}
                        onClick={() => {
                          setName(person.name);
                          startJoin({ name: person.name });
                        }}
                        className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 hover:bg-muted/80 transition-colors disabled:opacity-50"
                        data-testid={`rejoin-person-${idx}`}
                      >
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className={`text-[10px] font-semibold ${guestAvatarColor(idx)}`}>
                            {getInitials(person.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-medium">{person.name}</span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
            <Button
              className="w-full"
              onClick={handleJoin}
              disabled={!name.trim() || joining}
              data-testid="claim-join-btn"
            >
              {joining ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('joining')}
                </>
              ) : (
                <>
                  <ArrowRight className="mr-2 h-4 w-4" />
                  {t('join')}
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
        <h1 className="text-2xl font-bold">{data.receiptData.merchantName ?? t('billSplit')}</h1>
        {data.receiptData.date && <p className="text-sm text-muted-foreground">{data.receiptData.date}</p>}
      </div>

      {/* Total */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="py-4">
          <div className="flex justify-between items-center">
            <span className="font-semibold text-lg">{t('totalBill')}</span>
            <span className="text-2xl font-bold text-primary">
              {formatCents(data.receiptData.total, currency, locale)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Copy link, and this person's own link for their other devices */}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyLink} data-testid="copy-link-btn">
          <Link2 className="mr-2 h-4 w-4" />
          {t('copyLink')}
        </Button>
        {personalLinkButton}
      </div>
      {personalLinkHint}

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
            {showImage ? t('hideReceipt') : t('viewReceipt')}
          </Button>
          {showImage && (
            <Card>
              <CardContent className="p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded
                    receipt photo with unknown natural dimensions; next/image would need
                    either server-side dimension probing or a fill+aspect-ratio layout
                    change, out of scope here */}
                <img
                  src={`/api/uploads/${data.receiptImagePath}`}
                  alt={t('receiptImage')}
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
            {t('peopleInSession', { count: data.people.length })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {data.people.map((person, idx) => (
              <div
                key={idx}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
                  idx === myPersonIndex ? 'bg-primary/10 ring-1 ring-primary' : 'bg-muted'
                }`}
              >
                <Avatar className="h-6 w-6 shrink-0">
                  <AvatarFallback className={`text-[10px] font-semibold ${guestAvatarColor(idx)}`}>
                    {getInitials(person.name)}
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
                        groupSize: editingGroupSize,
                      });
                    }}
                  >
                    <Input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="h-7 text-sm flex-1"
                      autoFocus
                      aria-label={t('editName')}
                      data-testid={`edit-name-input-${idx}`}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={editingGroupSize}
                      onChange={(e) => setEditingGroupSize(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                      className="h-7 w-14 text-sm"
                      aria-label={t('groupSize')}
                      data-testid={`edit-group-size-${idx}`}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={editPersonName.isPending}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setEditingPersonIdx(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium">
                      {person.name}
                      {person.groupSize > 1 && (
                        <span data-testid={`group-badge-${idx}`}>{` (×${person.groupSize})`}</span>
                      )}
                      {idx === myPersonIndex && ` ${t('you')}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPersonIdx(idx);
                        setEditingName(person.name);
                        setEditingGroupSize(person.groupSize ?? 1);
                      }}
                      className="text-muted-foreground hover:text-foreground p-1"
                      aria-label={t('editName')}
                      data-testid={`edit-person-${idx}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {data.people.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t('removePersonConfirm', { name: person.name }))) {
                            removePerson.mutate({
                              token,
                              personToken: personToken!,
                              targetIndex: idx,
                            });
                          }
                        }}
                        className="text-muted-foreground hover:text-destructive p-1"
                        aria-label={t('removePerson')}
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
        <p className="text-sm font-medium">{t('claimingFor')}</p>
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
                  ? 'bg-primary text-primary-foreground ring-2 ring-primary'
                  : 'bg-muted hover:bg-muted/80'
              }`}
            >
              <Avatar className="h-6 w-6">
                <AvatarFallback
                  className={`text-[10px] font-semibold ${idx === personIndex ? 'bg-primary-foreground/20 text-primary-foreground' : guestAvatarColor(idx)}`}
                >
                  {getInitials(person.name)}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">
                {person.name}
                {person.groupSize > 1 && ` (×${person.groupSize})`}
                {idx === myPersonIndex && ` ${t('you')}`}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Items to claim */}
      <div className="space-y-3">
        <h3 className="font-semibold text-base">
          {t('tapToClaim')}
          {hasUnsavedChanges && (
            <Badge variant="secondary" className="ml-2">
              {t('unsavedChanges')}
            </Badge>
          )}
        </h3>
        {sortedItemIndices.map((idx, sortPosition) => {
          const item = data.items[idx]!;
          const isClaimed = (claimedItems.get(personIndex!) ?? new Set()).has(idx);
          // Find other claimants from server state
          const otherClaimants =
            data.assignments.find((a) => a.itemIndex === idx)?.personIndices.filter((pi) => pi !== personIndex) ?? [];

          // Show separator before the first claimed item
          const isFirstClaimed =
            sortPosition > 0 && claimedByAnyone.has(idx) && !claimedByAnyone.has(sortedItemIndices[sortPosition - 1]!);

          return (
            <div key={idx}>
              {isFirstClaimed && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground">{t('alreadyClaimed')}</span>
                  <div className="flex-1 h-px bg-border" />
                </div>
              )}
              <Card
                role="button"
                aria-pressed={isClaimed}
                tabIndex={0}
                data-testid={`claim-item-${idx}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleClaim(idx);
                  }
                }}
                className={`cursor-pointer transition-all ${
                  isClaimed ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
                onClick={() => toggleClaim(idx)}
              >
                <CardContent className="py-3">
                  <div className="flex items-center gap-3">
                    {/* Claim indicator */}
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                        isClaimed ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {isClaimed && <Check className="h-4 w-4" />}
                    </div>

                    {/* Item details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`font-medium truncate ${isClaimed ? 'text-foreground' : 'text-muted-foreground'}`}
                        >
                          {item.name}
                          {item.quantity > 1 && <span className="text-muted-foreground ml-1">x{item.quantity}</span>}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          {item.quantity > 1 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSplittingItemIdx(idx);
                                setSplitQty('1');
                              }}
                              className="text-muted-foreground hover:text-foreground p-1"
                              aria-label={t('splitItem')}
                              data-testid={`split-claim-item-${idx}`}
                            >
                              <Scissors className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <span className="font-semibold">{formatCents(item.totalPrice, currency, locale)}</span>
                        </div>
                      </div>

                      {/* Split form */}
                      {splittingItemIdx === idx &&
                        (() => {
                          const parsed = Number(splitQty);
                          const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                          return (
                            <div
                              className="flex items-center gap-2 mt-2"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <span className="text-xs text-muted-foreground">{t('splitOff')}</span>
                              <Input
                                type="number"
                                min={1}
                                max={item.quantity - 1}
                                value={splitQty}
                                onChange={(e) => setSplitQty(e.target.value)}
                                className="w-16 h-7 text-xs"
                                aria-label={t('splitOff')}
                                data-testid={`split-qty-input-${idx}`}
                              />
                              <span className="text-xs text-muted-foreground">
                                {t('splitOfTotal', { total: item.quantity })}
                              </span>
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
                                {t('splitButton')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSplittingItemIdx(null);
                                }}
                              >
                                {t('cancelButton')}
                              </Button>
                            </div>
                          );
                        })()}

                      {/* Other claimants */}
                      {otherClaimants.length > 0 && (
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-xs text-muted-foreground">{t('alsoClaimedBy')}</span>
                          <div className="flex -space-x-1">
                            {otherClaimants.map((pi) => (
                              <Avatar key={pi} className="h-5 w-5 border-2 border-background">
                                <AvatarFallback className={`text-[8px] font-semibold ${guestAvatarColor(pi)}`}>
                                  {getInitials(data.people[pi]?.name ?? '?')}
                                </AvatarFallback>
                              </Avatar>
                            ))}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {otherClaimants.map((pi) => data.people[pi]?.name ?? '?').join(', ')}
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
          <h3 className="font-semibold text-base">{t('perPersonTotals')}</h3>
          {splitTotals.map((person) => {
            const personName =
              data.people[person.personIndex]?.name ?? t('personFallback', { index: person.personIndex + 1 });
            const isMe = person.personIndex === myPersonIndex;
            const isActive = person.personIndex === personIndex;

            return (
              <Card key={person.personIndex} className={isActive ? 'ring-2 ring-primary' : ''}>
                <CardContent className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className={`text-xs font-semibold ${guestAvatarColor(person.personIndex)}`}>
                          {getInitials(personName)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium">
                        {personName}
                        {isMe && ` ${t('you')}`}
                      </span>
                    </div>
                    <span className="text-lg font-bold text-primary">
                      {formatCents(person.total, currency, locale)}
                    </span>
                  </div>
                  {(person.tax > 0 || person.tip > 0) && (
                    <div className="ml-11 mt-1 flex gap-3 text-xs text-muted-foreground">
                      <span>{t('items', { amount: formatCents(person.itemTotal, currency, locale) })}</span>
                      {person.tax > 0 && (
                        <span>{t('taxAmount', { amount: formatCents(person.tax, currency, locale) })}</span>
                      )}
                      {person.tip > 0 && (
                        <span>{t('tipAmount', { amount: formatCents(person.tip, currency, locale) })}</span>
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
        <Link href="/split" className="text-sm font-medium text-primary hover:underline">
          {t('splitYourOwn')}
        </Link>
        <span className="text-muted-foreground mx-2">{t('or')}</span>
        <Link href="/register" className="text-sm font-medium text-primary hover:underline">
          {t('createAccount')}
        </Link>
      </div>

      {/* Save button - sticky bottom */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t">
        <div className="mx-auto max-w-lg">
          {/* Finalize button -- only when no unsaved changes and all items claimed */}
          {!hasAnyUnsavedChanges &&
            personToken &&
            myPersonIndex !== null &&
            !finalizeSession.isPending &&
            allItemsClaimed && (
              <Button
                variant="outline"
                className="w-full h-12 mb-2"
                onClick={() => {
                  if (confirm(t('finalizeConfirm'))) {
                    finalizeSession.mutate({
                      token,
                      personIndex: myPersonIndex,
                      personToken,
                    });
                  }
                }}
                disabled={finalizeSession.isPending}
                data-testid="finalize-btn"
              >
                {t('finalizeSplit')}
              </Button>
            )}
          {finalizeSession.isPending && (
            <Button variant="outline" className="w-full h-12 mb-2" disabled>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              {t('finalizing')}
            </Button>
          )}
          <Button
            className="w-full h-14"
            onClick={saveClaims}
            disabled={saving || !hasUnsavedChanges}
            data-testid="save-claims-btn"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                {t('saving')}
              </>
            ) : hasUnsavedChanges ? (
              <>
                <Check className="mr-2 h-5 w-5" />
                {t('saveClaimsFor', { name: data.people[personIndex!]?.name ?? '' })}
              </>
            ) : (
              <>
                <Check className="mr-2 h-5 w-5" />
                {t('claimsSaved')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
