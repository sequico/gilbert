import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/jmap/client";
import {
  AGENT_ERROR_CODES,
  AGENT_ERROR_SENTENCES,
  agentErrorSentence,
} from "@/lib/agentErrors";
import { type Catalog, setCatalog } from "@/lib/i18n";

/**
 * The admin refusal, client side.
 *
 * The admin surface answers with a code and its parameters — `AgentErrorReason`
 * — and never with a sentence, because a sentence composed on the server is
 * English no catalogue can translate. So the client composes it, and these are
 * the claims that make the change worth making: every code has a sentence, no
 * sentence leaves a parameter unfilled, a code from somewhere else is not given
 * a sentence of its own, and a language whose catalogue carries the sentence
 * shows its own.
 */

afterEach(() => {
  setCatalog("en", { strings: {}, plurals: {} });
  vi.unstubAllGlobals();
});

/** Every parameter any sentence uses, filled, so a hole left unfilled shows. */
const FILLED = {
  address: "gilbert@example.org",
  detail: "the server said so",
  id: "r1",
  index: 1,
  name: "Move invoices",
  problems: "tier: not a tier",
  key: "T3",
  tier: "T2",
  movedTo: "https://models.example.org",
  host: "10.0.0.5",
  max: 2000,
  length: 2100,
};

describe("the sentence an admin refusal reads as", () => {
  it("has one for every code the server can answer with", () => {
    const codes = Object.keys(AGENT_ERROR_SENTENCES);
    expect(codes.length).toBe(AGENT_ERROR_CODES.size);
    for (const code of codes) {
      const sentence = agentErrorSentence({ error: code, ...FILLED });
      expect(sentence, code).toBeTruthy();
      // A parameter left unfilled is a sentence with `{tier}` in it, which is
      // the failure this whole arrangement exists to avoid: the server stopped
      // knowing the sentence, so nothing else may quietly stop filling it.
      expect(sentence, code).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it("fills a parameter rather than naming it", () => {
    expect(agentErrorSentence({ error: "unknown_tier", key: "T3" })).toBe(
      '"T3" is not a tier: the tiers that call a model are T1 and T2.',
    );
    expect(
      agentErrorSentence({ error: "instruction_too_long", max: 2000, length: 2100 }),
    ).toBe("A standing instruction is at most 2000 characters; this one is 2100.");
  });

  it("answers null for a code it does not know, rather than inventing one", () => {
    expect(agentErrorSentence({ error: "not_a_code" })).toBeNull();
    expect(agentErrorSentence({})).toBeNull();
  });

  it("reads its own language when the catalogue carries the sentence", () => {
    setCatalog("it", {
      strings: {
        "The agent's session could not be opened: {detail}":
          "La sessione non si è aperta: {detail}",
      },
      plurals: {},
    } as Catalog);
    expect(agentErrorSentence({ error: "agent_unreachable", detail: "refused" })).toBe(
      "La sessione non si è aperta: refused",
    );
  });
});

describe("apiFetch composes an admin refusal from what the route answers", () => {
  /** A server that answers one body, whatever is asked of it. */
  function refusingServer(body: unknown, status = 400): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status, json: async () => body }) as Response),
    );
  }

  it("turns a code and its parameters into the sentence a caller reads", async () => {
    refusingServer({ error: "tier_base_url_private", tier: "T2", host: "10.0.0.5" });
    const err = await apiFetch("/api/admin/agent/providers", { method: "PUT" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      "T2 points at 10.0.0.5, which is inside the network: a worker must not be pointed at an address that is not a model provider.",
    );
  });

  it("reads prose from a body whose code it does not know", async () => {
    refusingServer({ error: "something_else", message: "That is not a folder." });
    const err = await apiFetch("/api/admin/agent/providers", { method: "PUT" }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).message).toBe("That is not a folder.");
  });
});
