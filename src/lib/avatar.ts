const avatarColors = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-fuchsia-500',
  'bg-lime-500',
];

export function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  // Modulo always lands in bounds; fallback is unreachable but keeps the
  // return type `string` instead of `string | undefined`.
  return avatarColors[Math.abs(hash) % avatarColors.length] ?? 'bg-blue-500';
}

const guestColors = [
  'bg-red-100 text-red-700',
  'bg-blue-100 text-blue-700',
  'bg-green-100 text-green-700',
  'bg-purple-100 text-purple-700',
  'bg-amber-100 text-amber-700',
  'bg-pink-100 text-pink-700',
  'bg-teal-100 text-teal-700',
  'bg-indigo-100 text-indigo-700',
];

export function guestAvatarColor(index: number): string {
  // Modulo always lands in bounds; fallback is unreachable but keeps the
  // return type `string` instead of `string | undefined`.
  return guestColors[Math.abs(Math.floor(index)) % guestColors.length] ?? 'bg-red-100 text-red-700';
}

export function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    return (
      name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2) || '?'
    );
  }
  return email?.[0]?.toUpperCase() ?? '?';
}

/**
 * Labels for a row of person chips, one per name in order: the first name,
 * or the whole name when someone else in the row has the same first name, so
 * "Bob" and "Bob Smith" don't both read "Bob" (#277). People with identical
 * names still look the same; nothing in the name tells them apart.
 */
export function chipLabels(names: readonly (string | null | undefined)[]): string[] {
  const words = names.map((name) => name?.trim().split(/\s+/).filter(Boolean) ?? []);
  const firstNameCounts = new Map<string, number>();
  for (const [first] of words) {
    if (first) firstNameCounts.set(first.toLowerCase(), (firstNameCounts.get(first.toLowerCase()) ?? 0) + 1);
  }
  return words.map(([first, ...rest]) => {
    if (!first) return '?';
    return (firstNameCounts.get(first.toLowerCase()) ?? 0) > 1 ? [first, ...rest].join(' ') : first;
  });
}
