import { isIP } from "node:net";

/**
 * Work out who is really talking to us, for rate limiting and session records.
 *
 * `X-Forwarded-For` is a list that each hop appends to, so the entry nearest
 * the right is the one our own proxy observed and the entries to its left were
 * supplied by whoever came before — including the client. nginx's
 * `$proxy_add_x_forwarded_for` appends, so a client sending
 * `X-Forwarded-For: 1.2.3.4` arrives as `1.2.3.4, <their real address>`:
 * reading the leftmost entry hands an attacker a rate-limit key they can
 * change at will. Read from the right instead, skipping hops we run ourselves,
 * and only believe the header at all when the peer is a proxy we trust.
 */

/** Peers whose forwarding headers are believed when none are configured. */
const DEFAULT_TRUSTED = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
];

export interface TrustConfig {
  trustProxy: boolean;
  /** CIDRs or bare addresses; empty means DEFAULT_TRUSTED. */
  trustedProxies: string[];
}

function toBits(addr: string): { value: bigint; width: number } | null {
  const v = isIP(addr);
  if (v === 4) {
    const parts = addr.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return null;
    return { value: parts.reduce((acc, n) => (acc << 8n) | BigInt(n), 0n), width: 32 };
  }
  if (v === 6) {
    // Expand "::" and any embedded IPv4 tail into eight 16-bit groups.
    let text = addr;
    const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (tail) {
      const b = tail[1]!.split(".").map(Number);
      text = `${text.slice(0, tail.index)}:${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
    }
    const [head, rest] = text.split("::");
    const left = head ? head.split(":").filter(Boolean) : [];
    const right =
      rest !== undefined ? (rest ? rest.split(":").filter(Boolean) : []) : null;
    const groups =
      right === null
        ? left
        : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
    if (groups.length !== 8) return null;
    let value = 0n;
    for (const g of groups) {
      const n = parseInt(g, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      value = (value << 16n) | BigInt(n);
    }
    return { value, width: 128 };
  }
  return null;
}

/** Is `addr` inside `range`, which may be a CIDR or a single address? */
export function inRange(addr: string, range: string): boolean {
  const [net, bitsText] = range.trim().split("/");
  const a = toBits(addr);
  const n = toBits(net ?? "");
  if (!a || !n || a.width !== n.width) return false;
  const bits = bitsText === undefined ? n.width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > n.width) return false;
  if (bits === 0) return true;
  const shift = BigInt(n.width - bits);
  return a.value >> shift === n.value >> shift;
}

export function isTrustedProxy(addr: string, cfg: TrustConfig): boolean {
  const ranges = cfg.trustedProxies.length ? cfg.trustedProxies : DEFAULT_TRUSTED;
  return ranges.some((r) => inRange(addr, r));
}

export interface ForwardHeaders {
  forwardedFor?: string;
  realIp?: string;
}

/**
 * The client address to attribute a request to. `peer` is the socket address,
 * which is the only part nobody downstream can forge.
 */
/**
 * The same client, spelled one way.
 *
 * An IPv4 client reaching a dual-stack socket arrives as `::ffff:a.b.c.d`, and
 * that — not the dotted quad — is what Node reports for the peer. So the same
 * client would be one address when a trusted proxy forwarded it and another
 * when it connected directly, and everything keyed on the address would see
 * two: the sign-in rate limits, which would spend a *shared* budget for every
 * IPv4 client on an installation behind one; and the address recorded on a
 * session.
 *
 * The mapping is the only difference between the two spellings — the address
 * is the same address — so this is a spelling of the input and not a policy
 * about it, and it is applied once, here, for every reader.
 */
export function normalizeClientIp(ip: string): string {
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/**
 * The client address to attribute a request to. `peer` is the socket address,
 * which is the only part nobody downstream can forge.
 *
 * Always the normalised spelling, whatever path inside produced it: an address
 * a caller can key on is worth one guarantee rather than one per return.
 */
export function resolveClientIp(
  peer: string,
  headers: ForwardHeaders,
  cfg: TrustConfig,
): string {
  return normalizeClientIp(resolveRawClientIp(peer, headers, cfg));
}

function resolveRawClientIp(
  peer: string,
  headers: ForwardHeaders,
  cfg: TrustConfig,
): string {
  if (!cfg.trustProxy || !peer || peer === "unknown") return peer || "unknown";
  // A peer we do not run is not allowed to tell us who its client is.
  if (!isTrustedProxy(peer, cfg)) return peer;
  const chain = (headers.forwardedFor ?? "")
    .split(",")
    .map((s) => normalizeClientIp(s.trim().replace(/^\[|\]$/g, "")))
    .filter((s) => isIP(s) !== 0);
  // Rightmost first: the last hop we trust is ours, anything left of the first
  // untrusted entry was written by someone we have no reason to believe.
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(chain[i]!, cfg)) return chain[i]!;
  }
  if (chain.length) return chain[0]!;
  const real = headers.realIp?.trim();
  return real && isIP(real) !== 0 ? real : peer;
}

/**
 * The key a rate limit counts an address under.
 *
 * An IPv4 address is the key as it is. An IPv6 address is cut to its /64: that
 * is the smallest block an ISP or a VPS hands out, so anyone who holds one
 * address holds 2^64 of them, and a limit keyed on the full address is no
 * limit at all. Everyone behind one /64 shares a budget, which is the same
 * bargain an IPv4 NAT already makes.
 *
 * The address is normalised first (`normalizeClientIp`), because a mapped
 * spelling would otherwise cut an **IPv4** client to a /64 made of nothing but
 * the mapping — one key shared by every IPv4 client there is, which is a limit
 * on the installation rather than on the attacker.
 */
export function rateLimitKey(ip: string): string {
  const addr = normalizeClientIp(ip);
  if (isIP(addr) !== 6) return addr;
  const bits = toBits(addr);
  if (!bits) return addr;
  const prefix = bits.value >> 64n;
  const groups = [48n, 32n, 16n, 0n].map((s) => ((prefix >> s) & 0xffffn).toString(16));
  return `${groups.join(":")}::/64`;
}
