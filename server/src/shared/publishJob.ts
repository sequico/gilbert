/**
 * One publish of the installation policy, as the account that made it holds it.
 *
 * A publish is a job with an id (ADR 0010): the id rides the copies it wrote
 * into every account (`PolicyPublished`), the population it measured itself
 * against is the directory as it read it, and `complete` is the claim itself —
 * true only when the directory was the whole directory and every account it
 * listed got the policy. The record lives in the publishing administrator's own
 * app folder rather than in the process, so the surface that shows it can be
 * restarted, redeployed, or answered by another instance and still say the same
 * thing.
 *
 * Both tiers read it: the server writes the document and validates it on the
 * way back in (`isPublishJob`, `readPublishJob` in `server/src/adminPolicy.ts`),
 * and the administration surface says what it means
 * (`web/src/views/admin/AdminPolicy.tsx`). It is here because a second
 * declaration of these fields is how the client's copy came to be missing one:
 * `record` was added to the server's shape and the browser kept describing a
 * document the server no longer wrote.
 *
 * What is **not** a second copy of anything here: `web/src/lib/settingsPolicy.ts`
 * is the client's reader of the policy's three sections, typed as the
 * `Settings` keys this build knows. It is a different document's reader — the
 * policy an account follows rather than the job a publish records — and its
 * `PolicyChange`/`SettingsPolicy` are not a duplicate of these types.
 */

/**
 * Why one account did not receive a publish's copy.
 *
 * A code rather than a sentence, because a caller composes prose from it: the
 * client shows the reason in the reader's own language, and a test can assert
 * on the reason without matching a message. A build older than the server that
 * sent one reports it as unexplained rather than guessing (`refusalReason`).
 */
export type PublishRefusal =
  | "impersonation-refused"
  | "no-files-account"
  | "write-failed"
  /** The folder moved between the read and the write: nothing was written. */
  | "policy-moved";

/** One account a publish could not write to, and why. */
export interface PublishUnreached {
  address: string;
  code: PublishRefusal | "directory-denied";
  message: string;
}

/** One publish, as the account that made it holds it. */
export interface PublishJob {
  /** The document's own version, so a later shape can tell itself apart. */
  v: 1;
  /** This publish's id; the same one every copy it wrote carries. */
  id: string;
  /** When the publish started. */
  startedAt: string;
  /** Who published, as the address they signed in with. */
  by: string;
  /**
   * The directory as the publish read it: how many individual accounts it
   * listed, whether that list was the whole directory, and how many there are
   * in total when the server said so.
   */
  population: { read: number; complete: boolean; total: number | null };
  /** The addresses the policy was written to, the publisher's own included. */
  reached: string[];
  /** The ones it was not written to, each with the reason and what was said. */
  unreached: PublishUnreached[];
  /** Whether the installation can be said to carry this policy. */
  complete: boolean;
  /** What the server said when it refused to list the directory at all. */
  directory?: string;
  /**
   * Whether the account actually keeps this job: `"failed"` means the publish
   * ran and this report could not be stored, with the reason beside it. A job
   * read back from an account never carries it.
   */
  record?: "failed";
  recordMessage?: string;
}

/**
 * The job document's name, in the publisher's own app folder.
 *
 * One document, replaced by each publish: the question it answers is "what did
 * the last publish do", and a history of publishes is a different document
 * with a different retention rule. Its own file rather than a key of
 * `installation-policy.json`, because the two are written at different moments
 * for different readers: the copy is what an account follows, the job is what
 * the administrator reads back.
 */
export const PUBLISH_JOB_FILE = "publish-job.json";
