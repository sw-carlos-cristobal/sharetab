export function buildVenmoPayUrl(handle: string, amountCents: number, note: string): string {
  const normalized = handle.trim().replace(/^@/, "");
  const amount = (amountCents / 100).toFixed(2);
  return `https://venmo.com/${encodeURIComponent(normalized)}?txn=pay&amount=${amount}&note=${encodeURIComponent(note)}`;
}
