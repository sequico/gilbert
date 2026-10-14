import { describe, expect, it } from "vitest";
import { remoteImagesAllowed, remoteImagesLoadable } from "@/lib/remoteImages";
import { readSource } from "./readSource";

/**
 * The one remote-image decision, shared by the message reader and the
 * composer's quote path. The decision is a property of (settings, sender): a
 * reply that fetched the quoted mail's tracking pixels regardless of what the
 * reader had decided for that very message is the defect this prevents, and
 * both seats derive the answer from this function so they cannot drift apart.
 */
describe("remoteImagesAllowed", () => {
  const base = {
    policy: "ask" as const,
    trustedSenders: [],
  };

  it("blocks under the ask policy unless the sender is trusted", () => {
    expect(remoteImagesAllowed({ ...base, senderEmail: "ann@example.com" })).toBe(false);
    expect(
      remoteImagesAllowed({
        ...base,
        senderEmail: "ann@example.com",
        trustedSenders: ["ann@example.com"],
      }),
    ).toBe(true);
  });

  it("shows always when the installation or reader says always", () => {
    expect(
      remoteImagesAllowed({ ...base, policy: "always", senderEmail: "x@y.test" }),
    ).toBe(true);
  });

  it("trusts by the whole address, lowercased", () => {
    expect(
      remoteImagesAllowed({
        ...base,
        senderEmail: "Ann@Example.COM",
        trustedSenders: ["ann@example.com"],
      }),
    ).toBe(true);
    // A different address on the same domain is not trusted.
    expect(
      remoteImagesAllowed({
        ...base,
        senderEmail: "bo@example.com",
        trustedSenders: ["ann@example.com"],
      }),
    ).toBe(false);
  });

  it("opens for contacts only under the contacts policy", () => {
    expect(
      remoteImagesAllowed({
        policy: "contacts",
        trustedSenders: [],
        senderEmail: "ann@example.com",
        inContacts: true,
      }),
    ).toBe(true);
    expect(
      remoteImagesAllowed({
        policy: "contacts",
        trustedSenders: [],
        senderEmail: "ann@example.com",
        inContacts: false,
      }),
    ).toBe(false);
    // Trusted beats the policy: an address the reader allowed once is allowed
    // even when the policy is ask.
    expect(
      remoteImagesAllowed({
        policy: "ask",
        trustedSenders: ["ann@example.com"],
        senderEmail: "ann@example.com",
      }),
    ).toBe(true);
  });

  it("blocks a message with no From", () => {
    expect(remoteImagesAllowed({ ...base, senderEmail: null, inContacts: true })).toBe(
      false,
    );
  });
});

/**
 * The other half of the same decision: what the reader may have is not the same
 * as what the installation can give.
 *
 * A remote image loads only through the server's proxy -- the app's CSP refuses
 * a direct fetch (see APP_CSP in server/src/static.ts) -- so an installation with
 * the proxy off has nothing to show, and the reader's click cannot conjure one.
 * The message reader asks this rather than `remoteImagesAllowed` alone, and the
 * value it gets is the one the banner reads.
 */
describe("remoteImagesLoadable", () => {
  it("needs the reader's answer and the installation's proxy", () => {
    expect(remoteImagesLoadable(true, true)).toBe(true);
    expect(remoteImagesLoadable(true, false)).toBe(false);
    expect(remoteImagesLoadable(false, true)).toBe(false);
    expect(remoteImagesLoadable(false, false)).toBe(false);
  });

  it("is what the message reader asks", () => {
    const source = readSource("src/views/mail/MessageView.tsx");
    expect(source).toContain("remoteImagesLoadable(");
  });
});
