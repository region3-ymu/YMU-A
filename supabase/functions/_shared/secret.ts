// @ts-nocheck
// Constant-time shared-secret comparison for the scheduled Edge Functions'
// x-*-secret header. A plain `provided !== expected` on strings both
// short-circuits on the first differing byte (a timing side-channel) and, via
// a length check, leaks the secret's length. Comparing fixed-length SHA-256
// digests removes both: every comparison touches the same 32 bytes regardless
// of input, and the raw secret's length never affects timing. Mirrors (and now
// centralizes) the timing-safe compare the Zoho webhook route already used.
export async function secretsMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided ?? "")),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}
