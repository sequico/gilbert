import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBasePath } from "../../scripts/basePath.mjs";
import { resolveVersion } from "../../scripts/version.mjs";
import { isAddress, type PolicyDocument, type PolicyIdentities } from "./adminPolicy.js";
import { AGENT_AREAS, type AgentArea, isAgentArea } from "./agent/documents.js";

/** Minimal .env loader (no dependency): first match wins, never overrides real env. */
function loadDotEnv() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    fileURLToPath(new URL("../../.env", import.meta.url)),
    fileURLToPath(new URL("../.env", import.meta.url)),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2]!;
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
    }
    break;
  }
}
loadDotEnv();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined)
      throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

const isProd = process.env.NODE_ENV === "production";
let appSecret = process.env.APP_SECRET ?? "";
if (!appSecret || appSecret === "change-me") {
  if (isProd) {
    throw new Error("APP_SECRET must be set to a strong random value in production");
  }
  appSecret = randomBytes(32).toString("base64");
  console.warn(
    "[gilbert] APP_SECRET not set - using an ephemeral secret (persisted sessions will not survive restarts)",
  );
}

const stalwartUrl = env("STALWART_URL", "https://mail.example.com").replace(/\/+$/, "");

/**
 * Declares that this instance is running as an immutable container: read-only
 * root filesystem, nothing durable of its own, replaceable by its image.
 *
 * It is a claim the process checks rather than one it takes on trust, because
 * the failure it guards against is silent. Left to itself the server survives
 * a read-only filesystem perfectly well -- sessions are held in memory and the
 * write is best-effort, so the only sign that `SESSION_FILE` is going nowhere
 * is one warning at the first login, long after anyone was watching. The
 * instance looks healthy right up until it is replaced and everyone is signed
 * out. Setting IMMUTABLE turns both halves of that into a refusal to start.
 */
const immutable = bool("IMMUTABLE", false);
const sessionFile = process.env.SESSION_FILE ?? "";

/**
 * Refuse to run when the promise IMMUTABLE makes is not one this instance can
 * keep. Exported so it can be tested without a read-only filesystem to hand.
 */
export function assertImmutable(sessionFile: string, root: string): void {
  // The image sets SESSION_FILE=/data/sessions.json, so this is a deliberate
  // refusal rather than a formality: running immutably means clearing it. It
  // is not quietly ignored, because a configured path that silently persists
  // nothing is exactly the failure this flag exists to surface.
  if (sessionFile) {
    throw new Error(
      `IMMUTABLE is set, but SESSION_FILE is ${sessionFile}. An immutable instance keeps no durable state of its own: ` +
        "pass SESSION_FILE= (empty) to hold sessions in memory, or unset IMMUTABLE.",
    );
  }
  // And check the property itself, not just the intention to have it. Setting
  // the variable while forgetting `--read-only` is the easy mistake, and it
  // leaves an instance claiming a guarantee it does not have.
  const probe = resolve(root, ".immutable-probe");
  let writable = false;
  try {
    writeFileSync(probe, "");
    writable = true;
    unlinkSync(probe);
  } catch {
    /* EROFS, or EACCES on a root we do not own: either way, not writable by us */
  }
  if (writable) {
    throw new Error(
      `IMMUTABLE is set, but ${root} is writable. Run the container with --read-only (and --tmpfs /tmp), or unset IMMUTABLE.`,
    );
  }
}

if (immutable)
  assertImmutable(sessionFile, fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Settings an installation decides, rather than each reader.
 *
 * A school turning on "warn about outside senders" for three thousand pupils
 * cannot ask three thousand pupils to turn it on -- issue #207. Two sections,
 * which are two different powers:
 *
 * - `defaults` seed an account that has never had settings of its own. The
 *   reader can change any of them afterwards; they are a starting point, not a
 *   rule.
 * - `enforced` are applied on every load and cannot be changed here at all. The
 *   controls stay visible and go dead, which the issue asked for by name: a
 *   missing control confuses somebody who has used Gilbert elsewhere.
 * - `changes` are applied once each, to everybody, including accounts that
 *   already exist -- and can be changed back afterwards. Each carries its own
 *   `version`, which is how an account remembers the ones it has had. The
 *   reporter's own analogy is a schema migration and this is that shape.
 *
 * Read from a file or straight from the environment, because Gilbert's own
 * production runs read-only with no volume -- an installation that cannot mount
 * a file can still set a variable.
 *
 * The shape is the document's, declared once in `adminPolicy.ts` and shared with
 * the surface that edits it, so the reader and the editor cannot drift into two
 * ideas of what a policy is.
 */
function readSettingsPolicy(): PolicyDocument {
  const parse = (raw: string, where: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error("not a JSON object");
      return v as Record<string, unknown>;
    } catch (err) {
      /* Loud, and fatal. A policy that silently did not apply would look like
         the feature not working, and the admin would have no way to tell. */
      throw new Error(`Invalid ${where}: ${(err as Error).message}`);
    }
  };

  /**
   * A change list, checked rather than trusted.
   *
   * Every entry needs a `version` that is unique within the file: it is what an
   * account stores to say it has had this one, so a duplicate would make two
   * changes indistinguishable and a missing one would apply for ever.
   */
  const parseChanges = (
    v: unknown,
    where: string,
  ): Array<{ version: string; settings: Record<string, unknown> }> => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`Invalid ${where}: "changes" must be a list`);
    const seen = new Set<string>();
    return v.map((entry, i) => {
      const e = entry as { version?: unknown; settings?: unknown };
      const version = typeof e.version === "string" ? e.version.trim() : "";
      if (!version) throw new Error(`Invalid ${where}: changes[${i}] has no "version"`);
      if (seen.has(version))
        throw new Error(`Invalid ${where}: two changes share the version "${version}"`);
      seen.add(version);
      if (!e.settings || typeof e.settings !== "object" || Array.isArray(e.settings)) {
        throw new Error(
          `Invalid ${where}: changes[${i}] ("${version}") has no "settings" object`,
        );
      }
      return { version, settings: e.settings as Record<string, unknown> };
    });
  };

  /**
   * The agent the file names, when it names one.
   *
   * Optional, and checked rather than trusted like everything else here: an
   * "agent" with no usable address is a configuration error at boot, not a
   * value to fall back from silently.
   */
  const parseAgent = (
    v: unknown,
    where: string,
  ): { agent?: { address: string; groups?: Record<string, { areas?: string[] }> } } => {
    if (v == null) return {};
    if (typeof v !== "object" || Array.isArray(v))
      throw new Error(`Invalid ${where}: "agent" must be an object`);
    const typed = v as { address?: unknown; groups?: unknown };
    const address =
      typeof typed.address === "string" ? typed.address.trim().toLowerCase() : "";
    if (!isAddress(address))
      throw new Error(
        `Invalid ${where}: "agent.address" must be the agent's own address, like gilbert@example.com`,
      );
    const groups: Record<string, { areas?: string[] }> = {};
    if (typed.groups != null) {
      if (typeof typed.groups !== "object" || Array.isArray(typed.groups))
        throw new Error(`Invalid ${where}: "agent.groups" must be an object`);
      for (const [rawName, entry] of Object.entries(
        typed.groups as Record<string, unknown>,
      )) {
        const name = rawName.trim().toLowerCase();
        if (!isAddress(name))
          throw new Error(
            `Invalid ${where}: "agent.groups" names something that is not a group: ${rawName}`,
          );
        if (entry == null) continue;
        const areas = (entry as { areas?: unknown }).areas;
        if (areas === undefined) continue;
        if (!Array.isArray(areas) || areas.some((a) => typeof a !== "string"))
          throw new Error(
            `Invalid ${where}: "agent.groups.${name}.areas" must be a list of area names`,
          );
        const clean = [
          ...new Set(areas.map((area) => String(area).trim()).filter(Boolean)),
        ];
        groups[name] = clean.length ? { areas: clean } : {};
      }
    }
    return {
      agent: { address, ...(Object.keys(groups).length ? { groups } : {}) },
    };
  };

  /**
   * The identities an administrator has taken over (ADR 0010 §4).
   *
   * Mirrors the surface's rule: an entry that is not an address is a
   * configuration error at boot, not a value to fall back from silently. An
   * empty list and an absent one both mean nobody is locked.
   */
  const parseIdentities = (
    v: unknown,
    where: string,
  ): { identities?: PolicyIdentities } => {
    if (v == null) return {};
    if (typeof v !== "object" || Array.isArray(v))
      throw new Error(`Invalid ${where}: "identities" must be an object`);
    const locked = (v as { locked?: unknown }).locked;
    if (locked === undefined) return {};
    if (!Array.isArray(locked) || locked.some((entry) => typeof entry !== "string"))
      throw new Error(
        `Invalid ${where}: "identities.locked" must be a list of account addresses`,
      );
    const addresses: string[] = [];
    for (const entry of locked as string[]) {
      const address = entry.trim().toLowerCase();
      if (!isAddress(address))
        throw new Error(
          `Invalid ${where}: "identities.locked" names something that is not an address: ${entry}`,
        );
      if (!addresses.includes(address)) addresses.push(address);
    }
    return addresses.length ? { identities: { locked: addresses } } : {};
  };

  const file = process.env.SETTINGS_POLICY_FILE;
  if (file) {
    if (!existsSync(file))
      throw new Error(`SETTINGS_POLICY_FILE does not exist: ${file}`);
    const whole = parse(readFileSync(file, "utf8"), `SETTINGS_POLICY_FILE (${file})`);
    return {
      defaults: (whole.defaults as Record<string, unknown>) ?? {},
      enforced: (whole.enforced as Record<string, unknown>) ?? {},
      changes: parseChanges(whole.changes, `SETTINGS_POLICY_FILE (${file})`),
      ...parseAgent(whole.agent, `SETTINGS_POLICY_FILE (${file})`),
      ...parseIdentities(whole.identities, `SETTINGS_POLICY_FILE (${file})`),
    };
  }
  return {
    defaults: process.env.SETTINGS_DEFAULTS
      ? parse(process.env.SETTINGS_DEFAULTS, "SETTINGS_DEFAULTS")
      : {},
    enforced: process.env.SETTINGS_ENFORCED
      ? parse(process.env.SETTINGS_ENFORCED, "SETTINGS_ENFORCED")
      : {},
    changes: process.env.SETTINGS_CHANGES
      ? parseChanges(JSON.parse(process.env.SETTINGS_CHANGES), "SETTINGS_CHANGES")
      : [],
  };
}

/**
 * Which Stalwart a domain signs in to.
 *
 * `STALWART_URL` stays required and stays the default; this only adds domains
 * that go somewhere else (#238). An installation that sets nothing behaves
 * exactly as it always has.
 *
 * Read once at boot and never written, so it mounts read-only and costs
 * nothing in immutability -- the same shape as the settings policy.
 *
 * Servers are deliberately **not** probed here. A mapping is a routing table,
 * not a health check, and refusing to boot because one of five customers is
 * having an outage would take the other four down with it. What happens when
 * one is unreachable is a sign-in question, answered in #239.
 */
function readStalwartServers(): Record<string, string> {
  const file = process.env.STALWART_SERVERS_FILE;
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`STALWART_SERVERS_FILE does not exist: ${file}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid STALWART_SERVERS_FILE (${file}): expected an object of domain to URL`,
    );
  }

  const out: Record<string, string> = {};
  for (const [rawDomain, rawUrl] of Object.entries(raw as Record<string, unknown>)) {
    /* Lower-cased and stripped of the root dot, because that is how a domain
       taken off a username will arrive and comparing them any other way means
       a mapping that silently never matches. */
    const domain = rawDomain.trim().toLowerCase().replace(/\.$/, "");
    if (!domain)
      throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): a domain key is empty`);
    if (domain in out)
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" appears twice once normalised`,
      );
    if (typeof rawUrl !== "string")
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" is not a URL`,
      );
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" is not an absolute URL`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Invalid STALWART_SERVERS_FILE (${file}): "${domain}" must be http or https`,
      );
    }
    out[domain] = rawUrl.replace(/\/+$/, "");
  }
  return out;
}

/**
 * The agent worker's bootstrap (ADR 0003, v1 scope).
 *
 * One structure agent per installation, and one secret for it: the agent's
 * own app password, which reaches exactly the accounts the operator granted
 * it. The web tier reads the same variables only to know which address to
 * register and verify; the secret is the worker's.
 *
 * `GILBERT_AGENTS_FILE` is the read-only alternative to the environment, in
 * the `STALWART_SERVERS_FILE` shape: an address keyed to its password and,
 * optionally, the areas that agent serves. It exists because a deployment
 * that mounts secrets reads them from files, and because a value that has to
 * survive a container replacement belongs in the image's configuration, not
 * in a runtime-written `.env` -- which is impossible on a read-only root and
 * pointless on a disposable container.
 */

/** One agent's bootstrap entry, from the environment or the agents file. */
export interface AgentBootstrap {
  address: string;
  /** The app password the worker authenticates with. Empty = not configured. */
  password: string;
  /** The areas the worker serves, from the deployment. */
  areas: AgentArea[];
}

function readAgentAreas(raw: string | undefined, where: string): AgentArea[] {
  const value = (raw ?? "").trim();
  if (!value) return [...AGENT_AREAS];
  const out: AgentArea[] = [];
  for (const part of value.split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!isAgentArea(name))
      throw new Error(
        `Invalid ${where}: "${part}" is not an area (${AGENT_AREAS.join(", ")})`,
      );
    if (!out.includes(name)) out.push(name);
  }
  return out.length ? out : [...AGENT_AREAS];
}

/** The agents file, keyed by lower-cased address. */
function readAgentsFile(): Record<string, { password: string; areas?: AgentArea[] }> {
  const file = process.env.GILBERT_AGENTS_FILE;
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`GILBERT_AGENTS_FILE does not exist: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Invalid GILBERT_AGENTS_FILE (${file}): ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid GILBERT_AGENTS_FILE (${file}): expected an object of address to entry`,
    );
  }
  const out: Record<string, { password: string; areas?: AgentArea[] }> = {};
  for (const [rawAddress, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    if (rawAddress.startsWith("_")) continue; // the file's own _comment
    const address = rawAddress.trim().toLowerCase();
    if (!address.includes("@"))
      throw new Error(
        `Invalid GILBERT_AGENTS_FILE (${file}): "${rawAddress}" is not an address`,
      );
    if (address in out)
      throw new Error(
        `Invalid GILBERT_AGENTS_FILE (${file}): "${address}" appears twice once normalised`,
      );
    const entry = rawEntry as { password?: unknown; areas?: unknown };
    if (typeof entry?.password !== "string" || !entry.password)
      throw new Error(
        `Invalid GILBERT_AGENTS_FILE (${file}): "${address}" has no password`,
      );
    const areas =
      entry.areas === undefined
        ? undefined
        : readAgentAreas(
            Array.isArray(entry.areas)
              ? entry.areas.map((a) => String(a)).join(",")
              : String(entry.areas),
            `GILBERT_AGENTS_FILE (${file}) areas for "${address}"`,
          );
    out[address] = areas
      ? { password: entry.password, areas }
      : { password: entry.password };
  }
  return out;
}

function resolveAgentBootstrap(): AgentBootstrap {
  const file = readAgentsFile();
  const address = (process.env.GILBERT_AGENT_ADDRESS ?? "").trim().toLowerCase();
  const fromEnv = process.env.GILBERT_AGENT_PASSWORD ?? "";
  const entry = address ? file[address] : Object.values(file)[0];
  if (address && !fromEnv && file[address] === undefined && Object.keys(file).length) {
    /* The file was given and does not name this address: that is a
       configuration mistake, and a worker that silently ran with no secret
       would look like an agent that never does anything. */
    throw new Error(
      `GILBERT_AGENTS_FILE has no entry for ${address}; it names ${Object.keys(file).join(", ")}`,
    );
  }
  /*
   * The other half of the same mistake, and the one that is easy to make: an
   * address with no password anywhere. The web tier would fall back to
   * impersonation for every call and the worker would start with no secret —
   * two different behaviours from one missing variable, neither of them
   * obvious. Half-configured is not a state this starts in.
   */
  if (address && !fromEnv && !entry?.password) {
    throw new Error(
      `GILBERT_AGENT_ADDRESS is set to ${address} and no password was found for it: ` +
        "set GILBERT_AGENT_PASSWORD, or name the address in GILBERT_AGENTS_FILE with its password",
    );
  }
  /*
   * One agent per installation (ADR 0003 §2). A file naming several and no
   * address to pick between them would silently choose whichever came first in
   * the file — a deployment that runs a different agent than its operator wrote.
   */
  if (!address && Object.keys(file).length > 1) {
    throw new Error(
      `GILBERT_AGENTS_FILE names ${Object.keys(file).length} agents and GILBERT_AGENT_ADDRESS ` +
        "does not say which one this installation runs",
    );
  }
  const areas = process.env.GILBERT_AGENT_AREAS
    ? readAgentAreas(process.env.GILBERT_AGENT_AREAS, "GILBERT_AGENT_AREAS")
    : (entry?.areas ?? [...AGENT_AREAS]);
  return {
    address: address || (entry ? Object.keys(file)[0]! : ""),
    password: fromEnv || entry?.password || "",
    areas,
  };
}

/**
 * The agent worker's timing and health: the environment is what carries them,
 * and the environment cannot change under a running process, so they are read
 * once rather than re-resolved with the file.
 */
const agentWorkerSettings = {
  /*
   * How often a worker re-reads an account it could not be pushed about.
   * Push is the wake-up and polling is the fallback after a lost stream, so
   * this is deliberately unhurried: a minute of latency on a lost stream is
   * far cheaper than a minute of hammering Stalwart.
   */
  pollMs: int("GILBERT_AGENT_POLL_MS", 60_000),
  /* How often a working worker says it is alive, in its claims and heartbeat. */
  heartbeatMs: int("GILBERT_AGENT_HEARTBEAT_MS", 30_000),
  /*
   * How long a claim may go un-renewed before another worker takes it over.
   * Longer than a few heartbeats on purpose: an agent's work can sit in a
   * model call or wait on a person, and a takeover that fires during a
   * legitimate pause would run the same job twice.
   */
  leaseMs: int("GILBERT_AGENT_LEASE_MS", 180_000),
  /*
   * Where the worker answers a health probe, or 0 for no endpoint at all.
   * A deployment with a restart policy wants this (ADR 0003 resolution 8);
   * a worker nobody asks anything needs no listening socket.
   */
  healthPort: int("GILBERT_AGENT_HEALTH_PORT", 0),
};

/**
 * The installation's agent, as the running process holds it (ADR 0003).
 *
 * One object, re-read in place when the deployment's agents file changes. That
 * file is configuration a container replacement must not be needed for: an
 * operator who rotates the agent's secret, or names a different agent, in a
 * mounted file expects a running server to notice — and a process that read the
 * file once at boot would keep acting as the agent it started with.
 *
 * The environment cannot change under a running process, so only the file is
 * re-checked, and only its stamp is: at most one check per
 * `AGENT_FILE_RECHECK_MS`, and one stat when nothing has changed. The object
 * keeps its identity and stays writable, because the surfaces that name an
 * agent read it as one record.
 */
const agent = { ...resolveAgentBootstrap(), ...agentWorkerSettings };

/** How long the agents file may go unlooked-at before it is checked again. */
const AGENT_FILE_RECHECK_MS = 1_000;

let agentFileStamp = agentsFileStamp(process.env.GILBERT_AGENTS_FILE ?? "");
let agentCheckedAt = 0;

/** The file's identity — modified and sized — or `""` when there is nothing to read. */
function agentsFileStamp(file: string): string {
  if (!file) return "";
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

/**
 * Re-read the agents file, when one is configured and has changed.
 *
 * A file that has changed but no longer parses leaves the configuration in
 * force and says so once per distinct file: turning a typo in a mounted file
 * into a server that stops serving everyone already signed in would trade a
 * misconfigured agent for a broken installation. The stamp is kept either way,
 * so that report is a report and not a log flood.
 */
function refreshAgent(): void {
  const file = process.env.GILBERT_AGENTS_FILE;
  if (!file) return;
  const now = Date.now();
  if (now - agentCheckedAt < AGENT_FILE_RECHECK_MS) return;
  agentCheckedAt = now;
  const stamp = agentsFileStamp(file);
  if (!stamp || stamp === agentFileStamp) return;
  agentFileStamp = stamp;
  try {
    const next = resolveAgentBootstrap();
    agent.address = next.address;
    agent.password = next.password;
    agent.areas = next.areas;
    console.log(
      `[gilbert] the agents file changed: this installation's agent is now ${next.address || "(none)"}`,
    );
  } catch (err) {
    console.warn(
      "[gilbert] the agents file changed but could not be read; keeping the agent configuration in force:",
      (err as Error).message,
    );
  }
}

export const config = {
  isProd,
  appName: env("APP_NAME", "Gilbert"),
  settingsPolicy: readSettingsPolicy(),
  /**
   * What this build calls itself: `2.16.57`. Set by the image build from
   * `--build-arg GILBERT_VERSION`, since `.dockerignore` keeps `.git` out of
   * the build context and nothing in there could work it out. A dev checkout
   * has git, so it falls back to asking; see `scripts/version.mjs`.
   */
  version: resolveVersion(),
  /**
   * Where this instance's source can be had, shown to everyone who reaches it.
   *
   * The AGPL asks whoever *runs* a modified version to offer that version's
   * source, not the one it was forked from -- so anyone deploying a patched
   * Gilbert should point this at their own tree.
   */
  sourceUrl: env("SOURCE_URL", "https://github.com/sequico/gilbert"),
  host: env("HOST", "0.0.0.0"),
  port: int("PORT", 8080),
  /**
   * The subpath this instance answers on: `/mail` for a proxy that maps
   * `https://example.com/mail/` here, and `""` -- the default -- for the root.
   *
   * The prefix is expected to arrive intact: a proxy that strips it before
   * forwarding should leave BASE_PATH unset, because then as far as this
   * process is concerned it *is* at the root. What must match is the web
   * build, which bakes the same variable into its asset URLs; a server that
   * strips a prefix the bundle still asks for serves an app that cannot load
   * its own scripts. `staticHandler` says so at the first request rather than
   * leaving a blank page to explain itself.
   */
  basePath: normalizeBasePath(process.env.BASE_PATH),
  stalwartUrl,
  stalwartServers: readStalwartServers(),
  appSecret,
  trustProxy: bool("TRUST_PROXY", true),
  /**
   * Peers whose X-Forwarded-* headers are believed. Empty falls back to
   * loopback and the private ranges, which covers the usual reverse proxy on
   * the same host or Docker network. A peer outside this is attributed by its
   * socket address whatever it claims.
   */
  trustedProxies: (process.env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** "auto" = Secure when the request arrived over https; "1"/"0" to force. */
  secureCookies: (process.env.SECURE_COOKIES ?? "auto").toLowerCase(),
  sessionTtl: int("SESSION_TTL", 12 * 60 * 60),
  sessionRememberTtl: int("SESSION_REMEMBER_TTL", 30 * 24 * 60 * 60),
  sessionFile,
  /** True when this instance has asserted, and verified, that it is immutable. */
  immutable,
  upstreamTimeout: int("UPSTREAM_TIMEOUT", 30_000),
  maxUploadBytes: int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  imageProxy: bool("IMAGE_PROXY", true),
  cookieName: env("COOKIE_NAME", "ihm_session"),
  staticDir:
    process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  loginRateLimit: int("LOGIN_RATE_LIMIT", 10),
  /*
   * Requests per minute one session may make on the data path -- JMAP, blobs,
   * the image and calendar proxies. The proxy is one Node process and saturates
   * a core at roughly 2,000 operations a second, so without this a single
   * signed-in user can deny service to everyone else. 1,200 a minute is twenty
   * a second sustained: well above what a busy tab does, and an order of
   * magnitude below where one tab starts to hurt the rest. 0 disables it.
   */
  apiRateLimit: int("API_RATE_LIMIT", 1200),
  /* Whether JMAP responses are gzipped. Measured: see the bake-off rerun. */
  compressJmap: process.env.COMPRESS_JMAP !== "0",
  /**
   * The `/api/account` permission that marks a Stalwart admin (ADR 0007).
   *
   * Live-verified 2026-09-09 on Stalwart 0.16.21: `sysAccountCreate` appears
   * in a principal's resolved permission list exactly when the operator
   * grants the admin role, and `sysBootstrap*` never appears (the endpoint
   * always strips it), so it is the non-forgeable marker to test for.
   */
  adminPermissionMarker: env("GILBERT_ADMIN_PERMISSION", "sysAccountCreate"),
  /*
   * How push reaches the browser. "relay" holds one upstream stream per tab.
   * "subscribe" registers one JMAP PushSubscription per account and fans
   * Stalwart's POSTs out to that account's tabs, holding no upstream connection
   * at all -- see push.ts. The origin Stalwart POSTs back to is derived from the
   * request (see pushOrigin in app.ts); an account we cannot state one for
   * stays on the relay.
   */
  /*
   * The agent worker (ADR 0003). Everything here is read-only configuration:
   * the documents the fleet works from live in Stalwart, in the agent's own
   * account and in each group's.
   */
  /*
   * Read through `refreshAgent()`, so a file changed under a running process is
   * reflected by the next read rather than by the next restart.
   */
  get agent(): AgentBootstrap & typeof agentWorkerSettings {
    refreshAgent();
    return agent;
  },
  pushMode: (process.env.PUSH_MODE === "relay" ? "relay" : "subscribe") as
    | "relay"
    | "subscribe",
  /* See relayPushRaw(): pipe the push stream socket-to-socket instead of through fetch(). */
  rawPushRelay: process.env.RAW_PUSH_RELAY !== "0",
  /* See absoluteUpstream(): follow Stalwart's advertised origin instead of pinning to ours. */
  followAdvertisedUrls: process.env.STALWART_FOLLOW_ADVERTISED_URLS === "1",
};

export type Config = typeof config;

/**
 * The address this installation's agent is known by (ADR 0009).
 *
 * An administrator names it in the product, and the name lives in the policy
 * document beside the settings policy: durable with it, applied without a
 * restart, and read by the worker too. `GILBERT_AGENT_ADDRESS` is what it
 * falls back to — the deployment's own fact — so an installation that has
 * named nothing behaves exactly as it did before there was a field.
 */

/**
 * Where that address comes from: the installation\u2019s own record, or the
 * deployment. The surface says which, because "the product does not know" and
 * "the deployment does not know" are fixed in different places.
 */
export function agentAddressSource(): "policy" | "deployment" | "none" {
  if (config.settingsPolicy.agent?.address) return "policy";
  return config.agent.address.trim() ? "deployment" : "none";
}

/**
 * The areas one group is narrowed to, or null when the deployment speaks for
 * it.
 *
 * Narrowing only: the worker intersects this with the areas the deployment
 * serves, so a document can never widen what an operator allowed, and a name
 * this build does not know is dropped rather than obeyed (ADR 0009).
 */
export function agentGroupAreas(group: string): AgentArea[] | null {
  const configured =
    config.settingsPolicy.agent?.groups?.[group.trim().toLowerCase()]?.areas;
  if (!configured?.length) return null;
  return AGENT_AREAS.filter((area) => configured.includes(area));
}

export function agentAddress(): string {
  return (config.settingsPolicy.agent?.address ?? config.agent.address)
    .trim()
    .toLowerCase();
}

/**
 * Whether the deployment holds the secret that address signs in with.
 *
 * The web tier never needs one — it acts as the agent by impersonation from an
 * administrator's own session — but the worker signs in as the agent itself,
 * and an address the deployment holds no password for is an agent that can be
 * read in the product and can do nothing on its own. That is worth saying out
 * loud on the surface that names it.
 */
export function agentHasSecret(): boolean {
  const address = agentAddress();
  if (!address || !config.agent.password) return false;
  return config.agent.address.trim().toLowerCase() === address;
}
