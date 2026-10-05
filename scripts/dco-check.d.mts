/** Types for `dco-check.mjs`, which is plain JS so the workflow can run it as a command. */
export interface CommitIdentity {
  name?: string;
  email?: string;
}
export interface CommitRecord {
  sha: string;
  author?: CommitIdentity;
  committer?: CommitIdentity;
  message?: string;
}
export interface SignOff {
  name: string;
  email: string;
}
export function parseSignOffs(message: string): SignOff[];
export function checkCommits(commits?: CommitRecord[]): {
  ok: boolean;
  findings: { sha: string; subject: string; reason: string }[];
};
export function formatReport(
  findings: { sha: string; subject: string; reason: string }[],
): string[];
