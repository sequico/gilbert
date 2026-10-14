/**
 * Types for `dead-config-check.mjs`, which is plain JS so it runs as a command.
 *
 * Written because the server's test typecheck reaches across into `scripts/`
 * (`server/src/dead-config-check.test.ts` drives this check directly), and an
 * untyped import there makes every value in it `any` — the test then passes on a
 * signature the check no longer has.
 */

export interface RepoFile {
  /** Relative to the repository root, as `walk` reports it. */
  path: string;
  text: string;
}

export interface RetiredMention extends RepoFile {
  name: string;
  line: number;
}

export interface EnvRead {
  /** The key read, or `<the environment itself>` for a bare `process.env`. */
  name: string;
  line: number;
}

export interface JudgedFile {
  retired: RetiredMention[];
  env: EnvRead[];
}

export interface DeadConfiguration {
  ok: boolean;
  retired: RetiredMention[];
  env: EnvRead[];
  counts: { files: number; retiredNames: number };
}

export function retiredNamesIn(text: string): Array<{ name: string; line: number }>;
export function envReadsIn(text: string): EnvRead[];
export function judgeFile(file?: { path?: string; text?: string }): JudgedFile;
export function checkDeadConfiguration(args?: { files?: RepoFile[] }): DeadConfiguration;
export function formatReport(result: DeadConfiguration): string[];
export function collectRepoInput(root?: string): { files: RepoFile[] };
export function readPaths(root?: string): string[];
