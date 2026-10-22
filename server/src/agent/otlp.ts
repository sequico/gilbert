/**
 * The agent's own measures, sent as OTLP when an installation configured it
 * (ADR 0038).
 *
 * A run's record says what happened; a week of them says what the installation
 * costs and where it is refused, and that question is answered by the documents
 * alone (`agentMetrics.ts`, the Administration page) unless an operator has
 * pointed the installation at a collector. The shape sent here is the
 * **OpenTelemetry GenAI** one — the model, its tokens, the milliseconds, the
 * steps, the calls, the refusals and the ending — so a dashboard reads this
 * agent beside every other model caller it watches.
 *
 * One request per pass, carrying that pass's record and every run it ended:
 * OTLP/HTTP accepts a batch, and a request per run would pay a round trip per
 * step. A collector that is down is **not** a run failing — the documents remain
 * the measure — so the caller turns a refusal into a gap it reports, and the
 * run's own document is never in question.
 */
import type { InstallationModel } from "../shared/installation.js";

/** How long one export may take before the collector is treated as absent. */
const OTLP_TIMEOUT_MS = 5_000;

/**
 * One measure, of a run or of a pass.
 *
 * The same fields for both, because the ADR asks for one shape: a pass has no
 * steps of its own and a run has no accounts, and zero is the honest value
 * rather than a second shape. `tokens` is the whole spend; the prompt and
 * completion split travels when the thing measured knows it — a pass's tokens
 * are its runs' and its decision turns' together, so no split is invented.
 */
export interface AgentMeasure {
  kind: "run" | "pass";
  /** When it ended, ISO 8601. */
  at: string;
  /** The model it ran on, when the process knows one. */
  model: InstallationModel | null;
  /** Prompt and completion tokens together. */
  tokens: number;
  promptTokens?: number;
  completionTokens?: number;
  ms: number;
  steps: number;
  calls: number;
  /** Steps that ended refused. */
  refusals: number;
  /** How it ended: a run's ending, or `pass`. */
  ending: string;
  /** What a pass could not cover, when the measure is a pass. */
  gaps?: number;
}

/** One OTLP attribute, in the JSON encoding's own spelling. */
interface OtlpAttribute {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

function text(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function count(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(value) } };
}

/** The attributes one measure carries: the GenAI shape, and the agent's own. */
function attributesOf(measure: AgentMeasure): OtlpAttribute[] {
  const attributes = [
    text("gen_ai.operation.name", measure.kind === "run" ? "agent.run" : "agent.pass"),
    count("gilbert.agent.tokens", measure.tokens),
    count("gilbert.agent.ms", Math.round(measure.ms)),
    count("gilbert.agent.steps", measure.steps),
    count("gilbert.agent.calls", measure.calls),
    count("gilbert.agent.refusals", measure.refusals),
    text("gilbert.agent.ending", measure.ending),
  ];
  if (measure.model)
    attributes.unshift(text("gen_ai.request.model", measure.model.model));
  if (measure.promptTokens !== undefined)
    attributes.push(count("gen_ai.usage.input_tokens", measure.promptTokens));
  if (measure.completionTokens !== undefined)
    attributes.push(count("gen_ai.usage.output_tokens", measure.completionTokens));
  if (measure.gaps !== undefined)
    attributes.push(count("gilbert.agent.gaps", measure.gaps));
  return attributes;
}

/** The nanoseconds OTLP asks for, from an ISO instant. */
function unixNano(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? `${ms}000000` : "0";
}

/** The request body: one resource, one scope, the measures as log records. */
export function otlpBody(measures: readonly AgentMeasure[]): Record<string, unknown> {
  const provider = measures.find((one) => one.model)?.model;
  const resource: OtlpAttribute[] = [text("service.name", "gilbert")];
  if (provider) resource.push(text("gen_ai.system", provider.provider));
  return {
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [
          {
            scope: { name: "gilbert.agent" },
            logRecords: measures.map((measure) => ({
              timeUnixNano: unixNano(measure.at),
              severityText: "INFO",
              body: {
                stringValue: `agent ${measure.kind} ended ${measure.ending}`,
              },
              attributes: attributesOf(measure),
            })),
          },
        ],
      },
    ],
  };
}

/**
 * Send the measures to `<endpoint>/v1/logs`, or say why they did not go.
 *
 * A refusal is thrown with the collector's own words, so the pass that reports
 * it in its gaps says something a person can act on. An endpoint that answered
 * nothing is the same failure, named.
 */
export async function emitMeasures(
  endpoint: string,
  measures: readonly AgentMeasure[],
): Promise<void> {
  if (!measures.length) return;
  const url = `${endpoint.replace(/\/+$/, "")}/v1/logs`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otlpBody(measures)),
    signal: AbortSignal.timeout(OTLP_TIMEOUT_MS),
  });
  if (res.ok) {
    await res.body?.cancel();
    return;
  }
  const body = await res.text().catch(() => "");
  await res.body?.cancel().catch(() => {});
  const line = (body.split("\n")[0] ?? "").slice(0, 200);
  throw new Error(`${url} answered ${res.status}${line ? `: ${line}` : ""}`);
}
