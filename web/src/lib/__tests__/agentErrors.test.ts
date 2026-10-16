import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/jmap/client";
import { agentErrorSentence } from "@/lib/agentErrors";
import { type Catalog, setCatalog } from "@/lib/i18n";

/**
 * The credential refusal, client side.
 *
 * The server answers with a code (`agent_credentials_rejected` /
 * `agent_unreachable`) and never with the sentence itself, because a sentence
 * composed there is English no catalogue can translate. So the client composes
 * it, and these are the claims that make that worth doing: each code has a
 * sentence, no sentence leaves a parameter unfilled, a code from somewhere else
 * is not given a sentence of its own, and a language whose catalogue carries
 * the sentence shows its own.
 */

afterEach(() => {
  setCatalog("en", { strings: {}, plurals: {} });
  vi.unstubAllGlobals();
});

describe("the sentence a credential refusal reads as", () => {
  it("fills the detail the server sent", () => {
    expect(
      agentErrorSentence({
        error: "agent_unreachable",
        detail: "the account did not answer",
      }),
    ).toBe("The Master's session could not be opened: the account did not answer");
  });

  it("says Master, leaves no hole unfilled, and names no agent", () => {
    for (const code of ["agent_credentials_rejected", "agent_unreachable"]) {
      const sentence = agentErrorSentence({ error: code, detail: "the server said so" })!;
      // A parameter left unfilled is a sentence with `{detail}` in it, which is
      // the failure this whole arrangement exists to avoid.
      expect(sentence, code).toBeTruthy();
      expect(sentence, code).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(sentence, code).toContain("Master");
      expect(sentence, code).not.toMatch(/\bagent\b/i);
    }
  });

  it("answers null for a code it does not know, rather than inventing one", () => {
    expect(agentErrorSentence({ error: "not_a_code" })).toBeNull();
    expect(agentErrorSentence({})).toBeNull();
  });

  it("does not answer for a member of Object.prototype", () => {
    // `code in table` would find `constructor` and `toString` on the prototype
    // and hand back a sentence for a code nobody defined.
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__"])
      expect(agentErrorSentence({ error: code })).toBeNull();
  });

  it("reads its own language when the catalogue carries the sentence", () => {
    setCatalog("it", {
      strings: {
        "The Master's session could not be opened: {detail}":
          "La sessione non si è aperta: {detail}",
      },
      plurals: {},
    } as Catalog);
    expect(agentErrorSentence({ error: "agent_unreachable", detail: "refused" })).toBe(
      "La sessione non si è aperta: refused",
    );
  });
});

describe("apiFetch composes a credential refusal from what the route answers", () => {
  it("turns a code and its parameters into the sentence a caller reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 409,
            json: async () => ({
              error: "agent_credentials_rejected",
              detail: "the credential was refused",
            }),
          }) as Response,
      ),
    );
    const err = await apiFetch("/api/admin/groups/legal@example.org/labels", {
      method: "PUT",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      "The server refused the Master's credential, so the Master cannot be reached: the credential was refused. Check that GILBERT_AGENT_ADDRESS and GILBERT_AGENT_PASSWORD name the Master's own address and its account password, then restart the server.",
    );
  });
});
