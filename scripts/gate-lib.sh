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

# Run the areas it is given, the independent steps together, and say what ran.
#
# A failing step prints its own log: a gate that says "failed" without the
# sentence the tool wrote is a gate somebody re-runs by hand to read.
#
# **At most one step per core**, in batches: seven steps on four cores do not
# finish in the time of the slowest — they fight for the cores and the tests,
# which are the long step, lose. `GATE_JOBS` overrides the count.
gate_run() {
	local area
	for area in "$@"; do
		if [ "$area" = full ]; then
			echo "gate: FULL (npm run check:ci)"
			npm run check:ci
			return $?
		fi
	done

	local root logs jobs started steps step slug command
	root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
	logs="$(mktemp -d "${TMPDIR:-/tmp}/gilbert-gate.XXXXXX")"
	jobs="${GATE_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
	steps=()
	local hole=0

	for area in "$@"; do
		local before=${#steps[@]}
		while IFS= read -r command; do
			[ -n "$command" ] || continue
			steps+=("${area}|${command}")
		done < <(gate_commands "$area")
		# An area with no command is a name the runner does not know: fail closed,
		# or the gate quietly runs nothing and says it passed.
		if [ "${#steps[@]}" = "$before" ]; then
			echo "gate: '$area' names no step; refusing to pass on nothing." >&2
			hole=1
		fi
	done
	if [ "${#steps[@]}" = 0 ]; then
		echo "gate: nothing to run; refusing to pass on nothing." >&2
		return 1
	fi

	started=$(date +%s)
	echo "gate: ${#steps[@]} step(s), ${jobs} at a time ($(printf '%s ' "$@"))"
	local status=$hole index=0 log rc at
	while [ "$index" -lt "${#steps[@]}" ]; do
		local batch=() pids=() logs_of=() names=()
		while [ "${#batch[@]}" -lt "$jobs" ] && [ "$index" -lt "${#steps[@]}" ]; do
			batch+=("${steps[$index]}")
			index=$((index + 1))
		done
		for step in "${batch[@]}"; do
			slug="${step%%|*}: ${step#*|}"
			log="${logs}/$(printf '%s' "$slug" | tr ' /:' '___').log"
			names+=("$slug")
			logs_of+=("$log")
			(
				cd "$root" || exit 1
				# shellcheck disable=SC2086 # the command is a command line by design
				bash -c "${step#*|}" >"$log" 2>&1
				echo $? >"${log}.rc"
			) &
			pids+=($!)
		done
		wait
		for at in "${!pids[@]}"; do
			# `wait` hands back the last job's status only: each step writes its own.
			rc="$(cat "${logs_of[$at]}.rc" 2>/dev/null || echo 1)"
			if [ "$rc" != 0 ]; then
				status=1
				echo "gate: FAILED — ${names[$at]}"
				sed -n '1,30p' "${logs_of[$at]}" | sed 's/^/    /'
			fi
		done
	done
	echo "gate: done in $(( $(date +%s) - started ))s (logs in ${logs})"
	return "$status"
}
