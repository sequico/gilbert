# ADR 0011 — The installation policy lives in every account it touches

Status: Accepted (2026-09-13)

> **Owner direction (2026-09-13):** everything Gilbert owns must live inside
> Stalwart, so the container can run `IMMUTABLE=1` for this surface too —
> including the settings policy and the identity lock, which today do not.
> Rather than one shared installation account, each person's own policy is
> written inside their own account, the way an administrator already writes a
> person's default identity into their own settings document.

## Context

**The settings policy (`defaults`, `enforced`, `changes`) and the identity
lock lived on local disk or in the environment, not in Stalwart.** A business
logic review (2026-09-12/13) found that `POST /admin/policy` and "Enforce"
in **User identities** both updated only the running process's in-memory copy
of `config.settingsPolicy`, persisting it to `SETTINGS_POLICY_FILE` when one
was configured — which most deployments do not do, since `.env.example` ships
it commented out and neither `docker-compose.yml` nor `deploy.example.sh`
mounts one. An administrator who clicked "Enforced — applied at once, with no
sign-in needed" got exactly that promise for the life of the running
container, and nothing durable: the next redeploy, restart, or second replica
read `SETTINGS_POLICY_FILE`/the environment again and the change was gone,
with no warning anywhere that this would happen.

This is the one piece of Gilbert's own state that broke the promise the rest
of the product keeps: "nothing of its own to keep — no database, no search
index, no cache tier: every durable thing lives in the mail store... the
container is disposable" (`README.md`). Agent rules, the audit trail, group
labels, a person's own settings — all of it is a document in Stalwart. The
policy and the lock were the exception, and a silent one.

**Stalwart has no generic settings store for a third party to write into.**
Checked directly against Stalwart's own API surface (its OpenAPI spec and the
0.16 configuration registry): the registry introduced in 0.16 is a
schema-driven store of *Stalwart's own* typed configuration objects — Account,
Domain, SMTP, SpamSettings and the like, each with its own schema — reached
through JMAP-shaped `get`/`set` calls the way `x:AccountPassword/set` and
`x:AppPassword/set` already are elsewhere in this product. It is not an
extension point: there is no object type in it for a client application's own
arbitrary JSON, and repurposing one of Stalwart's own typed objects to carry
Gilbert's policy would be exactly the kind of thing ADR 0008 names as "a new
decision, not a precedent \[the system-sieve exception\] sets by accident."
The one door this product already uses outside JMAP (ADR 0008) is one object
wide, by its own design, and settings are not that object.

**FileNode is the door that is actually open, and this product already writes
through it into an account that is not the writer's own.** An administrator
setting a person's default identity does not invent a second store for it:
`setPersonDefaultIdentity` (`server/src/identityAdmin.ts`) impersonates the
person and writes `defaultIdentityByAccount` into *their* `settings.json`, in
their own app folder — the same document their own Identities & signatures
section reads. The identity lock and the settings policy fit the same shape:
both are facts about one account (is this one locked; what does this one
currently follow), read by that account's own session at the moments it
already reads its own settings.

**A key of `settings.json` is not where either fact goes, though — a second
file in the same app folder is.** `settings.json` is the *client's* document:
`web/src/lib/settingsSync.ts` reads it once, holds it as the `Settings`
object the UI edits, and on every change serialises that whole object back,
key for key, from its own schema. `defaultIdentityByAccount` survives this
because the client's own schema owns that key and re-writes it on every save;
a key the client's schema does not know about does not, because there is
nothing to re-write it. This is not new to this ADR — it is exactly why
`must-change-password.json` (ADR 0004) is its own file next to
`settings.json` rather than a key inside it, spelled out in
`server/src/account.ts`. The identity lock and the installation policy are
both facts the client's own schema has no reason to know about, so they take
the same shape: `identity-lock.json` and `installation-policy.json`, each its
own file, in the same app folder, read and written only by the server.

**A shared "installation account" was the alternative, and was not chosen.**
The obvious alternative — one document in one designated account, the way the
agent fleet keeps its rules and audit in the Master's own account — was
rejected because it makes the settings-policy and identity-lock features
depend on an agent identity being configured, which they do not today and
have no other reason to. It also reintroduces a single point every reader
would have to reach cross-account to check, which is exactly the shape of
problem this ADR is closing.

## Decision

1. **The identity lock is a fact about one account, stored in that account's
   own app folder.** `identity-lock.json` — present means locked, missing
   means not, the same shape as `must-change-password.json`. Setting or
   releasing it (`POST /admin/identities/user/lock`) impersonates the account
   and writes or removes that file, the same door `setPersonDefaultIdentity`
   already uses. A session's own `gilbert.identityLocked` (embedded at
   sign-in) is read from the signed-in account's own file — no impersonation
   needed to read your own account.
2. **The published policy (`defaults`, `enforced`, `changes`) is written into
   every individual account the directory lists, at publish time.** `POST
   /admin/policy` enumerates Stalwart's directory of individual principals
   (`fetchDirectoryUsers`, already used for **User identities**' own account
   picker) and writes `installation-policy.json` into each one's app folder by
   impersonation, the administrator's own account included. One account's
   refusal (no impersonation grant, an unreachable session, no Files account)
   does not stop the rest — the response names how many accounts were reached
   and which were not, the way a lost reconcile in the agent fleet names the
   account it could not finish rather than failing every account behind it.
3. **A reader's own policy is read from their own account.** `GET
   /api/account/policy` (authenticated, replacing the policy fields of the
   public, unauthenticated `GET /api/config`) answers with the signed-in
   account's own `installation-policy.json`. `GET /admin/policy` — the
   editor's own display — reads the same file from the signed-in
   *administrator's* account, which the last publish already wrote: every
   publish includes every admin, so the editor's next load shows exactly what
   it just saved, on any admin's session, without a second store to keep in
   step with the first.
4. **An account the directory did not yet list when the policy was last
   published reads no policy until the next publish reaches it, or until the
   environment's own bootstrap does.** `SETTINGS_DEFAULTS`, `SETTINGS_ENFORCED`
   and `SETTINGS_CHANGES` (inline environment variables, read once at boot,
   exactly as today) become the *bootstrap* an account falls back to when its
   own app folder carries no `installation-policy.json` yet — which is also
   what every account reads before any administrator has ever published
   anything through the live editor. `SETTINGS_POLICY_FILE` is removed: it
   was the mechanism this ADR replaces, and keeping it as a second path back
   to the same two fields would be the two-copies problem this document
   exists to close.

## Consequences

- **Every durable thing Gilbert owns is now a document in Stalwart, and this
  surface can run under `IMMUTABLE=1` like the rest of the product.** Nothing
  written by this feature touches local disk.
- **Publishing a policy costs one impersonated write per individual account
  in the directory**, not one file write. For an installation with many
  accounts this is the most expensive administrative action in the product;
  it is also one of the rarest, and it is done once per change rather than
  once per reader per change.
- **An account created after the last publish, and never itself published
  to since, runs on the environment's bootstrap policy until the next
  publish reaches it or an administrator republishes with no change to pick
  it up.** This is a narrower gap than the one it replaces — every account
  eventually already existed before *some* publish, and the deploy-time
  bootstrap covers the interval before the first one — but it is not zero,
  and is named here rather than left to be found again.
- **`GET /api/config` no longer carries `settingsPolicy`.** It was already
  read only from the authenticated bootstrap path (`App.tsx`, after
  `accountId` is known), never by the sign-in screen itself, so moving it
  behind `GET /api/account/policy` changes no caller's behaviour, only which
  door it knocks on.
- **A second admin session's own account is where its own editor reads
  from**, not a third one shared between them. Two administrators who publish
  in quick succession do not race a shared document — each publish is a
  fan-out of the whole directory, and the one that lands last is the one
  every account (including every other administrator's) ends up holding.
