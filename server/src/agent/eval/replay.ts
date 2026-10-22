/**
 * The recorded provider answers (ADR 0038, the regression replay).
 *
 * The eval is a measure, not a gate, and a CI run has no provider key. What is
 * recorded here is the **wire**: every chat-completion request the measure made
 * and the provider's answer, verbatim. `agent/replay.test.ts` reads them back
 * through today's parsers — the job catalogue, `parseStepAnswerDetailed`, the
 * decision shape — so a change that stops reading an answer the model really
 * gave fails there, with no key and no network. The file carries the prompts
 * and the answers, never a header: the key is not in it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** One recorded exchange: what was asked, what was offered, and the answer. */
export interface RecordedCall {
  url: string;
  /** Whether the request was the capability probe, which is not a turn of the agent. */
  probe: boolean;
  /** Whether the system turn asked for a judgement, which is a turn of its own. */
  judge: boolean;
  /** The job names the call offered as `tools`, empty for a decision. */
  tools: string[];
  status: number;
  response: string;
}

/** Wrap `fetch` so every chat-completion exchange is appended to the file. */
export function installRecording(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await real(input, init);
    const text = await res.text();
    const body = init?.body;
    if (
      typeof body === "string" &&
      (url.endsWith("/chat/completions") || url.endsWith("/models"))
    ) {
      /*
       * The request is kept as what the replay needs — whether it asked for a
       * judgement and the catalogue it offered — not as the whole prompt: the
       * run's data is not the regression's business, and the file stays small.
       */
      let probe = false;
      let judge = false;
      let tools: string[] = [];
      try {
        const asked = JSON.parse(body) as {
          messages?: Array<{ content?: unknown }>;
          tools?: Array<{ function?: { name?: unknown } }>;
        };
        const system =
          typeof asked.messages?.[0]?.content === "string"
            ? asked.messages[0].content
            : "";
        probe = system.startsWith('Answer in JSON: {"ok": true}');
        judge = system.includes("judge whether a run's report stands");
        tools = (asked.tools ?? []).flatMap((one) =>
          typeof one.function?.name === "string" ? [one.function.name] : [],
        );
      } catch {
        /* a body that is not JSON is still recorded, with nothing to classify */
      }
      appendFileSync(
        file,
        `${JSON.stringify({ url, probe, judge, tools, status: res.status, response: text } satisfies RecordedCall)}\n`,
      );
    }
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/** Every recorded exchange of one file. */
export function recordedCalls(file: string): RecordedCall[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordedCall);
}
