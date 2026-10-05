/**
 * The one JSON writer for the documents Gilbert keeps in an account's app
 * folder — the synced settings, a group's label catalog, a chat transcript,
 * the agent's rules, schedule, claims, jobs and audit.
 *
 * Both tiers write those documents: the browser through `writeAppJson`
 * (`web/src/lib/appFolder.ts`), the server through `uploadJsonBlob` and the
 * writers built on it (`server/src/appFolder.ts`). Each tier also reads what
 * the other wrote — the settings document a browser saves is read by the
 * administration (ADR 0007), and the agent's documents are written by a worker
 * and shown by the administration surface — so "the document" has to mean one
 * sequence of bytes rather than two spellings that happen to parse alike. Two
 * spellings would make the same value look like a change to anything comparing
 * blobs, and leave neither tier able to say what a document looks like.
 *
 * The form is two-space indentation and no trailing newline, which is the form
 * the client already hands a person as a JSON export (`exportJson`,
 * `web/src/store/settings.ts`) and the one the installation policy document is
 * shown in (`policyDocumentText`, `server/src/adminPolicy.ts`). An app-folder
 * document is not private to the code that wrote it: it lies in the account's
 * own Files, where another client and an administrator looking into an account
 * can read it, and it is what a rule that misbehaved is understood from. The
 * folder is hidden from Gilbert's Files view, not from the account. Indentation
 * costs a few hundred bytes on documents that are written whole and read by
 * people, and it buys one fixed shape instead of whichever `JSON.stringify`
 * call site happened to write the file.
 *
 * The value is fixed, so the same value is always the same bytes. That is what
 * a writer re-applying a change after it lost a compare-and-set needs (ADR
 * 0003, *Coordination: leases, claims and fencing*): the retry writes the
 * document it meant to write, not a differently shaped copy of it.
 */
export function appDocumentJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
