/**
 * A pasted list, read into rows (ADR 0040).
 *
 * The import is the surface the feature lives or dies by, so it is a pure
 * decision over the text: what each line gave, what it lost, and how many of each
 * the caller is about to be told. Nothing is written here — the caller writes what
 * this plans, which is what makes the counts testable against a hundred real
 * lines instead of against a database.
 *
 * Four things a line can be, and a person is told each of them: a row, a
 * duplicate of another line in the same paste or of a row the campaign already
 * holds, a number the group promised never to call, or a line this build cannot
 * read. An import never doubles a list: a file read a second time adds nothing
 * and says how much it skipped.
 *
 * A file named by columns is read by them (`company,person,role,phone`, in any
 * order, with a header); anything else is read as a bare list, which is what a
 * pasted column of numbers is.
 */

import type { RowDoc } from "../shared/outbound.js";
import { lineEntry, type NumberRefusal, normaliseNumber } from "./phone.js";

/** Why a line became no row. `no_number` is the line that carried none at all. */
export type ImportRefusalReason = NumberRefusal | "no_number";

export interface ImportRefusal {
  line: string;
  reason: ImportRefusalReason;
}

export interface ImportPlan {
  /** The rows to write, in the order the list gave them. */
  rows: RowDoc[];
  /** The lines that became no row, with the reason a person reads. */
  refused: ImportRefusal[];
  /** Lines whose number an earlier line of the paste, or the campaign, already held. */
  duplicate: number;
  /** Lines whose number the group's do-not-call list already holds. */
  blocked: number;
  /** Rows whose number a card of the group already carries. */
  matched: number;
}

export interface ImportInput {
  campaignUid: string;
  /** The pasted text, one entry per line. */
  text: string;
  /** The group's do-not-call numbers, canonical. */
  doNotCall: readonly string[];
  /** The group's cards by the number each carries: canonical number → card uid. */
  cards: Readonly<Record<string, string>>;
  /** The numbers this campaign already holds: a repeated paste adds nothing. */
  existing?: readonly string[];
  now: Date;
  /** Where a new row's uid comes from; injected so a test names its own. */
  newUid: () => string;
}

/** One field of a CSV line, with quoted fields and doubled quotes read as one. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * The header words each column answers to.
 *
 * A header is a header because it names the number's column: a file whose first
 * line says `phone` is read by its columns, and one that does not is a bare list
 * of entries, which is what a pasted column of numbers is.
 */
const CSV_COLUMNS = {
  company: ["company", "organisation", "organization", "account", "customer"],
  person: ["person", "name", "contact", "full name", "first name"],
  role: ["role", "title", "job title", "position"],
  phone: ["phone", "number", "telephone", "tel", "mobile", "e164"],
} as const;

type CsvColumn = keyof typeof CSV_COLUMNS;

interface CsvHeader {
  /** The field each column sits in, when the file has it at all. */
  at: Partial<Record<CsvColumn, number>>;
}

/** The columns a file's first line names, or null when it names none. */
function csvHeader(first: string): CsvHeader | null {
  const fields = csvFields(first).map((field) => field.trim().toLowerCase());
  const at: Partial<Record<CsvColumn, number>> = {};
  for (const column of Object.keys(CSV_COLUMNS) as CsvColumn[]) {
    const found = fields.findIndex((field) => CSV_COLUMNS[column].includes(field));
    if (found >= 0) at[column] = found;
  }
  return at.phone === undefined ? null : { at };
}

/** What one line of a file gives: the entry to normalise, and the words around it. */
function csvLine(line: string, header: CsvHeader): {
  entry: string;
  context: string | null;
} {
  const fields = csvFields(line);
  const pick = (column: CsvColumn): string => {
    const at = header.at[column];
    return at === undefined ? "" : (fields[at] ?? "").trim();
  };
  const company = pick("company");
  const person = pick("person");
  const role = pick("role");
  const context = [
    company,
    person ? `ask for ${person}` : "",
    role ? `(${role})` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return { entry: pick("phone"), context: context === "" ? null : context };
}

/** Read a pasted list into the rows a campaign is about to hold. */
export function planImport({
  campaignUid,
  text,
  doNotCall,
  cards,
  existing = [],
  now,
  newUid,
}: ImportInput): ImportPlan {
  const rows: RowDoc[] = [];
  const refused: ImportRefusal[] = [];
  const seen = new Set<string>(existing);
  const blocked = new Set(doNotCall);
  /*
   * The promise not to call is about the person, not the string that was pasted:
   * a card carrying a number on the list carries every number of that person, and
   * calling another one is calling them again. The index is number → card, so the
   * cards to refuse are the ones a listed number belongs to.
   */
  const blockedCards = new Set(
    doNotCall
      .map((number) => cards[number])
      .filter((uid): uid is string => uid !== undefined),
  );
  let duplicate = 0;
  let blockedCount = 0;
  let matched = 0;

  const lines = text.split(/\r?\n/).filter((raw) => raw.trim() !== "");
  const first = lines[0];
  const header = first === undefined ? null : csvHeader(first);
  for (const raw of header ? lines.slice(1) : lines) {
    const line = raw.trim();
    if (!line) continue;

    // A file read by its columns names the number in one of them; a bare list is
    // read for the number inside its line.
    const read = header ? csvLine(line, header) : lineEntry(line);
    if (!read.entry) {
      refused.push({ line, reason: "no_number" });
      continue;
    }
    const number = normaliseNumber(read.entry);
    const context = read.context;
    if (!number.ok) {
      refused.push({ line, reason: number.reason });
      continue;
    }
    if (seen.has(number.e164)) {
      duplicate += 1;
      continue;
    }
    seen.add(number.e164);

    // A number the group already knows becomes a row pointed at its card, so the
    // caller reads who they are about to speak to before the call, not after it.
    const cardUid = cards[number.e164] ?? null;
    if (blocked.has(number.e164) || (cardUid !== null && blockedCards.has(cardUid))) {
      blockedCount += 1;
      continue;
    }
    if (cardUid) matched += 1;

    rows.push({
      version: 1,
      uid: newUid(),
      campaignUid,
      e164: number.e164,
      extension: number.extension,
      context,
      cardUid,
      state: "open",
      claim: null,
      nextCallAt: null,
      calls: [],
      trimmed: 0,
      createdAt: now.toISOString(),
    });
  }

  return { rows, refused, duplicate, blocked: blockedCount, matched };
}
