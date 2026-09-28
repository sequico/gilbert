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
- `knownSigners` (S/MIME signer pins, keyed by lowercased address, see
  `SignerPin` in the settings module) syncs **by design**: a pin known to one
  device only would greet the same correspondent as new on every other, which
  trains people to click past the warning it exists to raise. It is the whole
  trust model of signature checking (trust on first use, no CA), so it is
  account data like any other synced key — never a `DEVICE_KEYS` entry, and
  never touched by policy.

## The admin policy (three powers, per account — ADR 0001)

- The live document is not a file or a variable: `POST /admin/policy`
  (Admin > Installation policy) writes `installation-policy.json` into every
  individual account's own app folder, by impersonation (`fetchDirectoryUsers`
  + `impersonateAs`, `server/src/app.ts`) — the publishing administrator's
  account included — conditionally on that account's own file state
  (`ifInState`, read after its app folder exists). `GET /admin/policy` and the
  authenticated `GET /api/account/policy` each read from the signed-in
  account's own file (`readAccountPolicy`, `server/src/adminPolicy.ts`), fetched
  once by `web/src/lib/settingsPolicy.ts`.
- **A publish is a job with an id (ADR 0010).** One id is minted before the
  first copy goes out, every copy carries it beside the policy as
  `published: { id, at }` (`PolicyPublished`), and the job itself is one
  document — `gilbert/publish-job.json`, in the publishing administrator's own
  app folder (`PublishJob`, `PUBLISH_JOB_FILE`, `readPublishJob`) — holding the
  population the directory reported (`read`/`complete`/`total`), the accounts
  the copy reached, the ones it did not with a code each
  (`impersonation-refused`, `no-files-account`, `write-failed`, `policy-moved`,
  `directory-denied`), and whether the installation can be said to carry the
  policy. `GET /admin/policy` answers it beside the policy, so the editor names
  the last publish even when another instance made it, and a publish whose own
  record could not be stored answers `record: "failed"`. A publish that answered
  is not a publish that covered the installation: `complete` is true only when
  the directory's listing *was* the whole directory and every account it listed
  was reached.
- The policy is per account and only per account: there is no
  installation-wide copy behind it and no bootstrap beside it. An account no
  publish has reached carries no document, which its reader reports as the
  empty policy (`EMPTY_POLICY`, `server/src/adminPolicy.ts`) and the client
  reads as the product's own defaults.
  Validation is strict: malformed JSON or duplicate / missing `version`s are
  refused (400 at publish time) — a policy that silently did not apply is the
  failure mode being prevented.
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
- Global contacts is not a setting either: the directory is one book in the
  Master's account, created by the installation at boot (ADR 0023), so none of
  it belongs in `Settings`/`settings.json`. Load `gilbert-global-contacts`
  before reaching for a preference here.

## Testing and local dev

- Server: `server/src/settingspolicy.test.ts` and config tests. Web:
  `web/src/store/__tests__/settings-policy.test.ts`, settings store tests,
  `web/src/lib/__tests__/` (brand/config neighbours). Run the narrow test
  first: `npm test -w web` / `npm test -w server`, `TZ=UTC` when not on UTC.
- Try a policy locally: sign in as the mock's demo admin, publish one from
  Admin > Installation policy, and sign back in to see it applied. The demo accounts' state lives
  in the mock's memory: restarting `dev:mock` clears every published policy,
  so `changes` fire again from scratch.
