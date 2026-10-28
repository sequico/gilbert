// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeTransfer, MAX_MIME_DEPTH, parseMime } from "../mime";

/**
 * Two limits the parser has to keep while reading bytes a sender wrote.
 *
 * The multipart recursion follows the nesting the message names, so without a
 * cap a body built to nest is a way to bring the parser's stack down instead of
 * being refused; and quoted-printable is a codec whose escape has to be checked,
 * because the byte it decodes to is what a signature gets verified against.
 */

const enc = (s: string) => new TextEncoder().encode(s);

/** `depth` nested `multipart/mixed` levels around a one-line text part. */
function nested(depth: number): Uint8Array {
  let inner = "Content-Type: text/plain\r\n\r\nhi\r\n";
  for (let i = 0; i < depth; i++) {
    const b = `b${i}`;
    inner = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${inner}--${b}--\r\n`;
  }
  return enc(inner);
}

describe("how deep the parser will go", () => {
  it("parses ordinary nesting", () => {
    expect(parseMime(nested(3)).contentType).toBe("multipart/mixed");
    expect(parseMime(nested(3)).parts).toHaveLength(1);
  });

  it("refuses nesting past the cap rather than overrunning the stack", () => {
    expect(() => parseMime(nested(MAX_MIME_DEPTH * 3))).toThrow(/deeper than/);
  });
});

describe("quoted-printable decoding", () => {
  it("reads a valid escape", () => {
    const part = parseMime(
      enc("Content-Transfer-Encoding: quoted-printable\r\n\r\n=41B"),
    );
    expect(new TextDecoder().decode(decodeTransfer(part))).toBe("AB");
  });

  it("refuses a malformed escape rather than decoding it to a zero byte", () => {
    const part = parseMime(enc("Content-Transfer-Encoding: quoted-printable\r\n\r\n=ZZ"));
    expect(() => decodeTransfer(part)).toThrow(/hexadecimal/);
  });
});
