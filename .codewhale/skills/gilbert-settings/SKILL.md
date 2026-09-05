---
name: gilbert-settings
description: Conventions for anything that touches the per-account settings system or the installation settings policy in Gilbert: account-synced vs device-local keys, the enforcement door in the settings store, reset/import/hydrate semantics, and the admin policy powers (defaults/enforced/changes). Load before adding a preference, changing how settings are stored or synced, or editing the settings policy.
metadata:
  short-description: Settings & policy conventions
---

# Gilbert — the settings system and the admin policy

## Invariants (why this system is shaped the way it is)

- **Settings follow the account, not the browser or the device.** The durable
  copy is a `settings.json` node in the account's own JMAP Files on Stalwart
  (`web/src/lib/settingsSync.ts`, `const FILE = "settings.json"`), next to the
  signature images. localStorage is only the first-frame cache (`PAINTED_FROM_CACHE`).
- **Enforcement is one door, not many locks.** Everything — a toggle, an
  import, a keyboard shortcut, a future control — lands in `update()` in
  `web/src/store/settings.ts`, which re-applies `...policyEnforced()` over the
  patch. Never write a setting by another path (a direct `saveJson`) or you
  open the hole that door exists to close.
- The settings module is authoritative for what a "setting" is: `Settings`
  interface + `DEFAULT_SETTINGS` in `web/src/store/settings.ts`.

## Adding a new setting

1. Add the field to the `Settings` interface and a sane default to
   `DEFAULT_SETTINGS`. Keys this build does not know are dropped by the
   policy loader (`known()` in `web/src/lib/settingsPolicy.ts`) and by
   remote files (`acceptRemote` in the store), so this list *is* the schema.
2. Decide account vs device. **New keys sync by default** — `DEVICE_KEYS` is
   the explicit opt-out list, written as exceptions. Add to it only for what
   is genuinely about this screen or this browser (pane widths/heights,
   notification permission toggles, density, font size, sidebar collapse).
   A wrong choice here silently claims something untrue on other devices.
3. Keep old settings files readable: they are opened by whatever version runs
   next. Follow the `theme` → `palette`/`mode` migration precedent in
   `acceptRemote` when a field's meaning changes; never break an old file.
4. Wire the control in `web/src/views/settings/<Section>Settings.tsx`. If the
   installation must be able to lock it visibly, use `isEnforced("key")` from
   `@/lib/settingsPolicy` and pass `locked`/`disabled` to the control (see the
   `Switch` in `web/src/ui/misc.tsx`: locked shows *"Set for everyone here.
   You cannot change this."*). A key enforced but not wired still *holds* at
   the store door, but the control is not visibly dead — wire it if the
   setting is one an admin would sensibly lock.

## Semantics you must not flatten

- `reset()` = `DEFAULT_SETTINGS + policyDefaults + policyEnforced` — "back to
  how this installation starts an account", deliberately not a way around a
  policy.
- `hydrate(remote)` (the account's file arrived) re-applies `enforced` on top,
  so an older sign-in that wrote past the policy is corrected on next load.
- `importJson` goes through `update()` **unfiltered** — unlike the policy
  loader and the remote file read, an import trusts its input (a parse error
  returns false). An unknown key it introduces is dropped when other devices
  read the file back (`acceptRemote`), but this browser keeps it cached and
  re-pushes it until the file is rewritten; a device key it sets does change
  this browser.
- `appliedPolicyChanges: string[]` is the account's record of which policy
  `changes` it has had; it syncs like any other key. Never set it from a
  policy, never use it for anything else.
- `syncedPart`/`mergeRemote` (with `pendingSettingsKeys`) decide what is
  pushed and what wins while a push is in flight — a queued change is newer
  than the file by definition.

## The admin policy (three powers, one file)

- The installation decides via `SETTINGS_POLICY_FILE` (JSON, read once at
  boot — editing means restarting) or the `SETTINGS_DEFAULTS` /
  `SETTINGS_ENFORCED` / `SETTINGS_CHANGES` envs (for read-only installs).
  Read in `server/src/config.ts` (`readSettingsPolicy`), served on the
  unauthenticated `/api/config`, fetched once by `web/src/lib/settingsPolicy.ts`.
  Validation is strict and **fatal at boot**: malformed JSON or duplicate /
  missing `version`s refuse to start — a policy that silently did not apply
  is the failure mode being prevented.
- `defaults`: seed an account that never had settings of its own; changeable
  afterwards. `enforced`: re-applied every load, unchangeable. `changes`:
  applied once per account (reaching people who already exist), changeable
  back afterwards, remembered by `version` in `appliedPolicyChanges`.
- Only keys of `DEFAULT_SETTINGS` are accepted (client `known()` filter);
  **values are not type-checked** anywhere — copy values from a real Settings
  export (Settings > General > Export) rather than typing them from memory.
- Sequence at sign-in (`web/src/App.tsx`): load policy → load remote settings →
  `hydrate` or `seedFromPolicy` → `applyPolicyChanges` → toast
  "Your administrator changed {n} setting(s)" via `plural()`, with a link to
  Settings. Keep that ordering if you touch the boot path.
- Not every Settings page is policy material: filters, vacation, identities,
  2FA and folder/label structure live server-side (JMAP objects), not in the
  settings file.

## Testing and local dev

- Server: `server/src/settingspolicy.test.ts` and config tests. Web:
  `web/src/store/__tests__/settings-policy.test.ts`, settings store tests,
  `web/src/lib/__tests__/` (brand/config neighbours). Run the narrow test
  first: `npm test -w web` / `npm test -w server`, `TZ=UTC` when not on UTC.
- Try a policy locally:
  `SETTINGS_POLICY_FILE=/path/policy.json npm run dev:mock` (env propagates to
  the server child; policy read at boot). `http://127.0.0.1:8080/api/config`
  shows it. The demo account's state lives in the mock's memory: restarting
  `dev:mock` clears the settings file, so `changes` fire again from scratch.
