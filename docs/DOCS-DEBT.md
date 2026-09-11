# Documentation debt

Work this change owes to the documentation, written down instead of carried in a
conversation. Each entry says what is missing, where it belongs, and what makes
it true. An entry that needs a decision says so; the others are owed writing.

## 1. `docs/adr/0007-admin-set-identities.md` — the default sending identity

The default is not a Stalwart property. It is one key of the client's own
settings document, `settings.json`, in the account's app folder, keyed by
account id — the key the account's own Identities & signatures section reads and
sends from. The administration surface reads it and writes it there, by
impersonating the account, at `POST /api/admin/identities/user/default`; `null`
clears the entry, which is the same state as never having chosen.

ADR 0007 needs the paragraph, and it needs the residual risk stated with it: the
write is a read-modify-write of a document the client also writes wholesale, so
a client save landing between the read and the write loses the administration's
write. Nothing else can, because the key belongs to the client's schema and the
client re-serialises it.

## 2. `FEATURES.md` — the default identity in the admin surface

The inventory needs the bullet: the admin Identities surface shows and sets the
account's default sending identity, and it is one stored value shared with that
account's own Identities & signatures section, not a second copy.

## 3. Tests the mechanism owes

Project law: a mechanism an ADR names has at least one test that fails when the
mechanism is removed. Owed:

- `readDefaultIdentity` / `writeDefaultIdentity` (`server/src/identityAdmin.ts`):
  a missing document, a malformed one, setting a value, clearing it with `null`,
  and two accounts held in one document to pin that the key is per-account.
- The route `POST /admin/identities/user/default`, including a refusal mapped to
  `impersonation_denied`.
- `server/src/mock/index.ts` must serve reading and writing `settings.json` in an
  app folder before those tests can run. A mock that stands in for a server
  behaviour pins that assumption with a test next to the simulation.

## 4. App-folder convergence — a one-time adoption, owner decision

The client and the server now resolve an account's app folder by one rule: a
marked folder, `gilbert` preferred and `.gilbert` as the alternative, marked with
`.gilbert-app`. Accounts that were already split hold their documents in a bare
`gilbert` folder without the marker, and the client now converges on the marked
one, so those documents are orphaned and the settings can read as reset.

Owed is a one-time adoption — adopt and mark a bare `gilbert`, or move its
documents into the marked folder — and which of the two is the owner's decision.

## 5. The ADR set

The owner has asked for the set to be fewer, shorter and free of stale text:
merge the ADRs that restate one decision, renumber sequentially reusing the
gaps, and align `docs/adr/README.md`. The set is `0001`–`0010`.

## 6. The `(resolution N)` sweep

Roughly 77 occurrences across the ADRs cite the round that argued a resolution.
Snapshot mode forbids that reference: the resolution numbers, the dates, the
`Owed:` markers and every fact stay; the back-reference to the round goes.

## 7. A stale sentence whose location is unknown

"No restart of `gilbertserver` is needed to apply a change to the installation's
agent." The sentence was searched for and not found: `gilbertserver` occurs
nowhere in the repository, and the sentence occurs in neither `docs/`, `README.md`
nor `FEATURES.md`. The owner needs to say where it was read, or the search needs
the exact wording.

## 8. Obsolete configuration JSON

Configuration JSON files that nothing reads any more are to be removed.
`stalwart-servers.example.json` and `settings-policy.example.json` at the
repository root are referenced by `README.md` and by tests, and stay.

## 9. i18n catalogs

The strings the admin identities surface gained — `Default`, `Make default`,
`Send from this identity by default`, `Default identity saved.`, `No default
identity: this account sends with its first.` — are English keys and resolve as
English. Whether each belongs in `web/src/locales` with its translations is owed.

## 10. The `must-change-password` precedent, read against the default

`server/src/account.ts` states that the server keeps its own directive in a
separate file inside the app folder, because the client whole-file-replaces
`settings.json` on save. That reasoning holds for a key the client's schema does
not own, and does not hold for `defaultIdentityByAccount`, which the client owns
and re-serialises. One sentence where the precedent is stated keeps the two rules
from reading as contradictory.
