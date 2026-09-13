# ADR 0008 — System Sieve scripts

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
`x:SieveSystemScript/get`, `/set` and `/query` — the same `x:{Object}/{method}`
shape Gilbert already speaks for `x:AppPassword`, `x:AccountPassword` and
`x:AccountSettings` (`server/src/account.ts`, `server/src/upstream.ts`). This
is not a new integration mechanism, only a new object type on the door the
product already opens; `STALWART_CAP` (`server/src/jmap.ts`) stays the
capability that gates it.

A system script is not scoped to any account, so writing one needs no
impersonation (ADR 0001): the call runs directly as the signed-in
administrator's own session. More than one system script can be active at
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
`SetError` rather than storing it. The admin surface reads that error exactly
as `ScriptsEditor`'s `sieve.validate` already reads a personal script's
compile error — no Sieve compiler is written or bundled on the client for
either surface.

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

A new section, **System Sieve**, under the admin navigation's existing
**Stalwart** group (`web/src/views/AdminView.tsx`), beside **Enforce
Identities** (ADR 0007) — the same group, the same precedent for a
Stalwart-record surface reading and writing JMAP straight from the client
through the existing `/api/jmap` proxy rather than a bespoke server route
(`AdminUsers.tsx` already does this for `Principal/query` and `Principal/get`).
It lists every system script by name and active state
(`x:SieveSystemScript/query` + `/get`), opens one in `SieveEditor`, and offers
the same verbs `ScriptsEditor` already gives a person for their own script —
create, edit, validate, save, activate, deactivate, delete — with the one
difference that activating a system script does not deactivate another.

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
  highlighting, how a validation error is shown, the keymap — is made once
  and both the personal and the admin surface carry it; a regression there
  reaches both.
- `server/src/mock/index.ts` carries no `x:SieveSystemScript` handlers yet: an
  implementation of this decision owes the mock the same parity every JMAP
  behaviour Gilbert depends on already requires (`gilbert-stalwart`).

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

- `web/src/views/settings/FiltersSettings.tsx` — `ScriptsEditor`, the personal
  script editor this reuses `SieveEditor` from
- `web/src/store/sieve.ts` — the existing per-account Sieve store
  (`GILBERT_SCRIPT`)
- `web/src/views/AdminView.tsx` — the **Stalwart** admin nav group
- `web/src/views/admin/AdminUsers.tsx` — precedent for an admin surface
  speaking JMAP directly through `/api/jmap`
- `server/src/account.ts`, `server/src/upstream.ts` — the existing `x:`
  registry call pattern
- `server/src/jmap.ts` — `STALWART_CAP`
- `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
  `@codemirror/language`, `@codemirror/legacy-modes` (npm, MIT)
- ADR 0001 — `requireAdmin`, impersonation, a permission grantable apart from
  the admin marker
- ADR 0007 — the **Stalwart** admin nav group, a form shared between a
  person's own settings and the admin surface
