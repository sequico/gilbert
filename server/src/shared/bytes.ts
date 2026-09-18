/**
 * Whether two byte sequences are the same, once for both tiers.
 *
 * Both tiers compare stored bytes answer for answer: the client checks a
 * signature against the one it already has, the server checks what a write
 * would store against what is already in the account, and a comparison that
 * answers differently on the two sides is a write nobody can explain.
 *
 * The accumulator compares every byte rather than returning at the first
 * difference: the two sequences are a signed document and what is stored, and
 * an early exit is a comparison whose running time says where they differ.
 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
