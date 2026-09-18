/**
 * The shapes the System Sieve routes answer with, and the body a write carries.
 *
 * One definition for the two tiers that meet here: the routes under
 * `/api/admin/sieve/system` build these answers and read that body, the
 * administrator's surface sends and reads them. Declared twice, a field added
 * on one side and forgotten on the other compiles on both and arrives as
 * `undefined` on one; declared twice with two different names for one field, it
 * costs a translation — which is how `state` and `ifInState` came to be
 * hand-mapped in the route.
 *
 * So the wire names its own fields, once: the body carries `state`, as the
 * client reads it back from every read, and the module that speaks to Stalwart
 * translates it to `ifInState` where that vocabulary is already at home.
 *
 * Type declarations only: no runtime code reaches a bundle through this file.
 */

/** One system script as a list shows it, without its contents. */
export interface SystemSieveScript {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

/** Every system script, and the state the list was read at. */
export interface SystemSieveScriptList {
  scripts: SystemSieveScript[];
  state: string;
}

/** One system script with its contents, and the state the read was made at. */
export interface SystemSieveScriptContent extends SystemSieveScript {
  contents: string;
  state: string;
}

/**
 * The body of a write: a create (`POST /api/admin/sieve/system`) or an update
 * (`PUT /api/admin/sieve/system/:id`).
 *
 * Every read hands back the type's own `state`, and an update built on one
 * sends it back, so the server can pass it to Stalwart as `ifInState` — a save
 * built on a since-changed read is refused (409) rather than silently
 * overwriting whatever changed it. A create has no baseline to lose, so it
 * carries none, and a `state` a create happens to send is ignored rather than
 * refused.
 */
export interface SystemSieveScriptWrite {
  name: string;
  description: string | null;
  contents: string;
  activate: boolean;
  /** The `state` this edit was opened with; omitted for a new script. */
  state?: string;
}
