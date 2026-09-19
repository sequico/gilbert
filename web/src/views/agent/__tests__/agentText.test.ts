import type { AgentRule, AgentTrigger } from "@gilbert/agent/documents";
import type { GroupPolicyView } from "@gilbert/agent/views";
import { afterEach, describe, expect, it } from "vitest";
import { type Catalog, setCatalog } from "@/lib/i18n";
import {
  actionText,
  automationText,
  fleetMeterLines,
  fleetReasonText,
  jobStateText,
  outcomeText,
  reviewMeaningText,
  reviewText,
  triggerText,
} from "../agentText";

/**
 * The shared wording is what both agent surfaces show, so what it says about a
 * document — what wakes an automation, how often, and who its runs stop for —
 * is worth pinning.
 */
describe("triggerText", () => {
  it("names the event alone when nothing narrows it", () => {
    expect(triggerText({ on: "chat" })).toBe("Someone writes in the chat");
  });

  it("says nothing about a message: an automation carries no filter", () => {
    // The line is the trigger and nothing else. What the automation acts on
    // among the messages that arrive is its instruction's business (ADR 0006),
    // so there is no filter to render — and a document that still carries one
    // from an older shape says nothing about it rather than half a sentence.
    expect(triggerText({ on: "email" })).toBe("An email arrives");
    expect(triggerText({ on: "filenode" })).toBe("A file or folder changes");
  });

  it("says how often a scheduled automation runs", () => {
    expect(triggerText({ on: "schedule", everyMinutes: 60 })).toBe(
      "On a schedule · every hour",
    );
    expect(triggerText({ on: "schedule", everyMinutes: 10080 })).toBe(
      "On a schedule · every week",
    );
  });

  it("still renders a cadence the presets do not offer, in minutes", () => {
    // A document written by hand, or by a build that had other presets, is said
    // rather than dropped out of the sentence.
    expect(triggerText({ on: "schedule", everyMinutes: 15 })).toBe(
      "On a schedule · every 15 minutes",
    );
  });

  it("describes nothing for a trigger that is not there", () => {
    expect(triggerText(undefined)).toBe("");
  });
});

describe("automationText", () => {
  it("names an automation by the trigger it stands on", () => {
    expect(automationText({ trigger: { on: "email" } })).toBe("Mail automation");
    expect(automationText({ trigger: { on: "schedule", everyMinutes: 60 } })).toBe(
      "Scheduled automation",
    );
  });

  it("names a run whose automation is gone as exactly that", () => {
    // A job outlives the rule it was pinned to, and the trail is read a year
    // later: the honest name is that there is nothing left to name.
    expect(automationText({ trigger: undefined })).toBe(
      "An automation that no longer exists",
    );
  });
});

describe("reviewText", () => {
  it("reads the group's own policy, not a rule's", () => {
    expect(
      reviewText({
        review: "threshold",
        allowExternal: false,
        present: true,
        updatedAt: null,
        updatedBy: null,
      }),
    ).toBe(
      "Ask a person below a confidence threshold · sending outside the group always waits for a person",
    );
  });

  it("says when the external-send floor has been raised", () => {
    expect(
      reviewText({
        review: "never",
        allowExternal: true,
        present: true,
        updatedAt: null,
        updatedBy: null,
      }),
    ).toBe(
      "Never ask — run it unattended · sending outside the group allowed without a person",
    );
  });
});

describe("outcomeText", () => {
  it("names every outcome an audit entry carries", () => {
    expect(outcomeText("missed")).toBe("Missed");
    // A run whose worker stopped holding it, which is an outcome of its own.
    expect(outcomeText("timeout")).toBe("Timed out");
    // A run a chain refused before it started, which is an outcome of its own.
    expect(outcomeText("refused")).toBe("Refused");
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

describe("reviewMeaningText", () => {
  it("says what a mode does, and nothing for a mode it does not know", () => {
    const always = reviewMeaningText("always");
    expect(always.length).toBeGreaterThan(0);
    expect(reviewMeaningText("threshold")).not.toBe(always);
    expect(reviewMeaningText("never")).not.toBe(always);
    expect(reviewMeaningText("something-else")).toBe("");
  });
});

/*
 * The fleet's meter is the installation's total and the split behind it: the
 * lines have to carry both, and say when a group's audit could not be read —
 * the total is a floor then, and a surface that showed it as complete would be
 * telling a quieter story than the one the numbers support (ADR 0003).
 */
describe("fleetMeterLines", () => {
  const meter = (runs: number, tokens: number | null) => ({
    inputHitTokens: tokens,
    inputMissTokens: null,
    outputTokens: null,
    runs,
    uncounted: 0,
  });

  it("leads with the total, then one line per agent", () => {
    const lines = fleetMeterLines({
      total: meter(3, 120),
      byAgent: [
        { agent: "gilbert@example.com", meter: meter(2, 100) },
        { agent: "", meter: meter(1, 20) },
      ],
      unreadable: [],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("3 runs");
    expect(lines[1]).toContain("gilbert@example.com");
    // An entry that names no agent is still counted, and the line says so
    // rather than leaving a blank before the colon.
    expect(lines[2]).toContain("2");
  });

  it("names the groups that left the total a floor", () => {
    const lines = fleetMeterLines({
      total: meter(1, 10),
      byAgent: [],
      unreadable: ["legal@example.org"],
    });
    expect(lines.join(" ")).toContain("legal@example.org");
  });
});

/*
 * The panel reads whatever the group's own account holds: a rule written by a
 * newer version carries values this build has never seen, and one written by
 * hand can be missing the fields it expects. Reading it must not throw, and a
 * value with no label here is shown as it was written.
 */
describe("a partial or unfamiliar document", () => {
  it("renders without a trigger, and shows an unknown value raw", () => {
    const foreign = {
      v: 1,
      id: "r-newer",
      version: 1,
      enabled: true,
    } as unknown as AgentRule;

    expect(triggerText(foreign.trigger)).toBe("");
    // An automation with no trigger left to name it is named for what it is: a
    // run whose document is gone, which the trail is read against a year later.
    expect(automationText(foreign)).toBe("An automation that no longer exists");
    expect(jobStateText("paused")).toBe("paused");
    expect(outcomeText("deferred")).toBe("deferred");
    // An event this build cannot name is shown as the document spells it.
    expect(triggerText({ on: "webhook" } as unknown as AgentTrigger)).toBe("webhook");
    // A policy this build cannot read is shown as the document spells it, and
    // the consent floor is still said beside it: an unknown mode is not a
    // licence to reach outside the group.
    expect(reviewText({ review: "sometimes" } as unknown as GroupPolicyView)).toBe(
      "sometimes · sending outside the group always waits for a person",
    );
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
      fleetReasonText({ code: "agents_unreadable", detail: "held elsewhere" }),
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
