import { describe, expect, it } from "vitest";
import { type Asn1, oid, TAG } from "@/lib/smime/der";
import { ecdsaDerToRaw } from "@/lib/smime/verify";

/**
 * The DER primitives S/MIME verification rests on. Both bugs here were silent
 * misreads rather than throws: a wrong OID still formats, and a mis-offset
 * ECDSA signature still parses to bytes — it just fails to verify, which reads
 * as a bad signature rather than a bad decoder.
 */

const oidNode = (content: number[]): Asn1 => ({
  tag: TAG.oid,
  cls: 0,
  constructed: false,
  content: new Uint8Array(content),
  bytes: new Uint8Array(),
});

describe("OID decoding", () => {
  it("decodes the two-arc first subidentifier in base-128", () => {
    // 2.999 packs as 1079 = 0x88 0x37; reading only the low octet gives
    // "3.16.55".
    expect(oid(oidNode([0x88, 0x37]))).toBe("2.999");
  });

  it("decodes an ordinary OID", () => {
    expect(oid(oidNode([0x2a, 0x86, 0x48]))).toBe("1.2.840");
  });
});

describe("ECDSA DER to raw", () => {
  it("refuses BER's indefinite length", () => {
    expect(ecdsaDerToRaw(new Uint8Array([0x30, 0x80]), "P-256")).toBeNull();
  });

  it("decodes a well-formed P-256 signature", () => {
    const r = new Uint8Array(32).fill(1);
    const s = new Uint8Array(32).fill(2);
    const der = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
    const raw = ecdsaDerToRaw(der, "P-256");
    expect(raw).not.toBeNull();
    expect(raw!.length).toBe(64);
    expect(raw!.slice(0, 32)).toEqual(r);
    expect(raw!.slice(32)).toEqual(s);
  });
});
