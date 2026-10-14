/**
 * Types for `adr-citation-check.mjs`, which is plain JS so it runs as a command.
 *
 * Written because the server's test typecheck reaches across into `scripts/`
 * (`server/src/adr-citation.test.ts` drives this check directly), and an untyped
 * import there makes every value in it `any` — the test then passes on a
 * signature the check no longer has.
 */

export interface RepoFile {
  /** Relative to the repository root. */
  path: string;
  text: string;
}

/** A `Status` or `Implementation` line a record does not carry, or carries wrong. */
export interface RecordProblem {
  path: string;
  line?: number;
  why: string;
}

/** A citation that names a record the repository does not hold. */
export interface UnknownCitation {
  path: string;
  line: number;
  number: string;
}

/** A citation that cannot be followed at all. */
export interface BrokenCitation {
  path: string;
  line: number;
  why: string;
}

export function recordProblems(file: RepoFile): RecordProblem[];
export function checkRecordShape(args?: { recordFiles?: RepoFile[] }): {
  ok: boolean;
  problems: RecordProblem[];
  counts: { records: number };
};
export function citationsIn(text: string): {
  numbers: Array<{ number: string; line: number }>;
  broken: Array<{ line: number; why: string }>;
};
export function checkCitations(args?: { files?: RepoFile[]; records?: string[] }): {
  ok: boolean;
  unknown: UnknownCitation[];
  broken: BrokenCitation[];
  counts: { citations: number; records: number };
};
export function formatReport(result: ReturnType<typeof checkCitations>): string[];
export function formatShapeReport(result: ReturnType<typeof checkRecordShape>): string[];
export function collectRepoInput(root?: string): {
  files: RepoFile[];
  /** The four-digit numbers of every record the repository holds. */
  records: string[];
  recordFiles: RepoFile[];
};
export function readPaths(root?: string): string[];
