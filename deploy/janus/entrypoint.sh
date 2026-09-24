#!/bin/bash
# Gilbert's container entrypoint: the server, and the phone's bridge beside it
# (ADR 0023).
#
# The bridge is a second process, so this starts it, runs whatever the image
# was told to run, and keeps the two alive together: if either goes, both go,
# and the container's restart policy brings them back. `GILBERT_BRIDGE=0` runs
# without it — the agent container does, since it serves no phone.
set -euo pipefail

bridge=""
if [ "${GILBERT_BRIDGE:-1}" = "1" ]; then
  janus &
  bridge=$!
fi

"$@" &
app=$!

stop() {
  [ -n "$bridge" ] && kill "$bridge" 2>/dev/null || true
  kill "$app" 2>/dev/null || true
}
trap stop TERM INT

# Wait for either to exit; the one that did not is stopped with it.
status=0
wait -n || status=$?
stop
wait || true
exit "$status"
