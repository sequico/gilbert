#!/usr/bin/env node
/**
 * Generate the bridge's STUN responder config (ADR 0023).
 *
 * The port the responder binds and the port the administration tells an
 * operator to open are the same fact, so it is read from its one definition
 * (`server/src/shared/phone.ts`) and written here: the config the deployment
 * installs cannot drift from the line the UI shows.
 *
 *   node scripts/stunConfig.mjs <output-path>
 *
 * The responder is coturn in **STUN-only** mode. It answers the browser's
 * Binding request with the address its network gave it, so ICE has a
 * server-reflexive candidate for this bridge; it relays nothing and holds
 * nothing, and no TURN transport or relay port is opened.
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync(
  new URL("../server/src/shared/phone.ts", import.meta.url),
  "utf8",
);
const port = /\bBRIDGE_STUN_PORT\s*=\s*(\d+)/.exec(source)?.[1];
if (!port)
  throw new Error("BRIDGE_STUN_PORT is not declared in server/src/shared/phone.ts");

const out = process.argv[2];
if (!out) throw new Error("usage: stunConfig.mjs <output-path>");

writeFileSync(
  out,
  `# Written by scripts/stunConfig.mjs from @gilbert/shared/phone (ADR 0023).
# Do not edit here: change the port in server/src/shared/phone.ts and run the
# script again, so the port the responder binds and the port an administrator
# opens cannot disagree.
#
# STUN only: the browser asks for the address its network gives it, and ICE
# gets a server-reflexive candidate for the bridge. No TURN, no relay.
listening-port=${port}
stun-only
no-tcp
no-tls
no-dtls
no-cli
no-multicast-peers
no-software-attribute
fingerprint
simple-log
`,
);
