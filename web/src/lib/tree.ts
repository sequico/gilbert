/**
 * Depth-first search for the first node a predicate accepts.
 *
 * Two surfaces walk a tree this way — the S/MIME part finder over `MimePart`
 * (`lib/smime/mime.ts`) and the reading pane over `EmailBodyPart`
 * (`views/mail/MessageView.tsx`) — and each had written the same recursion,
 * with the same visit order and the same "first match wins" answer. One loop
 * here, with the children accessor passed in, so the two cannot drift apart.
 */
export function findInTree<T>(
  node: T | undefined,
  children: (n: T) => readonly T[] | undefined,
  want: (n: T) => boolean,
): T | undefined {
  if (!node) return undefined;
  if (want(node)) return node;
  for (const child of children(node) ?? []) {
    const hit = findInTree(child, children, want);
    if (hit) return hit;
  }
  return undefined;
}
