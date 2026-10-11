#!/usr/bin/env bash
# Pre-push gate (see AGENTS.md, "Every push is gated").
#
# The gate is `npm run check:ci` (== `npm run prepush`). Behaviour:
#   - default        -> the FULL gate (`npm run check:ci`)
#   - GATE=fast      -> only the fast checks (typecheck + lint/Biome)
#   - GATE=off       -> skip, deliberately (like --no-verify, but explicit)
# Besides, it skips without running anything when:
#   - nothing a gate reads changed (see "What the checks read", below), or
#   - this exact tree (tree hash) already passed in this mode (cache
#     `.git/gate-cache`). A new branch always runs.
#
# It keeps the suite from re-running on every push while iterating. A push is
# still covered by CI (release/Dependabot) and by review.
set -uo pipefail

case "${GATE:-full}" in
	full | fast) ;;
	off)
		echo "pre-push: GATE=off — skipping the gates (deliberate bypass)."
		exit 0
		;;
	*)
		echo "pre-push: GATE='${GATE}' is not valid (fast|full|off)." >&2
		exit 2
		;;
esac
mode="${GATE:-full}"

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# The files that will be pushed: the difference from the upstream.
#
# The base is the branch's push ref, its upstream, or `origin/main`, and it is
# verified before it is trusted: an unresolvable ref would make every diff
# empty, and an empty diff read as "nothing to push" is a gate that never runs.
# A base that cannot be resolved fails CLOSED, by running the gate.
base="$(git rev-parse --abbrev-ref --symbolic-full-name '@{push}' 2>/dev/null || true)"
[ -n "$base" ] || base="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
[ -n "$base" ] || base=origin/main

changed=""
if git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
	changed="$(git diff --name-only "${base}..HEAD" 2>/dev/null || true)"
	if [ "$(git rev-list --count "${base}..HEAD" 2>/dev/null || echo 0)" = "0" ] && [ -z "$changed" ]; then
		echo "pre-push: nothing to push; skipping."
		exit 0
	fi
else
	echo "pre-push: cannot resolve '${base}' to a commit; running the gate." >&2
fi

# What the checks read.
#
# A changed path a gate reads forces a run. The checks read the tree rather than
# a list — `config:dead` reads every text file, `adr:cite` the shipped documents
# and the skills — so prose, `*.md` included, is read like any other text. Ask
# the checks for the paths they read, and treat a path git does not call binary
# as read as well: the toolchain (tsc, Biome, the tests, the build) reads text
# too, and no check names all of it. What is left to skip is a diff whose every
# path is binary and named by no check. A read set that cannot be derived is not
# a reason to skip: the gate runs.
if [ -n "$changed" ]; then
	if reads="$(node --input-type=module -e '
import { pathToFileURL } from "node:url";
const root = process.argv[1];
const paths = new Set();
for (const rel of [
  "scripts/dead-config-check.mjs",
  "scripts/adr-citation-check.mjs",
  "scripts/workflow-pin-check.mjs",
]) {
  const mod = await import(pathToFileURL(`${root}/${rel}`).href);
  const input = mod.collectRepoInput();
  for (const file of [...(input.files ?? []), ...(input.recordFiles ?? [])])
    paths.add(file.path ?? file.name);
}
process.stdout.write([...paths].join("\n"));
' "$root")"; then
		binary="$(git diff --numstat "${base}..HEAD" 2>/dev/null | awk -F'\t' '$1 == "-" { print $3 }')"
		run=0
		while IFS= read -r path; do
			[ -n "$path" ] || continue
			if printf '%s\n' "$reads" | grep -qxF -- "$path"; then
				run=1
				break
			fi
			if ! printf '%s\n' "$binary" | grep -qxF -- "$path"; then
				run=1
				break
			fi
		done <<EOF
$changed
EOF
		if [ "$run" = 0 ]; then
			echo "pre-push: nothing a gate reads changed; skipping."
			exit 0
		fi
	else
		echo "pre-push: cannot read what the gates read; running the gate." >&2
	fi
fi

# Skip when this exact tree has already passed in this mode.
cache="$(git rev-parse --git-dir)/gate-cache"
key="$(git rev-parse HEAD^{tree}):$mode"
if [ -f "$cache" ] && grep -qxF "$key" "$cache"; then
	echo "pre-push: tree already verified ($mode); skipping."
	exit 0
fi

if [ "$mode" = "full" ]; then
	echo "pre-push: FULL gate (npm run check:ci)…"
	npm run check:ci
else
	echo "pre-push: fast gate (typecheck + lint)…"
	npm run typecheck && npm run lint
fi
status=$?
if [ "$status" -eq 0 ]; then
	printf '%s\n' "$key" >>"$cache"
fi
exit "$status"
