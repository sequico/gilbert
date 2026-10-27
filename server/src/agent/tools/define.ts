/**
 * What a tool is, once (ADR 0038, ADR 0028).
 *
 * The catalogue's own machinery: the authority class a tool exercises, the
 * refusal a tool answers with, the shape every tool is defined through, the call
 * a tool is handed, and the guard that asks whether the run may take its act.
 * The surface modules beside this one define their tools through these, and
 * `agent/tools.ts` re-exports them, so each has one spelling.
 */

import type { Ctx } from "../../appFolder.js";
import type { AreaName } from "../../shared/areas.js";
import { isRecord } from "../../shared/json.js";
import type {
  RunAuthority,
  RunAuthorityAct,
  RunDoc,
  RunSpent,
  RunWait,
} from "../../shared/run.js";
import type { SurfaceMode, SurfaceName } from "../../shared/surfaces.js";
import type { MemoryStore } from "../memory.js";
import type { UsageMeter } from "../model.js";
import type { ImageReader } from "./content.js";

export type { ImageReader };

/**
 * The authority class a tool exercises (ADR 0028).
 *
 * The five classes, named by what each one needs before the agent may act:
 * `reversible` is the agent's own decision; `destructive` (a message, a folder
 * or a page destroyed, a document overwritten), `outward` (anything that
 * reaches a person outside the mandate) and `beyond-policy` (an act the written
 * policy forbids) each need an authority the run carries — a person's word, an
 * instruction that declares it sends, or an installation administrator's override —
 * and `intent` is never the agent's, whatever the run carries.
 */
type ToolAuthority =
  | "reversible"
  | "destructive"
  | "outward"
  | "beyond-policy"
  | "intent";

/**
 * A tool call this build cannot use.
 *
 * The code is what a surface composes its own sentence from, as `RunError` is
 * for runs; a tool refused for its arguments says so in the model's own words.
 */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * One tool, with its arguments erased so a catalogue can hold them side by side.
 *
 * `parse` is the only reader of the raw arguments the model gave, and `run` is
 * only ever handed what `parse` returned — which is what makes "validated
 * before the executor runs" a property of the shape rather than a rule the
 * executors keep. `defineTool` builds one from a tool that names its own
 * argument type.
 */
export interface AnyTool {
  readonly name: string;
  readonly description: string;
  readonly authority: ToolAuthority;
  /**
   * The class this **call** exercises, read from its parsed arguments.
   *
   * One job reaches reversible and destructive acts alike (ADR 0038): `place`
   * files a message and destroys a folder, `event` creates and cancels. The
   * guard asks this, never the tool's static `authority`, which a job keeps as
   * its default.
   */
  readonly authorityOf: (args: unknown) => ToolAuthority;
  /** Whether the tool can change anything. The reading half's are all false. */
  readonly writes: boolean;
  /**
   * The surface of the group's account a write touches (ADR 0038), or absent
   * for the agent's own bookkeeping (its memory).
   */
  readonly surface?: SurfaceName;
  /** The surface this call touches, read from its parsed arguments. */
  readonly surfaceOf: (args: unknown) => SurfaceName | undefined;
  /** Whether one call leaves the run waiting on a person (ADR 0029, 0030). */
  readonly waits: boolean;
  /** Whether this call waits, read from its parsed arguments. */
  readonly waitsOf: (args: unknown) => boolean;
  /** What a call to it spends of the run's tally (ADR 0038). */
  readonly spend: Partial<RunSpent>;
  /**
   * The act this call is, read from the arguments the model gave (ADR 0028).
   *
   * A class is not an act: an authority a person gave names one act and no
   * other, so a tool whose class needs one answers here what its act reaches and
   * what it carries, and the guard compares that against the run's
   * authorisations. A class that asks nobody answers null, which is every
   * reading tool and every reversible one.
   */
  readonly act: (args: unknown) => RunAuthorityAct | null;
  /**
   * The argument names the tool takes, and the only ones it takes — its
   * `args`' own keys, derived where the tool is defined.
   *
   * A call naming anything else is refused rather than read as if the field it
   * meant were missing: a `files.list` asked for `folder` while it reads `path`
   * answered with the top level of Files — a wrong answer, silently, which is
   * worse than a refusal.
   */
  readonly keys: readonly string[];
  /** What each argument is, for the turn that has to fill it in. */
  readonly args: Readonly<Record<string, ArgSpec>>;
  /**
   * The whole `parameters` object of a provider's tool definition, when one
   * object cannot express the call's shapes (ADR 0038): a job whose arguments
   * depend on its `kind`/`action` publishes one branch per value, so a provider
   * can refuse `path` on a mail search before the endpoint does.
   */
  readonly parameters?: () => Record<string, unknown>;
  /** Validate the arguments; throw `ToolError` on anything the tool cannot use. */
  readonly parse: (raw: unknown) => unknown;
  /** The task itself, with arguments already validated. */
  readonly run: (call: ToolCall, args: unknown) => Promise<unknown>;
  /**
   * The same tool with only the acts a run's areas allow (ADR 0038), or null
   * when none is: a job whose values all belong to areas the instruction did
   * not declare is not offered at all.
   */
  readonly narrow?: (areas: readonly AreaName[] | null) => AnyTool | null;
}

/**
 * One argument as the model is handed it: the kind of value, and the bound it
 * is held to.
 *
 * The parser is what refuses a bad value; this is what the turn is told before
 * it answers, because an error named after the fact ("`fact` must be at most
 * 400 characters") costs a whole step and a call. One definition, two readers,
 * exactly as a tool's name and description are: a bound taken from the same
 * constant the parser checks is a bound that cannot drift.
 */
export interface ArgSpec {
  /** The kind of value: text, a whole number, a boolean, a list, or one of a set. */
  type: "text" | "number" | "boolean" | "list" | "one of";
  /**
   * What the value *is*, when the name alone would not say it.
   *
   * `id` is an argument of message reads, mailbox reads, file reads and chat
   * reads alike, and a live run sent a mailbox id to `mail.read` because the
   * schema said "text" and nothing more. This line is rendered beside the
   * argument in both turns' catalogue and in the provider's `description`, so
   * the same word cannot mean four things to the one filling it in.
   */
  about?: string;
  /** The least a `number` may be. */
  min?: number;
  /** The most characters a `text` may be (and each entry of a `list`). */
  max?: number;
  /** The values a `one of` accepts. */
  values?: readonly string[];
}

/** One argument as a JSON Schema, from the tool's own `args` spec. */
export function argSchema(spec: ArgSpec): Record<string, unknown> {
  /*
   * The bound in words, beside the machine-readable one: a provider may ignore
   * `maxLength` — one did, and the run paid a refusal for a `fact` five times
   * over its limit — and a description is what a model actually reads.
   */
  const described = spec.about ? { description: spec.about } : {};
  switch (spec.type) {
    case "number":
      return {
        type: "integer",
        ...described,
        ...(spec.min === undefined ? {} : { minimum: spec.min }),
        ...(spec.max === undefined ? {} : { maximum: spec.max }),
      };
    case "boolean":
      return { type: "boolean", ...described };
    case "list":
      return {
        type: "array",
        items: {
          type: "string",
          ...(spec.max === undefined ? {} : { maxLength: spec.max }),
        },
        ...described,
      };
    case "one of":
      return {
        type: "string",
        ...described,
        ...(spec.values?.length ? { enum: [...spec.values] } : {}),
      };
    case "text":
      return {
        type: "string",
        ...described,
        ...(spec.max === undefined ? {} : { maxLength: spec.max }),
      };
  }
}

/** One tool's own shape, typed by the arguments it takes. */
interface ToolSpec<Args> {
  name: string;
  description: string;
  authority: ToolAuthority;
  /** The class a call exercises, when it varies by its arguments. */
  authorityOf?: (args: Args) => ToolAuthority;
  writes: boolean;
  /** The surface of the group's account a write touches (ADR 0038). */
  surface?: SurfaceName;
  /** The surface a call touches, when it varies by its arguments. */
  surfaceOf?: (args: Args) => SurfaceName | undefined;
  /**
   * Whether one call leaves the run waiting on a person. A run holds one wait
   * (ADR 0030), so a plan may carry one such call and no more.
   */
  waits?: boolean;
  /** Whether a call waits, when it varies by its arguments. */
  waitsOf?: (args: Args) => boolean;
  spend?: Partial<RunSpent>;
  act?: (args: Args) => RunAuthorityAct | null;
  /**
   * The arguments this tool takes, and what each one is.
   *
   * **The one list**: the names it takes (anything else is refused), the kind
   * and the bound the turn is told, and the names the prompt shows are all read
   * from here. A second list of the same names was a list that could disagree
   * with this one — a key taken and never described, or described and never
   * taken — and the catalogue had to refuse itself at run time to catch it. There
   * is nothing to disagree now.
   */
  args: Readonly<Record<string, ArgSpec>>;
  /** The whole argument schema, when it is a union of per-value shapes. */
  parameters?: () => Record<string, unknown>;
  parse: (raw: unknown) => Args;
  run: (call: ToolCall, args: Args) => Promise<unknown>;
}

/** The one place a tool is defined, so every field above has one spelling. */
export function defineTool<Args>(spec: ToolSpec<Args>): AnyTool {
  const keys = Object.keys(spec.args);
  const known = new Set(keys);
  return {
    name: spec.name,
    description: spec.description,
    authority: spec.authority,
    authorityOf: spec.authorityOf
      ? (args) => spec.authorityOf!(args as Args)
      : () => spec.authority,
    writes: spec.writes,
    surface: spec.surface,
    surfaceOf: spec.surfaceOf
      ? (args) => spec.surfaceOf!(args as Args)
      : () => spec.surface,
    waits: spec.waits === true,
    waitsOf: spec.waitsOf
      ? (args) => spec.waitsOf!(args as Args)
      : () => spec.waits === true,
    spend: spec.spend ?? {},
    act: spec.act ? (args) => spec.act!(args as Args) : () => null,
    keys,
    args: spec.args,
    ...(spec.parameters ? { parameters: spec.parameters } : {}),
    parse: (raw) => {
      /*
       * A key this tool does not take is refused whole, before the run: the
       * model is told which names it may use, so the next answer is not another
       * guess at the same field under a different spelling.
       */
      if (raw !== undefined && raw !== null && !isRecord(raw))
        throw new ToolError("bad_arguments", "The arguments must be an object.");
      const held = isRecord(raw) ? Object.keys(raw) : [];
      const unknown = held.filter((one) => !known.has(one));
      if (unknown.length)
        throw new ToolError(
          "bad_arguments",
          `"${spec.name}" takes ${keys.length ? keys.map((one) => `"${one}"`).join(", ") : "no arguments"}, not ${unknown.map((one) => `"${one}"`).join(", ")}.`,
        );
      return spec.parse(raw);
    },
    run: (call, args) => spec.run(call, args as Args),
  };
}

/** What a tool call is given: the session it acts as, and the run it works. */
export interface ToolCall {
  ctx: Ctx;
  /** The account the run belongs to — the group's own (ADR 0038). */
  accountId: string;
  /** The run the call is a step of, which is what its authority is read from. */
  run: RunDoc;
  /**
   * The installation's model's eyes, for the one read a function cannot make
   * (ADR 0038): an image is transcribed by the model, and a caller without this
   * gets the answer that says so rather than a guess at the picture.
   *
   * A function rather than the model's own access, because a catalogue that
   * imported the model would close a cycle — the model imports the catalogue to
   * offer its tools. The loop, which holds both, is where the two meet.
   */
  readImage?: ImageReader;
  /**
   * The installation's model's vectors, where it offers them (ADR 0038): a fact
   * is written with the vector its sentence was embedded into, so the memory's
   * index is rebuilt at boot from the documents and needs no model call. A
   * caller without this writes no vector, and the retrieval is exact.
   *
   * A function for the same reason `readImage` is one: a catalogue that imported
   * the model would close a cycle.
   */
  embed?: (text: string) => Promise<number[] | null>;
  /**
   * The meter of a model call **this tool makes itself** — a reader's answer, a
   * picture transcribed, a sentence embedded — so what the tool spends is on the
   * run and on the day's counter like every other call (ADR 0038). A tool that
   * makes none leaves it unused, and the call a tool did not make adds nothing.
   */
  meter?: UsageMeter;
  /**
   * The questions the group already has open, as the waits the pass just read
   * (ADR 0029): `chat.ask` finds a question it must not ask twice here, instead
   * of walking the account's runs for every question.
   */
  openWaits?: readonly RunWait[];
  /**
   * The installation's memory as the caller's pass read it (ADR 0033).
   *
   * The store is read **once per pass** (`agent/loop.ts`) and the one reading is
   * handed to every step of it, so the write `memory.remember` makes is against
   * the same reading the pass's selections were made from rather than listing
   * the memory again for every fact. A caller with no reading of its own — the
   * decision turn's write-free lookups — passes none, and a tool that needs one
   * says so.
   */
  memory?: MemoryStore;
}

/** The authority of the run that makes a tool's class the agent's to take. */
const AUTHORITY_NEEDED: Record<ToolAuthority, RunAuthority | "alone" | "never"> = {
  reversible: "alone",
  destructive: "destructive",
  outward: "outward",
  "beyond-policy": "override",
  intent: "never",
};

/** What a tool's class needs before a run may take it (ADR 0028). */
function authorityNeeded(authority: ToolAuthority): RunAuthority | "alone" | "never" {
  return AUTHORITY_NEEDED[authority];
}

/**
 * Whether a run may take a tool's action, read from the class the tool declares
 * and the act it is about.
 *
 * The guard is here and nowhere else: `reversible` is the agent's own decision
 * and asks nobody; the three that need one are answered by the run's recorded
 * authorisations, each naming the authority a person gave **and the act it is
 * for** — an authorisation answers for that act and no other (ADR 0028), so a
 * send a person authorised does not authorise the next one; and `intent` is
 * never answered at all, because which policy is right is not a thing a run can
 * be authorised to decide.
 */
export function mayRun(tool: AnyTool, run: RunDoc, args: unknown): boolean {
  const needed = authorityNeeded(tool.authorityOf(args));
  if (needed === "alone") return true;
  if (needed === "never") return false;
  const act = tool.act(args);
  if (!act) return false;
  return run.authorisations.some(
    (one) =>
      one.authority === needed &&
      one.act.target === act.target &&
      one.act.content === act.content,
  );
}

/**
 * The mode the run's matrix gives one surface, or null when the run predates the
 * matrix (ADR 0038).
 *
 * A run opened before a matrix carried surfaces may write where it did before: the
 * guard does not narrow it retroactively, and the run's own view says it stands
 * before the matrix.
 */
export function surfaceModeOf(run: RunDoc, surface: SurfaceName): SurfaceMode | null {
  return run.startedBy.surfaces?.[surface] ?? null;
}
