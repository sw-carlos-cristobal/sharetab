export function normalizeVenmoHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").trim();
}

export function isValidVenmoHandle(handle: string): boolean {
  const normalized = normalizeVenmoHandle(handle);
  return normalized.length > 0 && !/\s/.test(normalized);
}

export function buildVenmoPayUrl(handle: string, amountCents: number, note: string): string | null {
  const normalized = normalizeVenmoHandle(handle);
  if (!normalized || /\s/.test(normalized)) return null;
  const amount = (amountCents / 100).toFixed(2);
  return `https://venmo.com/${encodeURIComponent(normalized)}?txn=pay&amount=${amount}&note=${encodeURIComponent(note)}`;
}
