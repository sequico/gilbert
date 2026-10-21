import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Email } from "@/jmap/types";
import { SpamModelOpinionRow } from "../SpamModelOpinion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The spam filter's model, on the surface: the row is drawn from the header and
 * nothing is drawn without it. It is the filter's model and not the agent's, the
 * confidence is a word a catalogue can translate, and the explanation is text.
 */

const mail = (header?: string | null): Email =>
  ({
    id: "m1",
    ...(header === undefined ? {} : { "header:X-Spam-LLM:asText": header }),
  }) as unknown as Email;

describe("the spam filter's model on a message", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (email: Email) => {
    await act(async () => {
      root.render(
        <dl>
          <SpamModelOpinionRow email={email} />
        </dl>,
      );
    });
    return host.textContent ?? "";
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("names the category, its confidence and the model's explanation", async () => {
    const text = await render(
      mail("LLM_HAM_HIGH (A reply in a thread the reader started)"),
    );
    expect(text).toContain("Ham");
    expect(text).toContain("High confidence");
    expect(text).toContain("A reply in a thread the reader started");
    expect(text).toContain("One of several signals the spam filter weighed");
  });

  it("says nothing about a model when the server recorded no opinion", async () => {
    expect(await render(mail())).toBe("");
    expect(await render(mail(null))).toBe("");
    expect(await render(mail(""))).toBe("");
  });
});
