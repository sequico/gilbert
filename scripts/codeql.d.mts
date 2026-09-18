/** Types for `codeql.mjs`, which is plain JS so it can be run as a command. */
export const LANGUAGE: string;
export const SUITE: string;
export const BUNDLE_DIR: string;
export function workDir(repo: string): string;
export function treeFiles(
  repo: string,
  git?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string },
): string[];
export function exportTree(repo: string, dest: string, files?: string[]): number;
export function resolveCli(
  env?: Record<string, string | undefined>,
  exists?: (path: string) => boolean,
): string | null;
export function missingCli(): string;
export function createArgs(opts: {
  cli: string;
  db: string;
  sourceRoot: string;
}): string[];
export function analyzeArgs(opts: { cli: string; db: string; output: string }): string[];
export interface CodeqlResult {
  rule: string;
  severity: string;
  description: string;
  level: string;
  file: string;
  line: number;
  message: string;
}
export interface CodeqlReport {
  total: number;
  results: CodeqlResult[];
  byRule: { rule: string; count: number; severity: string; description: string }[];
}
export function summarize(sarif: unknown): CodeqlReport;
export function formatReport(
  report: CodeqlReport,
  opts: { sarif: string; sourceRoot: string },
): string;
export function main(opts?: {
  repo: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  exists?: (path: string) => boolean;
  spawn?: (args: string[], log: (line: string) => void) => unknown;
  git?: (args: string[]) => { status: number | null; stdout?: string; stderr?: string };
}): number;
