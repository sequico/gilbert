#!/usr/bin/env node
/**
 * Generate the bridge's main Janus config (ADR 0023).
 *
 * The media range Janus binds and the range the administration tells an
 * operator to open are the same fact, so it is read from its one definition
 * (`server/src/shared/phone.ts`) and written here: the config the deployment
 * installs cannot drift from the line the UI shows.
 *
 *   node scripts/janusConfig.mjs <output-path>
 *
 * The rest of the bridge's config is static, beside this in `deploy/janus/`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync(
  new URL("../server/src/shared/phone.ts", import.meta.url),
  "utf8",
);
const range = /\bBRIDGE_MEDIA_PORTS\s*=\s*"([^"]+)"/.exec(source)?.[1];
if (!range)
  throw new Error("BRIDGE_MEDIA_PORTS is not declared in server/src/shared/phone.ts");

const out = process.argv[2];
if (!out) throw new Error("usage: janusConfig.mjs <output-path>");

writeFileSync(
  out,
  `# Written by scripts/janusConfig.mjs from @gilbert/shared/phone (ADR 0023).
# Do not edit here: change the range in server/src/shared/phone.ts and run the
# script again, so the ports Janus binds and the ports an administrator opens
# cannot disagree.
general: {
    configs_folder = "/usr/local/etc/janus"
    plugins_folder = "/usr/local/lib/janus/plugins"
    transports_folder = "/usr/local/lib/janus/transports"
    events_folder = "/usr/local/lib/janus/events"
    log_to_file = false
    debug_level = 4
}

media: {
    rtp_port_range = "${range}"
    # No STUN, no TURN, no ICE-TCP: the host is on a public IP by construction,
    # so Janus advertises its own interface as the ICE peer (ADR 0023).
    ice_lite = false
    ice_tcp = false
}
`,
);
