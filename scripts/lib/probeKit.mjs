/**
 * What the live probes share: a credential and the answer sheet.
 *
 * Every `scripts/probe-*.mjs` asks a real server a question the mock cannot
 * answer, prints what it was told, and exits non-zero when an answer is not the
 * one the code depends on. They were written one at a time and each carried its
 * own `basic`, its own session call, and — in three of them — the same `record`,
 * `note` and `report` written out again. The probes stay separate (each asks
 * about one surface, and each is run by hand); what they *share* is here.
 *
 * Two conventions this file is the home of, because a reader of one probe should
 * not have to learn a second dialect:
 *
 *   - a **recorded** answer is one the code assumes, and the report is non-zero
 *     when the server answered otherwise;
 *   - a **noted** answer is one the code survives either way, or that settles
 *     none of it, and it never affects the exit code.
 */

/** Stalwart's Basic credential. The password is never printed, here or after. */
export function basic(address, secret) {
  return `Basic ${Buffer.from(`${address}:${secret}`, "utf8").toString("base64")}`;
}

const answers = [];
const notes = [];

/**
 * Record one question's answer and whether it is one the code depends on.
 * `assumed` may be a list: a read that survives either shape says so rather
 * than pretending the server answered one way.
 */
export function record(question, answer, assumed) {
  const wanted = Array.isArray(assumed) ? assumed : [assumed];
  answers.push({
    question,
    answer,
    assumed: wanted.join(" | "),
    ok: wanted.includes(answer),
  });
}

/** Something the code survives either way, or that settles none of it. Read. */
export function note(question, answer) {
  notes.push({ question, answer });
}

/**
 * The answer sheet: what was noted, what was recorded, and whether every
 * recorded answer is what the code assumes.
 *
 * Answers 0 when they all hold and 1 when one does not, so a probe's exit code
 * is this and not a second opinion. `where` is the probe's own instruction —
 * which comment, which test's owed note — for the person who has to write the
 * answers down.
 */
export function report({ where }) {
  console.log("");
  for (const { question, answer } of notes) console.log(`note ${question}: ${answer}`);
  console.log("");
  let wrong = 0;
  for (const entry of answers) {
    if (!entry.ok) wrong += 1;
    console.log(
      `${entry.ok ? "ok  " : "DIFF"} ${entry.question}: ${entry.answer} (assumed ${entry.assumed})`,
    );
  }
  console.log("");
  if (wrong) {
    console.log(
      `${wrong} question(s) did not answer the way the read assumes. Record the answers,\n` +
        `with the server's version and the date, ${where}, and change what depends on\n` +
        "them before anything relies on this read.",
    );
    return 1;
  }
  console.log(
    `Every assumed behaviour holds on this server. Record the answers, with the version\nand the date, ${where}.`,
  );
  return 0;
}
