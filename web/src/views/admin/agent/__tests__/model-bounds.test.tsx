import { MODEL_MAX_OUTPUT_CEILING } from "@gilbert/agent/documents";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgents } from "@/store/agents";
import { AgentProviders } from "../AgentProviders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the installation's model panel states about the ceiling on one answer
 * (ADR 0003).
 *
 * The sentence a reader sees and the number the field refuses are one fact, so
 * both are read here from the constant the field is bounded by
 * (`MODEL_MAX_OUTPUT_CEILING`). A sentence stating a bound of its own is a
 * number nobody enforces, and this fails on one.
 */

describe("the ceiling the model panel states", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useAgents.getState().reset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    host.remove();
  });

  it("is the one the answer's field enforces, in the sentence and in the input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            address: "gilbert@example.com",
            provider: {
              provider: "stub",
              model: "stub",
              baseUrl: "https://example.invalid/v1",
              hasKey: true,
            },
            maxOutputTokens: 4096,
            maxChainHops: 4,
            maxPages: 10,
          }),
        } as Response;
      }),
    );

    await act(async () => {
      root.render(<AgentProviders />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent ?? "").toContain(
      `What a single model answer may cost. 1 to ${MODEL_MAX_OUTPUT_CEILING}.`,
    );
    const field = host.querySelector<HTMLInputElement>("#agent-max-output-tokens");
    expect(field, "the answer's ceiling is a field").toBeTruthy();
    expect(field?.max).toBe(String(MODEL_MAX_OUTPUT_CEILING));
  });
});
