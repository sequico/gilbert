import type { AgentRule, AgentTrigger } from "@gilbert/agent/documents";
import { afterEach, describe, expect, it } from "vitest";
import { type Catalog, setCatalog } from "@/lib/i18n";
import {
  actionText,
  fleetReasonText,
  jobStateText,
  outcomeText,
  reviewText,
  ruleActions,
  triggerText,
} from "../agentText";

/**
 * The shared wording is what both agent surfaces show, so what it says about a
 * document — the filters the executor honours, the confidence threshold, the
 * external-send floor — is worth pinning.
 */
describe("triggerText", () => {
  it("names the event alone when nothing narrows it", () => {
    expect(triggerText({ on: "chat" })).toBe("Someone writes in the chat");
  });

  it("lists the filters the executor honours, in the matcher's own order", () => {
    expect(
      triggerText({
        on: "email",
        filter: { subject: "invoice", inMailbox: "mb-1", notKeyword: "spam" },
      }),
    ).toBe(
      "An email arrives · in mailbox mb-1, without keyword spam, subject contains invoice",
    );
  });

  it("renders every key the matcher implements, not only the five with wording", () => {
    expect(triggerText({ on: "email", filter: { to: "someone" } })).toBe(
      "An email arrives · to contains someone",
    );
    // A size is a number, and the matcher compares it as one.
    expect(triggerText({ on: "email", filter: { minSize: 1000 } })).toBe(
      "An email arrives · larger than 1000 bytes",
    );
  });

  it("ignores a filter key the matcher does not implement", () => {
    expect(triggerText({ on: "email", filter: { webhook: "x" } })).toBe(
      "An email arrives",
    );
  });

  it("says how often a scheduled automation runs", () => {
    expect(triggerText({ on: "schedule", everyMinutes: 15 })).toBe(
      "On a schedule · every 15 minutes",
    );
  });
});

describe("reviewText", () => {
  it("carries the threshold a reader has to know", () => {
    expect(reviewText({ mode: "threshold", threshold: 0.7 })).toBe(
      "Ask a person below a confidence threshold (at 70% confidence or above) · sending outside the group always waits for a person",
    );
  });

  it("says when the external-send floor has been raised", () => {
    expect(reviewText({ mode: "never", allowExternal: true })).toBe(
      "Never ask — run it unattended · sending outside the group allowed without a person",
    );
  });
});

describe("outcomeText", () => {
  it("names every outcome an audit entry carries", () => {
    expect(outcomeText("missed")).toBe("Missed");
    // A run whose worker stopped holding it, which is an outcome of its own.
    expect(outcomeText("timeout")).toBe("Timed out");
  });
});

describe("actionText", () => {
  it("takes the label from the catalogue and adds its parameters", () => {
    expect(actionText({ do: "mail.move", with: { mailbox: "archive" } })).toBe(
      "Move the message (mailbox: archive)",
    );
  });

  it("is just the label when the action takes nothing", () => {
    expect(actionText({ do: "noop" })).toBe("Do nothing");
  });
});

describe("ruleActions", () => {
  const base: Omit<AgentRule, "tier"> = {
    v: 1,
    id: "r1",
    version: 1,
    name: "Invoices",
    enabled: true,
    trigger: { on: "email" },
    review: { mode: "never" },
  };

  it("keeps a T0 rule's own ordered list", () => {
    const actions = [{ do: "keyword.add" as const, with: { keyword: "G-processed" } }];
    expect(ruleActions({ ...base, tier: "T0", actions })).toEqual(actions);
  });

  it("flattens a T1 rule's categories", () => {
    const actions = ruleActions({
      ...base,
      tier: "T1",
      categories: [
        { name: "invoice", actions: [{ do: "keyword.add", with: { keyword: "G-a" } }] },
        { name: "spam", actions: [{ do: "noop" }] },
      ],
    });
    expect(actions.map((a) => a.do)).toEqual(["keyword.add", "noop"]);
  });

  it("shows no fixed actions for a T2 rule, which decides at run time", () => {
    expect(ruleActions({ ...base, tier: "T2", instruction: "Do the thing" })).toEqual([]);
  });
});

/*
 * The panel reads whatever the group's own account holds: a rule written by a
 * newer version carries values this build has never seen, and one written by
 * hand can be missing the fields it expects. Reading it must not throw, and a
 * value with no label here is shown as it was written.
 */
describe("a partial or unfamiliar document", () => {
  it("renders without a trigger or a review, and shows an unknown value raw", () => {
    const foreign = {
      v: 1,
      id: "r-newer",
      version: 1,
      name: "Filed by a newer version",
      enabled: true,
      tier: "T0",
    } as unknown as AgentRule;

    expect(triggerText(foreign.trigger)).toBe("");
    expect(reviewText(foreign.review)).toBe("");
    expect(jobStateText("paused")).toBe("paused");
    expect(outcomeText("deferred")).toBe("deferred");
    // An event this build cannot name is shown as the document spells it.
    expect(triggerText({ on: "webhook" } as unknown as AgentTrigger)).toBe("webhook");
  });
});

/**
 * Why the fleet cannot be read: a code and a detail, never a sentence of the
 * server's. What a person reads is composed here, so it is the language the
 * surface is set to — and a language whose catalogue lacks it reads the English
 * until the translation is written.
 */
describe("fleetReasonText", () => {
  afterEach(() => setCatalog("en", { strings: {}, plurals: {} }));

  it("fills the detail into the sentence the code stands for", () => {
    const unreachable = fleetReasonText({
      code: "agent_unreachable",
      detail: "HTTP 500",
    });
    expect(unreachable).toContain("HTTP 500");
    expect(unreachable).not.toContain("{detail}");
    expect(
      fleetReasonText({ code: "workers_unreadable", detail: "held elsewhere" }),
    ).toContain("held elsewhere");
    expect(fleetReasonText({ code: "agent_not_configured" })).not.toContain("{");
  });

  it("falls back to English where a catalogue does not carry the sentence", () => {
    const english = fleetReasonText({ code: "agent_unreachable", detail: "HTTP 500" });
    setCatalog("de", { strings: { Archive: "Archivieren" }, plurals: {} });
    expect(fleetReasonText({ code: "agent_unreachable", detail: "HTTP 500" })).toBe(
      english,
    );
  });

  it("is the catalogue's sentence once one is written for that key", () => {
    /** A catalogue that answers one translation and records the keys it was asked. */
    const seen: string[] = [];
    const catalog: Catalog = {
      strings: new Proxy({} as Record<string, string>, {
        get: (_target, key) => {
          seen.push(String(key));
          return "TRANSLATED: {detail}";
        },
      }),
      plurals: {},
    };
    setCatalog("xx", catalog);
    expect(fleetReasonText({ code: "agent_unreachable", detail: "HTTP 500" })).toBe(
      "TRANSLATED: HTTP 500",
    );
    expect(seen[0]).toContain("{detail}");
  });
});
