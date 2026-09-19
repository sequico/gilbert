import pathlib

# --- 1. a catalogue that came back empty is "not readable", not "empty" ---
p = pathlib.Path("web/src/lib/agents.ts")
s = p.read_text()
old = '''/** The grant a schema publishes, in the order the catalogue declares it. */
export interface AgentGrantCatalog {
  areas: AgentAreaCatalogEntry[];
  /** In catalogue order, which is also the order a grant is written in. */
  standalone: AgentStandaloneCatalogEntry[];
  /** Every action name the catalogue has, in catalogue order. */
  order: string[];
}'''
new = '''/** The grant a schema publishes, in the order the catalogue declares it. */
export interface AgentGrantCatalog {
  areas: AgentAreaCatalogEntry[];
  /** In catalogue order, which is also the order a grant is written in. */
  standalone: AgentStandaloneCatalogEntry[];
  /** Every action name the catalogue has, in catalogue order. */
  order: string[];
}

/**
 * Whether a catalogue is one a form can be written from.
 *
 * A schema with no areas and no actions is not a catalogue of nothing: it is a
 * schema this build cannot read — an older server, or one whose answer arrived
 * before the routes did. The two must not render the same, because an empty
 * grant section offers nothing to tick, so a save is refused for a reason the
 * person cannot see and the form looks broken rather than incomplete.
 */
export function grantIsReadable(grant: AgentGrantCatalog | null): boolean {
  return grant !== null && grant.areas.length > 0 && grant.order.length > 0;
}'''
if old not in s:
    raise SystemExit("MISS grant type")
s = s.replace(old, new)
p.write_text(s)
print("agents ok")

# --- 2. the form says so instead of drawing nothing ---
p = pathlib.Path("web/src/views/admin/agent/RuleForm.tsx")
s = p.read_text()
old = '''      {grant === null ? (
        <p className="hint">{t("The capability catalogue has not been read yet.")}</p>
      ) : ('''
new = '''      {!grantIsReadable(grant) ? (
        <p className="hint">
          {t(
            "The capability catalogue has not been read, so there is nothing to grant here: a server that cannot answer with it is one this build cannot author against. Saving stays refused until it does.",
          )}
        </p>
      ) : ('''
if old not in s:
    raise SystemExit("MISS form guard")
s = s.replace(old, new)

s = s.replace('''import { type AgentGrantCatalog, readDraft } from "@/lib/agents";''',
              '''import { type AgentGrantCatalog, grantIsReadable, readDraft } from "@/lib/agents";''')
p.write_text(s)
print("RuleForm ok")
