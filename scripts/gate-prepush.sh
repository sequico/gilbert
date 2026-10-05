#!/usr/bin/env bash
# Gate pre-push a comando (vedi AGENTS.md, regola "Every push is gated").
#
# Il gate è `npm run check:ci` (== `npm run prepush`). Il comportamento:
#   - default        -> gate COMPLETO (`npm run check:ci`)
#   - GATE=fast      -> solo i controlli veloci (typecheck + lint/Biome)
#   - GATE=off       -> salta, deliberatamente (come --no-verify, ma esplicito)
# In più salta senza eseguire nulla quando:
#   - il push non tocca file letti da alcun gate (solo prosa: `*.md` fuori da
#     `docs/adr/`; gli ADR e `locales/` SONO input dei gate), oppure
#   - l'albero esatto (tree-hash) è già passato in questo modo (cache
#     `.git/gate-cache`). Un nuovo branch esegue sempre.
#
# Serve a non rieseguire la suite a ogni push quando si itera. Il push resta
# comunque coperto dal CI (release/Dependabot) e dalla revisione.
set -uo pipefail

case "${GATE:-full}" in
	full | fast) ;;
	off)
		echo "pre-push: GATE=off — salto i gate (bypass deliberato)."
		exit 0
		;;
	*)
		echo "pre-push: GATE='${GATE}' non valido (fast|full|off)." >&2
		exit 2
		;;
esac
mode="${GATE:-full}"

# File che verranno pushati: differenza rispetto all'upstream.
base="$(git rev-parse --abbrev-ref --symbolic-full-name '@{push}' 2>/dev/null ||
	git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null ||
	echo origin/main)"
changed="$(git diff --name-only "$base"..HEAD 2>/dev/null || true)"

if [ "$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)" = "0" ] && [ -z "$changed" ]; then
	echo "pre-push: niente da pushare; salto."
	exit 0
fi

if [ -n "$changed" ]; then
	# Diff-scope: prosa non letta da alcun gate = `*.md` che non sta in docs/adr/.
	if printf '%s\n' "$changed" | grep -qvE '\.md$' ||
		printf '%s\n' "$changed" | grep -qE '^docs/adr/'; then
		run=1
	else
		run=0
	fi
	if [ "$run" = 0 ]; then
		echo "pre-push: solo prosa non letta dai gate; salto."
		exit 0
	fi
fi

# Skip se l'albero esatto è già passato in questo modo.
cache="$(git rev-parse --git-dir)/gate-cache"
key="$(git rev-parse HEAD^{tree}):$mode"
if [ -f "$cache" ] && grep -qxF "$key" "$cache"; then
	echo "pre-push: albero già verificato ($mode); salto."
	exit 0
fi

if [ "$mode" = "full" ]; then
	echo "pre-push: gate COMPLETO (npm run check:ci)…"
	npm run check:ci
else
	echo "pre-push: gate veloce (typecheck + lint)…"
	npm run typecheck && npm run lint
fi
status=$?
if [ "$status" -eq 0 ]; then
	printf '%s\n' "$key" >>"$cache"
fi
exit "$status"
