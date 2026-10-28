#!/usr/bin/env bash
# The gate's one description of what a change needs, and the runner that runs it.
#
# Sourced by `scripts/gate-prepush.sh`. Two questions, one place:
#
#   gate_areas_for   which parts of the tree a diff touches (stdin: changed paths,
#                    one per line; stdout: the areas, one per line)
#   gate_run         run those areas, the independent ones together
#
# The areas are the smallest sets of work that can fail on their own:
#
#   lint      Biome over the tree
#   docs      the checks that read prose and configuration — adr:owed, adr:cite,
#             config:dead — which read every text file, so they always run
#   i18n      the catalogues and the literals
#   workflow  the pinned actions, the Node line and the published image
#   web       typecheck and build of the SPA
#   server    typecheck and build of the server
#   test-web  vitest
#   test-server  node:test
#   full      everything, in the order `npm run check:ci` states
#
# **A change the map does not recognise is a full run.** The map narrows the work
# only where it can name the part that changed: the toolchain, the lockfile, the
# image, the deploy and the gate's own scripts are the whole tree's business, and
# guessing narrow there is how a red arrives in production.

# The areas a set of changed paths needs, one per line. Reads the paths on stdin.
gate_areas_for() {
	local web=0 server=0 locale=0 workflow=0 full=0
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		case "$path" in
		# Prose: read by the doc checks, which always run.
		*.md | docs/* | NOTICE | LICENSE) ;;
		# The SPA's catalogues are also the i18n check's business.
		web/src/locales/*)
			locale=1
			web=1
			;;
		# The SPA, and the shared tree it imports as `@gilbert/shared`.
		server/src/shared/*)
			web=1
			server=1
			;;
		web/*) web=1 ;;
		server/*) server=1 ;;
		.github/workflows/*) workflow=1 ;;
		# Everything else is the toolchain, the lockfile, the image, the deploy or
		# this gate: no part of the tree owns it, so all of it runs.
		*) full=1 ;;
		esac
	done

	if [ "$full" = 1 ]; then
		echo full
		return 0
	fi
	echo lint
	echo docs
	[ "$locale" = 1 ] && echo i18n
	[ "$workflow" = 1 ] && echo workflow
	[ "$web" = 1 ] && echo web && echo test-web
	[ "$server" = 1 ] && echo server && echo test-server
	return 0
}

# The commands one area runs, one per line.
gate_commands() {
	case "$1" in
	lint) echo "npx biome check ." ;;
	docs)
		echo "npm run -s adr:owed"
		echo "npm run -s adr:cite"
		echo "npm run -s config:dead"
		;;
	i18n) echo "npm run -s i18n:check" ;;
	workflow) echo "npm run -s workflow:pin" ;;
	web)
		echo "npm run -s typecheck -w web"
		echo "npm run -s build -w web"
		;;
	server)
		echo "npm run -s typecheck -w server"
		echo "npm run -s build -w server"
		;;
	test-web) echo "TZ=UTC npm run -s test -w web" ;;
	test-server) echo "TZ=UTC npm run -s test -w server" ;;
	esac
}

# Run the areas it is given, the independent ones at once, and say what ran.
#
# A failing step prints its own log: a gate that says "failed" without the
# sentence the tool wrote is a gate somebody re-runs by hand to read.
gate_run() {
	local area
	for area in "$@"; do
		if [ "$area" = full ]; then
			echo "gate: FULL (npm run check:ci)"
			npm run check:ci
			return $?
		fi
	done

	local root logs names pids status=0 started
	root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
	logs="$(mktemp -d "${TMPDIR:-/tmp}/gilbert-gate.XXXXXX")"
	names=()
	pids=()
	started=$(date +%s)

	for area in "$@"; do
		local before=${#names[@]}
		while IFS= read -r command; do
			[ -n "$command" ] || continue
			local slug="${area}: ${command}"
			local log
			log="${logs}/$(printf '%s' "$slug" | tr ' /:' '___').log"
			names+=("$slug")
			(
				cd "$root" || exit 1
				# shellcheck disable=SC2086 # the command is a command line by design
				bash -c "$command" >"$log" 2>&1
			) &
			pids+=($!)
		done < <(gate_commands "$area")
		# An area with no command is a name the runner does not know: fail closed,
		# or the gate quietly runs nothing and says it passed.
		if [ "${#names[@]}" = "$before" ]; then
			echo "gate: '$area' names no step; refusing to pass on nothing." >&2
			status=1
		fi
	done

	if [ "${#names[@]}" = 0 ]; then
		echo "gate: nothing to run; refusing to pass on nothing." >&2
		return 1
	fi

	echo "gate: $((${#names[@]})) step(s) in parallel, $(printf '%s ' "$@")"
	local at=0
	for pid in "${pids[@]}"; do
		if ! wait "$pid"; then
			status=1
			step_log="$(printf '%s' "${names[$at]}" | tr ' /:' '___')"
			echo "gate: FAILED — ${names[$at]}"
			sed -n '1,40p' "${logs}/${step_log}.log" | sed 's/^/    /'
		fi
		at=$((at + 1))
	done
	echo "gate: done in $(( $(date +%s) - started ))s (logs in ${logs})"
	return "$status"
}
