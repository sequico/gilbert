#!/usr/bin/env bash
# Pre-push gate (see AGENTS.md, "Every push is gated").
#
# The gate is `npm run check:ci` (== `npm run prepush`). Behaviour:
#   - default        -> the FULL gate (`npm run check:ci`)
#   - GATE=fast      -> only the fast checks (`npm run check:fast`)
#   - GATE=off       -> skip, deliberately (like --no-verify, but explicit)
#   - a push whose tip is not the checked-out commit is REFUSED, rather than
#     gated against this checkout's tree: the gate verifies a tree, and this
#     hook can only verify the one that is checked out.
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

# A sha field git named, or the all-zero value it sends for a ref that does not
# exist (a creation, or a deletion), whatever the repository's hash length.
nonzero() {
	case "${1:-}" in
		"" | *[!0]*) [ -n "${1:-}" ] ;;
		*) false ;;
	esac
}

# The ref updates git hands a pre-push hook on stdin, one per line:
#
#     <local ref> <local sha> <remote ref> <remote sha>
#
# The gate verifies a TREE, and the only tree this hook can verify is the one
# checked out: `npm run check:ci` typechecks, tests and builds the working
# directory, not an arbitrary commit. So a push whose tip is not HEAD is refused
# rather than gated against the wrong tree -- which is what it used to be:
# `git push origin <other-branch>` ran the gate over this branch's tree, and the
# tree-hash cache below could even skip it. A direct run (`npm run`, a terminal)
# has no ref lines on stdin and gates the checked-out branch, which is the same
# thing.
pushed_sha=""
base_sha=""
if [ ! -t 0 ]; then
	head_sha="$(git rev-parse HEAD 2>/dev/null || true)"
	while read -r local_ref local_sha remote_ref remote_sha; do
		if ! nonzero "$local_sha"; then
			continue # a deletion: no tree travels with it
		fi
		if [ "$local_sha" != "$head_sha" ]; then
			echo "pre-push: refusing to gate '${remote_ref:-$local_ref}': ${local_sha} is not the checked-out HEAD." >&2
			echo "pre-push: check that commit out to gate it, or push with --no-verify deliberately." >&2
			exit 1
		fi
		pushed_sha="$local_sha"
		base_sha="$remote_sha"
	done
fi
# The commit being gated, and the cache key it is filed under: the pushed
# commit's own tree, so two branches that happen to share a HEAD are not one
# verified tree.
target="${pushed_sha:-HEAD}"

# The files that will be pushed: the difference from what the remote already has
# -- the sha the hook named, when it named one -- and otherwise the branch's push
# ref, its upstream, or `origin/main`, verified before it is trusted: an
# unresolvable ref would make every diff empty, and an empty diff read as
# "nothing to push" is a gate that never runs. A base that cannot be resolved
# fails CLOSED, by running the gate.
base="$base_sha"
nonzero "$base" || base=""
[ -n "$base" ] || base="$(git rev-parse --abbrev-ref --symbolic-full-name '@{push}' 2>/dev/null || true)"
[ -n "$base" ] || base="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
[ -n "$base" ] || base=origin/main

changed=""
if git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
	changed="$(git diff --name-only "${base}..${target}" 2>/dev/null || true)"
	if [ "$(git rev-list --count "${base}..${target}" 2>/dev/null || echo 0)" = "0" ] && [ -z "$changed" ]; then
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
const { checkModules } = await import(`${root}/scripts/lib/gateChecks.mjs`);
const paths = new Set();
for (const rel of checkModules(root)) {
  const mod = await import(pathToFileURL(`${root}/${rel}`).href);
  // One question, one shape: a check answers with the paths it reads.
  if (typeof mod.readPaths !== "function") continue;
  for (const path of mod.readPaths()) paths.add(path);
}
process.stdout.write([...paths].join("\n"));
' "$root" 2>/dev/null)"; then
		binary="$(git diff --numstat "${base}..${target}" 2>/dev/null | awk -F'\t' '$1 == "-" { print $3 }')"
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

# Skip when this exact tree has already passed in this mode: the pushed commit's
# tree, not HEAD's, so a green pass here is a pass for what is being pushed.
cache="$(git rev-parse --git-dir)/gate-cache"
key="$(git rev-parse "${target}^{tree}"):$mode"
if [ -f "$cache" ] && grep -qxF "$key" "$cache"; then
	echo "pre-push: tree already verified ($mode); skipping."
	exit 0
fi

if [ "$mode" = "full" ]; then
	echo "pre-push: FULL gate (npm run check:ci)…"
	npm run check:ci
else
	echo "pre-push: fast gate (npm run check:fast)…"
	npm run check:fast
fi
status=$?
if [ "$status" -eq 0 ]; then
	printf '%s\n' "$key" >>"$cache"
fi
exit "$status"
