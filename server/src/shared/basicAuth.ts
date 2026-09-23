/**
 * The `Authorization` header a plain principal authenticates with.
 *
 * One implementation, because both programs read it: the server builds it to
 * reach Stalwart and to sign in an agent, and the client's program
 * type-checks the same file. `btoa` over the UTF-8 bytes rather than `Buffer`,
 * so a node built-in does not have to reach a bundle through it.
 */
export function basicAuth(address: string, password: string): string {
  const bytes = new TextEncoder().encode(`${address}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
