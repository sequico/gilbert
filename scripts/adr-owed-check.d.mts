/**
 * Types for `adr-owed-check.mjs`, which is plain JS so it runs as a command.
 *
 * Written because the server's test typecheck reaches across into `scripts/`
 * (`server/src/adr-owed-check.test.ts` drives this check directly), and an
 * untyped import there makes every value in it `any` — the test then passes on a
 * signature the check no longer has.
 */

import type { RepoFile } from "./lib/repoFile.mjs";

/** An `<!-- owed: <slug> -->` marker, and where it sits. */
export interface OwedMarker {
  slug: string;
  line: number;
}

/** An `owed:<adr>:<slug>` tag in code. */
export interface OwedTag extends OwedMarker {
  /** Four digits, as the record's own number is written. */
  adr: string;
}

/** A marker or tag that could not be read as one. */
export interface MalformedMarker {
  line: number;
  marker: string;
  reason: string;
}

export interface MalformedWithPath extends MalformedMarker {
  side: "adr" | "code";
  path: string;
}

export function owedMarkersInAdr(text: string): {
  markers: OwedMarker[];
  malformed: MalformedMarker[];
};
export function owedTagsInCode(text: string): {
  tags: OwedTag[];
  malformed: MalformedMarker[];
};
/** The four digits of a record's file name, or null when it is not one. */
export function adrNumberFromPath(path: string): string | null;
/** A debt one side states and the other does not. */
export interface OwedOneSided {
  adr: string;
  slug: string;
  /** Where it was stated, as `path:line`. */
  where: string[];
}

/** A debt stated on both sides, which is one debt and not two. */
export interface OwedDuplicate {
  adr: string;
  slug: string;
  where: string[];
}

export function checkOwed(args?: {
  adrFiles?: RepoFile[] | Record<string, string>;
  codeFiles?: RepoFile[] | Record<string, string>;
}): {
  ok: boolean;
  adrOnly: OwedOneSided[];
  codeOnly: OwedOneSided[];
  duplicates: OwedDuplicate[];
  malformed: MalformedWithPath[];
  counts: { adrs: number; adrMarkers: number; codeMarkers: number };
};
export function formatReport(result: ReturnType<typeof checkOwed>): string[];
export function collectRepoInput(root?: string): {
  adrFiles: RepoFile[];
  codeFiles: RepoFile[];
};
export function readPaths(root?: string): string[];
