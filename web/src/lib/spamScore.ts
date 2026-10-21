/**
 * What the spam filter in front of the mailbox already said, read back off the
 * message.
 *
 * Nothing here scores anything. The server has already done that at delivery
 * and written its working into headers; this only reads them, which is why it
 * costs nothing and cannot disagree with the filter that actually made the
 * decision.
 *
 * Two formats cover what sits in front of a Stalwart mailbox in practice: the
 * SpamAssassin-shaped `X-Spam-*` set, which Stalwart's own filter writes, and
 * Rspamd's `X-Spamd-Result`. Anything else is left unread rather than guessed
 * at -- a misparsed score shown confidently is worse than no panel. Beside
 * them, `X-Spam-LLM` carries what the filter's own model answered when the
 * installation has AI classification on, read at the end of this file.
 *
 * The one editorial decision: **a score is not shown without its threshold
 * where the header states one.** 6.7 is damning against a threshold of 5 and
 * unremarkable against 15, so the number alone is not something a reader can
 * act on. Where no threshold is stated, that is said rather than assumed.
 */

interface SpamRule {
  /** The rule's own name, as the filter wrote it. */
  name: string;
  /** What it contributed. Negative moves the message towards clean. */
  score: number;
  /** Rspamd's bracketed note, where there is one. */
  detail?: string;
}

export interface SpamReport {
  /**
   * What the filter concluded, and only where it said so outright. Left `null`
   * rather than derived from score against threshold: the filter applies
   * policy we cannot see, and inventing a verdict it did not state would be
   * putting words in its mouth.
   */
  verdict: "spam" | "clean" | null;
  score: number | null;
  threshold: number | null;
  /** Biggest movers first; ties keep the order the filter listed them in. */
  rules: SpamRule[];
  source: "spamassassin" | "rspamd";
}

/** Headers requested for a full message; kept beside the parser that reads them. */
export const SPAM_HEADER_PROPS = [
  "header:X-Spam-Status:asText",
  "header:X-Spam-Score:asText",
  "header:X-Spamd-Result:asText",
  // Stalwart's AI classification, when the installation has it on: the model the
  // spam filter itself asks, never the agent's.
  "header:X-Spam-LLM:asText",
] as const;

/** Headers arrive folded, so tabs and newlines are whitespace like any other. */
function flatten(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Biggest absolute contribution first: what moved the message, in order. */
function byWeight(rules: SpamRule[]): SpamRule[] {
  return [...rules].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

/**
 * `Yes, score=6.7 required=5.0 tests=[BAYES_99=3.5, HTML_MESSAGE=0.001]`
 * The verdict word is the only part guaranteed to be there.
 */
function parseSpamAssassin(raw: string): SpamReport | null {
  const s = flatten(raw);
  if (!s) return null;
  const verdictWord = /^(yes|no)\b/i.exec(s);
  const score = num(/\bscore=(-?[\d.]+)/i.exec(s)?.[1]);
  const threshold = num(/\b(?:required|require)=(-?[\d.]+)/i.exec(s)?.[1]);
  // Nothing usable: not a header we understand, so say so by returning null
  // rather than rendering an empty panel.
  if (!verdictWord && score === null) return null;
  const rules: SpamRule[] = [];
  const tests = /\btests=\[([^\]]*)\]/i.exec(s)?.[1];
  if (tests) {
    for (const part of tests.split(",")) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(-?[\d.]+)\s*$/.exec(part);
      const value = num(m?.[2]);
      if (m?.[1] && value !== null) rules.push({ name: m[1], score: value });
    }
  }
  return {
    verdict: verdictWord
      ? verdictWord[1]!.toLowerCase() === "yes"
        ? "spam"
        : "clean"
      : null,
    score,
    threshold,
    rules: byWeight(rules),
    source: "spamassassin",
  };
}

/**
 * `default: False [1.20 / 15.00]; MIME_GOOD(-0.10)[text/plain]; DKIM_ALLOW(-0.20)[]`
 * The action word before the brackets is the verdict; `False` is not spam.
 */
function parseRspamd(raw: string): SpamReport | null {
  const s = flatten(raw);
  if (!s) return null;
  const head = /^[^:]*:\s*(\S+)\s*\[\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*\]/.exec(s);
  if (!head) return null;
  const action = head[1]!.toLowerCase();
  const rules: SpamRule[] = [];
  // Each rule after the head, `NAME(score)` with an optional bracketed note.
  for (const m of s.matchAll(/([A-Z][A-Z0-9_]*)\(\s*(-?[\d.]+)\s*\)(?:\[([^\]]*)\])?/g)) {
    const value = num(m[2]);
    if (value === null) continue;
    const detail = m[3]?.trim();
    rules.push(
      detail ? { name: m[1]!, score: value, detail } : { name: m[1]!, score: value },
    );
  }
  return {
    // "False" is Rspamd saying the message is not spam; "True", and the named
    // actions that reject or bin it, are it saying the opposite. Anything else
    // -- greylisting, for one -- is not a verdict about the message.
    verdict:
      action === "false"
        ? "clean"
        : action === "true" ||
            action === "reject" ||
            action === "add_header" ||
            action === "rewrite_subject"
          ? "spam"
          : null,
    score: num(head[2]),
    threshold: num(head[3]),
    rules: byWeight(rules),
    source: "rspamd",
  };
}

type HeaderBag = Partial<Record<(typeof SPAM_HEADER_PROPS)[number], string | null>>;

/**
 * Read whichever of the two the message carries, preferring the SpamAssassin
 * set because it is what Stalwart's own filter writes; a message that has been
 * through both keeps the nearer verdict.
 */
export function spamReport(e: HeaderBag): SpamReport | null {
  const sa = parseSpamAssassin(e["header:X-Spam-Status:asText"] ?? "");
  if (sa) return sa;
  const rspamd = parseRspamd(e["header:X-Spamd-Result:asText"] ?? "");
  if (rspamd) return rspamd;
  // Last resort: a bare score with nothing to read it against. Worth showing,
  // because the alternative is hiding the only thing the filter said.
  const bare = num(
    flatten(e["header:X-Spam-Score:asText"]).replace(/^\+/, "") || undefined,
  );
  if (bare === null) return null;
  return {
    verdict: null,
    score: bare,
    threshold: null,
    rules: [],
    source: "spamassassin",
  };
}

/* ---------- The model the spam filter itself asks ---------- */

/**
 * Stalwart's AI classification, when the installation has it on, records the
 * model's answer in `X-Spam-LLM`: the category it chose and, in parentheses,
 * its explanation.
 *
 *     X-Spam-LLM: Unsolicited (Promotes a product the reader never asked about)
 *
 * The confidence goes into the filter's own tags (`LLM_<category>_<confidence>`)
 * rather than this header, so a header carrying a tag in that form is read the
 * same way. The explanation may arrive as encoded words, which the JMAP
 * `asText` form decodes.
 *
 * **It is the spam filter's model, not the agent's**: it is one signal the
 * filter weighed among the others in the report above, the surface says so, and
 * nothing here judges anything. The explanation is model output and is only
 * ever rendered as text.
 */
export interface SpamModelOpinion {
  /** The category as the server wrote it. */
  tag: string;
  /** That category as a reader would say it. */
  category: string;
  /** A confidence word from the header, where it carried one. */
  confidence: string | null;
  /** The model's own explanation, as plain text. */
  explanation: string | null;
}

/** Confidence words of Stalwart's default prompt; anything else is all category. */
const CONFIDENCES = new Set(["LOW", "MEDIUM", "HIGH"]);

/** `UNSOLICITED_BULK` -> `Unsolicited bulk`. */
function readable(words: string[]): string {
  const s = words.join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function parseSpamModelOpinion(
  raw: string | null | undefined,
): SpamModelOpinion | null {
  const s = flatten(raw);
  // The category is one word -- letters, digits, `_` or `-` -- then optionally
  // the explanation. Combining marks are not in the class: a category is an
  // identifier the administrator configured, which a deployment that needs a
  // script with them would have to answer for first (the skill records the
  // live question as owed).
  const m = /^([\p{L}\p{N}_-]+)(?:\s+(.*))?$/u.exec(s);
  if (!m) return null;
  const tag = m[1]!;

  let category: string;
  let confidence: string | null = null;
  if (tag.startsWith("LLM_")) {
    const parts = tag.slice("LLM_".length).split("_").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length > 1 && CONFIDENCES.has(parts[parts.length - 1]!.toUpperCase())) {
      confidence = readable([parts.pop()!]);
    }
    category = readable(parts);
  } else {
    // As the administrator wrote it, unless it is all capitals or underscores.
    category =
      /[a-z]/.test(tag) && !tag.includes("_")
        ? tag
        : readable(tag.split("_").filter(Boolean));
    if (!category) return null;
  }

  let explanation: string | null = null;
  const rest = (m[2] ?? "").trim();
  if (rest) {
    // The server wraps the explanation in one pair of parentheses.
    if (!(rest.startsWith("(") && rest.endsWith(")"))) return null;
    explanation = rest.slice(1, -1).trim() || null;
  }

  return { tag, category, confidence, explanation };
}

/** The spam filter's model opinion on a message, if the server recorded one. */
export function spamModelOpinion(e: HeaderBag): SpamModelOpinion | null {
  return parseSpamModelOpinion(e["header:X-Spam-LLM:asText"]);
}
