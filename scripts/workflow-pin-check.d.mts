/**
 * Types for `workflow-pin-check.mjs`, which is plain JS so it runs as a command.
 *
 * Written because the server's test typecheck reaches across into `scripts/`
 * (`server/src/workflow-pin-check.test.ts` drives this check directly), and an
 * untyped import there makes every value in it `any` — the test then passes on a
 * signature the check no longer has.
 */

export interface WorkflowFile {
  /** Relative to the repository root, as `collectRepoInput` reports it. */
  path: string;
  text: string;
}

/** A `uses:` that is not pinned the way this repository requires. */
export interface PinFinding {
  path: string;
  line: number;
  uses: string;
  /** The version comment beside it, when there is one. */
  comment: string | null;
  reason: string;
}

/** A `uses:` that was read as a pin, whether or not it was accepted. */
export interface PinReference {
  path: string;
  line: number;
  uses: string;
  comment: string | null;
}

/** A value written by hand in one workflow and repeated in another. */
export interface DriftFinding {
  path: string;
  line: number;
  subject: string;
  reason: string;
}

export function checkWorkflowPins(files?: WorkflowFile[]): {
  /** False when any `uses:` is not pinned the way this repository requires. */
  ok: boolean;
  findings: PinFinding[];
  references: PinReference[];
  checked: number;
};
export function checkWorkflowNodeLine(
  files?: WorkflowFile[],
  engines?: string,
): { ok: boolean; findings: DriftFinding[] };
export function formatReport(findings: PinFinding[]): string[];
export function formatPins(references: PinReference[]): string[];
export function collectRepoInput(root?: string): { files: WorkflowFile[] };
export function readPaths(root?: string): string[];
