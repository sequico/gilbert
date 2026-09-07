import { describe, expect, it } from "vitest";
import { remoteImagesAllowed } from "@/lib/remoteImages";

/**
 * The one remote-image decision, shared by the message reader and the
 * composer's quote path. A reply used to fetch the quoted mail's tracking
 * pixels regardless of what the reader had decided for that very message; the
 * decision is a property of (settings, sender), and both seats derive it
 * from this function so they cannot drift apart again.
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
