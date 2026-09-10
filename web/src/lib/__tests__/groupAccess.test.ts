import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/jmap/client";
import { groupAccessSentence } from "@/lib/groupAccess";
import { type Catalog, setCatalog } from "@/lib/i18n";

/**
 * The group-membership refusal, client side.
 *
 * The server refuses a group's documents with a code and the section it was
 * asked for (`group_not_accessible` + `need`), never with a sentence, because a
 * sentence composed there is English no catalogue can translate. So the client
 * composes it — and these are the two claims that make that worth doing: every
 * refusal a person can reach arrives as that sentence, and a language whose
 * catalogue carries it shows its own.
 */

afterEach(() => {
  setCatalog("en", { strings: {}, plurals: {} });
  vi.unstubAllGlobals();
});

/** A server that answers one body, whatever is asked of it. */
function refusingServer(body: unknown, status = 403): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status, json: async () => body }) as Response),
  );
}

/** One refusal, as `apiFetch` turns it into the error a caller catches. */
async function refusal(path: string): Promise<ApiError> {
  const err = await apiFetch(path).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

/**
 * A catalogue that records the keys it is asked for.
 *
 * The English sentence has one home — the `t("…")` call that carries it — and
 * this keeps the test from holding a second copy of it: the key the code looks
 * up is what the test then reads back.
 */
function recordingCatalog(translation: string, seen: string[]): Catalog {
  return {
    strings: new Proxy({} as Record<string, string>, {
      get: (_target, key) => {
        seen.push(String(key));
        return translation;
      },
    }),
    plurals: {},
  };
}

describe("a refusal the client reads", () => {
  it("becomes the sentence for the section the server named", async () => {
    // The body carries no sentence: what arrives is a code and a parameter,
    // and anything that renders "Forbidden" here is the refusal being lost.
    refusingServer({ error: "group_not_accessible", need: "standing instruction" });
    const err = await refusal("/api/admin/groups/legal@example.org/agent/instruction");
    expect(err.message).toBe(groupAccessSentence("standing instruction"));
    expect(err.message).toContain("standing instruction");
    expect(err.code).toBe("group_not_accessible");
    expect(err.status).toBe(403);
  });

  it("names the section it was asked about, and only that one", () => {
    const labels = groupAccessSentence("labels");
    expect(labels).toContain("labels");
    expect(labels).not.toContain("{need}");
    expect(labels).not.toBe(groupAccessSentence("agent documents"));
  });

  it("falls back to English where a catalogue does not carry the sentence", () => {
    // The declared fallback: English is the key, so a language with no entry
    // for it reads the English rather than a hole or a symbolic name.
    const english = groupAccessSentence("labels");
    setCatalog("de", { strings: { Archive: "Archivieren" }, plurals: {} });
    expect(groupAccessSentence("labels")).toBe(english);
  });

  it("is the catalogue's sentence, once one is written for that key", () => {
    const english = groupAccessSentence("approvals");
    const seen: string[] = [];
    setCatalog("xx", recordingCatalog("TRANSLATED: {need}", seen));
    expect(groupAccessSentence("approvals")).toBe("TRANSLATED: approvals");
    expect(seen).toEqual([
      // The key is the English source with its hole still in it, which is what
      // the test just read filled in.
      english.replace("approvals", "{need}"),
    ]);
  });

  it("leaves every other refusal as it was", async () => {
    refusingServer({ error: "bad_request", message: "rules must be an array" });
    const err = await refusal("/api/admin/groups/team@example.org/agent/rules");
    expect(err.message).toBe("rules must be an array");
    expect(err.code).toBe("bad_request");
  });
});
