# ADR 0008 — System Sieve scripts

Status: Accepted

Implementation: Built. `server/src/adminSieve.ts`, behind `requireAdmin` on every
route (`server/src/app.ts`), sharing its editor component with the personal
scripts tab rather than duplicating one.

The administration gains **System Sieve**, an editor for the Sieve scripts
Stalwart itself runs — the trusted, server-wide filters an operator writes for
the whole installation (spam stages, MTA hooks, routing), as opposed to the
per-account script a person or the agent already manages under Settings →
Filters & rules (`web/src/views/settings/FiltersSettings.tsx`). Both are
Sieve; they are not the same object, and Stalwart keeps them in two different
places for it.

A system script belongs to **gilbertstalwart** by the block's own definition
in `README.md`: "the server's own configuration and system scripts, written
through its management API." What that door is changed with 0.16 — the old
REST management API was replaced by JMAP registry objects
(`README.md`, "Requires Stalwart 0.16 or newer") — and a system Sieve script
is one such object.

## The object and the write door

Stalwart 0.16.21 (the release this product validates against) holds a system
script as `SieveSystemScript { name, description, isActive, contents }`
(`crates/registry/src/schema/structs.rs`), reachable over JMAP as
`x:SieveSystemScript/get` and `/set` — the same `x:{Object}/{method}` shape
Gilbert already speaks for `x:AppPassword`, `x:AccountPassword` and
`x:AccountSettings` (`server/src/account.ts`, `server/src/upstream.ts`). This
is not a new integration mechanism, only a new object type on the door the
product already opens; `STALWART_CAP` (`server/src/jmap.ts`) stays the
capability that gates it. Stalwart also exposes `/query`
(`SysSieveSystemScriptQuery`); this decision does not call it — `/get` with
`ids: null` already lists every script, the way `x:AppPassword/get` already
does for a person's own app passwords.

A system script is not scoped to any account, so writing one needs no
impersonation (ADR 0001): the call runs as the signed-in administrator's own
session, through a bespoke route (`server/src/adminSieve.ts`, wired in
`server/src/app.ts`'s "System Sieve scripts" section) rather than the client
calling JMAP directly — the shape every other admin write in this product
already takes (identities, policy, forced passwords), so `requireAdmin` gates
the route itself and not only whether the section is shown. `accountId(ctx)`
(exported from `server/src/account.ts`) is threaded through because JMAP
requires one on every call; Stalwart ignores it for an object type that is
not account-filtered. More than one system script can be active at
once — Stalwart keeps them in a name-keyed map and refuses two active scripts
sharing a case-insensitive name (`crates/common/src/config/mailstore/scripts.rs`)
— because each is invoked individually, by name, from wherever Stalwart's own
pipeline configuration references it. That wiring — which stage calls which
script — is Stalwart's own configuration and stays out of this surface, the
same boundary `gilbert-stalwart`'s working rules already draw around
server-side administration: this editor manages a script's name, description,
contents and active flag, nothing about when it runs.

## Authorization

`requireAdmin` (ADR 0001) decides whether the section is shown, as for every
admin surface. The write itself is authorized by Stalwart on the
administrator's own permissions: five dedicated permissions,
`sysSieveSystemScriptGet` / `Create` / `Update` / `Destroy` / `Query`
(`SysSieveSystemScript*` in `crates/registry/src/schema/enums.rs`), one per
verb, in the same shape as every other `Sys*` registry permission. Nothing
bundles them into `GILBERT_ADMIN_PERMISSION`'s marker automatically — an
administrator can hold Gilbert's own admin marker without holding these, the
same way ADR 0001 already notes for `impersonate` — so a 403 here means the
missing grant is this one, not a generic "not an admin," and the surface
names it rather than showing a bare failure.

## Validation

`x:SieveSystemScript/set` compiles the script against Stalwart's trusted
runtime before accepting it (`validate_sieve_script(..., is_system: true)` in
`crates/jmap/src/registry/set.rs`) and answers a bad script with a structured
`SetError` rather than storing it. Unlike a personal script, there is no
separate `SieveScript/validate`-shaped preflight for a system one: the admin
surface reads the compile error straight off the save's own refusal
(`saveSystemSieveScript` in `server/src/adminSieve.ts` turns the `SetError`
into the message `SystemSieve.tsx` shows). No Sieve compiler is written or
bundled on the client for either surface.

## Concurrency

Every read hands back `x:SieveSystemScript`'s own `state`, and every write
built on one — an update, an activate/deactivate, a delete — sends it back as
`ifInState`, the same compare-and-set guard `FileNode/set` already relies on
for the agent's writes (ADR 0003, "Coordination: claims and fencing"; `gilbert-stalwart` working rule 6). A
write whose `state` has moved since it was read is refused (409, `conflict`)
rather than applied over whatever changed it — a plain "Save" from an editor
left open cannot silently undo an activation flipped from the list in the
meantime, and a stale list-level toggle or delete cannot either. The list
surface reloads after every activate/deactivate/delete attempt, whether it
succeeded or was refused, so its own `state` is current for the next one. The
state is a single token for the whole `SieveSystemScript` type, not one per
script — the same "whole-account state" shape ADR 0003 already notes for
`FileNode` — so any write to any system script advances it.

## The editor

CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
`@codemirror/language`; MIT) plus `@codemirror/legacy-modes` (MIT) for its
`mode/sieve` grammar — `import { sieve } from
"@codemirror/legacy-modes/mode/sieve"`, wrapped with `StreamLanguage.define`.
That grammar is the same MIT-licensed tokenizer CodeMirror 5 has shipped for
years as `mode/sieve/sieve.js` (the mode Roundcube's managesieve plugin made
familiar), ported by the CodeMirror project itself into its `legacy-modes`
package rather than written fresh here — one grammar, maintained upstream, not
a second one of Gilbert's own. Both packages are ordinary npm dependencies the
Vite build bundles into the client; nothing is fetched from a CDN or reached at
runtime, so the editor works exactly as it does today under `IMMUTABLE=1` and
the product's strict CSP.

One component, `web/src/ui/SieveEditor.tsx` (new), is the only place that
imports CodeMirror. It replaces the plain `<textarea className="code">`
`ScriptsEditor` uses today for a person's own "Scripts (advanced)" tab
(`FiltersSettings.tsx`) and backs the new admin surface — one Sieve-editing
widget syntax-highlighting both a person's script and a system one, never two.

## The admin surface

A new section, **System Sieve** (`web/src/views/admin/SystemSieve.tsx`),
under the admin navigation's existing **Stalwart** group
(`web/src/views/AdminView.tsx`), beside **Enforce Identities** (ADR 0007).
The client reaches it through `web/src/lib/adminSieve.ts`, one function per
route on `/api/admin/sieve/system*` — the same shape `web/src/lib/agents.ts`
already gives the agent admin surfaces, not a direct JMAP call from the
browser. It lists every system script by name, description and active state
(without contents, kept out of the list answer), opens one in `SieveEditor`
with its contents fetched separately, and offers the same verbs
`ScriptsEditor` already gives a person for their own script — create, edit,
save, activate, deactivate, delete — with two differences: activating a
system script does not deactivate another, and there is no separate
"Validate" step, since Stalwart's own compile check runs on save itself
(there is no system-script equivalent of `SieveScript/validate`).

## Consequences

- No new storage anywhere: Stalwart's own registry holds the only copy of a
  system script — nothing in an account's Files, nothing in `settings.json`,
  nothing on Gilbert's own process — consistent with "everything durable
  lives in Stalwart" and `IMMUTABLE=1`.
- A second `Sys*` permission family now matters to admin surfaces alongside
  `impersonate`: an administrator can hold Gilbert's own admin marker and
  still lack `sysSieveSystemScript*`, and the surface must say which grant is
  missing rather than report a bare 403.
- `SieveEditor` being shared means a change to how Sieve is edited —
  highlighting, how a save error is shown, the keymap — is made once and both
  the personal and the admin surface carry it; a regression there reaches
  both.
- `server/src/mock/index.ts` carries `x:SieveSystemScript/get` and `/set`
  handlers for mock parity (`gilbert-stalwart`), `ifInState` included; the
  mock does not model Stalwart's own `sysSieveSystemScript*` permission
  split, only `requireAdmin` — a brace-balance check stands in for a real
  Sieve compile, enough to exercise "a bad script is refused, not stored"
  without a Sieve compiler in the mock.
- A stale write costs a round trip an unguarded one would not: the caller
  reloads and tries again rather than the surface silently choosing whose
  edit wins.

## Verified against Stalwart

Read at release tag `v0.16.21` (`github.com/stalwartlabs/stalwart`, the
version `README.md` validates against): `SieveSystemScript` and its five
`SysSieveSystemScript*` permissions exist in
`crates/registry/src/schema/{structs,enums}.rs`; the `x:SieveSystemScript/set`
path compiles the script through `validate_sieve_script(..., true)` in
`crates/jmap/src/registry/set.rs`; the `x:{Object}/{method}` method-name shape
is generic (`crates/jmap-proto/src/request/method.rs`); the active-script
name-collision refusal and per-script compile are read from
`crates/common/src/config/mailstore/scripts.rs`. Not yet checked live against
a running 0.16.21 instance — an implementation of this decision owes that
probe, the way ADR 0003's live checks are recorded.

## References

- `server/src/adminSieve.ts` — the five operations, over `JmapClient` as the
  administrator's own session
- `server/src/app.ts` — the "System Sieve scripts" route section
  (`requireAdmin`), `accountCtx`
- `server/src/account.ts` — `accountId(ctx)`, exported for this module; the
  existing `x:AppPassword`/`x:AccountPassword` call pattern this one repeats
- `server/src/jmap.ts` — `STALWART_CAP`, `JmapClient`
- `server/src/mock/index.ts` — the `x:SieveSystemScript` handlers
- `server/src/admin-sieve.test.ts`, `server/src/admin-sieve-nonadmin.test.ts`
  — the CRUD flow, the two refusals, the `requireAdmin` gate
- `web/src/lib/adminSieve.ts` — one function per route, the shape
  `web/src/lib/agents.ts` already gives the agent admin surfaces
- `web/src/views/admin/SystemSieve.tsx` — the admin surface
- `web/src/ui/SieveEditor.tsx` — the shared CodeMirror component
- `web/src/views/settings/FiltersSettings.tsx` — `ScriptsEditor`, the personal
  script editor `SieveEditor` also backs
- `web/src/store/sieve.ts` — the existing per-account Sieve store
  (`GILBERT_SCRIPT`), for contrast: a blob-backed JMAP object, not a registry
  one
- `web/src/views/AdminView.tsx` — the **Stalwart** admin nav group
- `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
  `@codemirror/language`, `@codemirror/legacy-modes`, `@lezer/highlight`
  (npm, MIT)
- ADR 0001 — `requireAdmin`, impersonation, a permission grantable apart from
  the admin marker
- ADR 0007 — the **Stalwart** admin nav group, a form shared between a
  person's own settings and the admin surface
