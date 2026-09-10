import type { AgentRule } from "@gilbert/agent/documents";
import { describe, expect, it } from "vitest";
import { actionText, reviewText, ruleActions, triggerText } from "../agentText";

/**
 * The shared wording is what both agent surfaces show, so what it says about a
 * document — the filters the executor honours, the confidence threshold, the
 * external-send floor — is worth pinning.
 */
describe("triggerText", () => {
  it("names the event alone when nothing narrows it", () => {
    expect(triggerText({ on: "chat" })).toBe("Someone writes in the chat");
  });

  it("lists the filters the executor honours, in one predictable order", () => {
    expect(
      triggerText({
        on: "email",
        filter: { subject: "invoice", inMailbox: "mb-1", notKeyword: "spam" },
      }),
    ).toBe(
      "An email arrives · in mailbox mb-1, subject contains invoice, without keyword spam",
    );
  });

  it("ignores a filter field the executor does not read", () => {
    expect(triggerText({ on: "email", filter: { to: "someone" } })).toBe(
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
    area: "mail",
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
