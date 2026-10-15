/**
 * The administration routes, minus the group, agent and identity surfaces.
 *
 * The forced-password-change directive (ADR 0001), the installation-wide
 * settings policy and its publish, and the directory reads the Users and
 * Groups surfaces stand on. Every route here is behind `requireSession` and
 * `requireAdmin` (ADR 0017).
 */

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import {
  clearPasswordChangeDirective,
  getState,
  setPasswordChangeDirective,
} from "../account.js";
import {
  EMPTY_POLICY,
  type PolicyDocument,
  parsePolicyDocumentDetailed,
  policyDocumentText,
  readAccountPolicy,
  readPublishJob,
  refusalCodeFor,
  writeAccountPolicy,
  writePublishJob,
} from "../adminPolicy.js";
import { impersonateAs } from "../agentAdmin.js";
import {
  appFolderState,
  type Ctx,
  ensureAppFolder,
  filesAccountId,
} from "../appFolder.js";
import {
  impersonationAuthorization,
  type LiveSession,
  normalizeUsername,
} from "../sessions.js";
import type { SecurityState } from "../shared/accountSecurity.js";
import type { PublishJob, PublishUnreached } from "../shared/publishJob.js";
import {
  fetchAccountIntrospection,
  fetchDirectoryGroups,
  fetchDirectoryUsers,
  fetchUpstreamSession,
  isStalwartAdmin,
  outranks,
  sessionUpstream,
  UpstreamError,
  upstreamFor,
} from "../upstream.js";
import type { Env } from "./shared.js";
import {
  accountFailure,
  directiveCache,
  forcedFlagsFor,
  readJson,
  requireAdmin,
  requireSession,
  sessions,
  upstreamFailure,
} from "./shared.js";

export function registerAdminRoutes(api: Hono<Env>): void {
  // ---------- Administration (ADR 0001, ADR 0017) ----------

  /**
   * Set or clear the forced-password-change directive for a user (ADR 0001).
   *
   * The write authenticates to Stalwart as the composite `{target}%{admin}`
   * — impersonation with the administrator's own credentials rebuilt from
   * their sealed session — and performs ordinary JMAP FileNode/blob
   * operations on the target's own `gilbert` app folder, creating it when
   * the target has no app folder yet. The acting administrator must hold
   * Stalwart's `Impersonate` permission, granted by the operator on the
   * Stalwart side; there is no second secret and no Management API.
   */
  api.post("/admin/force-password-change", requireSession, requireAdmin, async (c) => {
    const admin = c.get("session");
    const body = await readJson<{ target?: string; clear?: boolean }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const target = (body.target ?? "").trim();
    // A '%' would change who the composite `{target}%{admin}` names, and a
    // ':' can confuse the credential parse; both fail closed today, but with
    // a misleading 404, so they are refused at the boundary instead.
    if (!target || target.length > 320 || target.includes("%") || target.includes(":"))
      return c.json({ error: "bad_request" }, 400);
    const imp = await impersonateAs(admin, target);
    if (!imp.ok) {
      const error =
        imp.status === 404
          ? "target_not_found"
          : imp.status === 403
            ? "forbidden"
            : "upstream";
      return c.json({ error, message: imp.message }, imp.status);
    }
    const ctx = imp.ctx;
    // An administrator cannot force another administrator: resolve the
    // target's own admin state through the impersonated session, the same
    // way the acting admin's was resolved at sign-in (ADR 0001). This also
    // covers the acting admin themselves (master == target degrades to a
    // plain login upstream). A failure to introspect is an upstream failure
    // — the same composite credential just fetched the target's JMAP
    // session, so a refusal here is the server failing the introspection,
    // never the credential: report that rather than a misleading 401.
    try {
      const targetIntro = await fetchAccountIntrospection(
        ctx.authorization,
        upstreamFor(target),
      );
      if (isStalwartAdmin(targetIntro.permissions)) {
        return c.json(
          {
            error: "target_is_admin",
            message:
              "That account is also a Gilbert administrator; administrators cannot force one another's password.",
          },
          403,
        );
      }
      /*
       * The marker is one permission; it does not say whether the target holds
       * more than the acting administrator does. Stalwart does not re-check
       * that for every write (see `outranks`), so an account allowed to act on
       * others could reach into one carrying a richer custom role and force a
       * change on it. Refused here, on the two lists the server just resolved.
       */
      if (outranks(c.get("adminPermissions"), targetIntro.permissions)) {
        return c.json(
          {
            error: "target_outranks",
            message:
              "That account holds permissions this one does not; administrators cannot force a change on an account that outranks them.",
          },
          403,
        );
      }
    } catch (err) {
      // The target's introspection failed: an upstream failure, and its detail
      // stays in the log rather than reaching the administrator as a raw
      // internal message.
      console.error("[gilbert] could not verify the target's administrator state:", err);
      return c.json(
        {
          error: "upstream_error",
          message: "Could not verify the target's administrator state.",
        },
        502,
      );
    }
    try {
      if (body.clear === true) await clearPasswordChangeDirective(ctx);
      else {
        /*
         * A forced 2FA account would have no way out of the wall: the change
         * endpoint validates the current account password, and a 2FA account
         * can only ever present an app password (which the wall does not
         * accept and Stalwart refuses for impersonation). Refuse to force
         * such an account, reading its security state as the target through
         * the impersonated session. The real 0.16 session resource does not
         * say how a session authenticated (checked 2026-09-07; re-verify
         * live), so this guard is also what keeps app-password users from
         * being walled behind a door they cannot open.
         */
        let state: SecurityState;
        try {
          state = await getState(ctx);
        } catch {
          return c.json(
            {
              error: "bad_request",
              message:
                "Could not read the account's security state; refusing to force until it can be checked.",
            },
            400,
          );
        }
        if (state.otpEnabled)
          return c.json(
            {
              error: "account_has_two_factor",
              message:
                "This account uses two-factor authentication and cannot be forced: it has no password-only way out of the change wall.",
            },
            400,
          );
        await setPasswordChangeDirective(ctx, admin.username);
      }
    } catch (err) {
      return accountFailure(c, err);
    }
    // The door's cache must not answer from before the change.
    directiveCache.delete(normalizeUsername(target));
    return c.json({ ok: true });
  });

  /**
   * The installation-wide settings policy (ADR 0001, ADR 0001, ADR 0001).
   *
   * GET reads the signed-in administrator's own account — the last publish
   * wrote there like everywhere else, so the editor's next load shows exactly
   * what it just saved — and answers the job that publish recorded in the same
   * account, so the surface says what the last publish did even when this
   * process never made one. POST validates the document and writes it into
   * every individual account the directory lists (fetchDirectoryUsers), the
   * publishing administrator's own account included, by impersonation — there
   * is no other shared copy to swap. One account's refusal does not stop the
   * rest; the response names how many were reached and which were not. Every
   * other signed-in session is kicked so the enforcement it is already holding
   * is dropped at once rather than waiting for that account's own next load to
   * refetch it.
   */
  api.get("/admin/policy", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await sessionUpstream(session);
      const ctx = {
        authorization: session.authorization,
        session: upstream,
        username: session.username,
      };
      const accountId = filesAccountId(ctx);
      const doc =
        (accountId ? await readAccountPolicy(ctx, accountId) : null) ?? EMPTY_POLICY;
      // The last publish this account recorded, read from the account itself:
      // the answer does not depend on which instance made it, or on whether
      // this one ever did.
      const job = accountId ? await readPublishJob(ctx, accountId) : null;
      return c.json({ policy: policyDocumentText(doc), job });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  /**
   * Write the policy into every individual account the directory lists, by
   * impersonation — the administrator's own account included — and record the
   * publish as a job in the administrator's own app folder.
   *
   * What comes back is that job: the id this publish minted (the copies carry
   * it), when it started, who published, the population the directory listed,
   * whether that list was the whole directory, the accounts the policy reached
   * and the ones it did not with the reason for each. It is the same document
   * the account now holds, so the surface reads the same answer back after
   * this process is gone.
   *
   * A publish that could not read the directory, or read part of it, says so
   * here rather than letting a count of successes stand for the whole
   * installation: "eight accounts were reached" and "the installation carries
   * this policy" are different claims, and only the second is what an
   * administrator is being asked to believe.
   */
  async function publishAccountPolicy(
    admin: LiveSession,
    doc: PolicyDocument,
  ): Promise<PublishJob> {
    /*
     * One id for the whole publish, minted before the first copy goes out: the
     * copies carry it (`PolicyPublished`), so any account an administrator
     * looks into says which publish reached it, and the job recorded below
     * carries the same id.
     */
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    /*
     * Every copy this publish writes carries the job it came from: the id and
     * the moment, so any account an administrator looks into says which publish
     * reached it, and whether the copy it holds is the one this job made.
     */
    const copy: PolicyDocument = { ...doc, published: { id, at: startedAt } };
    const reached: string[] = [];
    const unreached: PublishUnreached[] = [];
    const upstream = await sessionUpstream(admin);
    const own = {
      authorization: admin.authorization,
      session: upstream,
      username: admin.username,
    };
    const ownAccountId = filesAccountId(own);

    /**
     * One account's copy, written conditionally against that account's own
     * folder.
     *
     * The state token is read after the app folder is known to exist: creating
     * that folder moves the account's own state, and a token read before it
     * would make the conditional write lose a race with this very call (the
     * reason `AgentStore.provision` runs before an agent's first conditional
     * write). A refusal — the folder moved between the read and the write —
     * leaves the account with the document it already had, is named as its own
     * code rather than counted as reached, and never overwrites a copy this
     * publish did not see.
     */
    const deliver = async (
      address: string,
      ctx: Ctx,
      accountId: string,
    ): Promise<void> => {
      try {
        await ensureAppFolder(ctx, accountId);
        const state = await appFolderState(ctx, accountId);
        /*
         * No token means no way to tell a folder that moved from one that did
         * not, and a write without one would be counted as reached while it
         * could have overwritten a copy this publish never saw. The account is
         * named instead.
         */
        if (!state) throw new Error("the account would not state its file state");
        await writeAccountPolicy(ctx, accountId, copy, { ifInState: state });
        reached.push(address);
      } catch (err) {
        unreached.push({
          address,
          code: refusalCodeFor(err),
          message: (err as Error).message,
        });
      }
    };

    if (!ownAccountId) {
      unreached.push({
        address: admin.username,
        code: "no-files-account",
        message: "this account has no Files account to hold the policy",
      });
    } else {
      await deliver(admin.username, own, ownAccountId);
    }

    // The rest of the directory, one impersonated write per account. A failure
    // here does not undo the write just made to the publisher's own account --
    // there is no shared document for it to be undone against.
    const directory = await fetchDirectoryUsers(admin.authorization, upstream);
    let population: PublishJob["population"] = { read: 0, complete: false, total: null };
    let carrying = false;
    let refusal: string | undefined;
    if ("denied" in directory) {
      refusal = directory.denied;
    } else {
      for (const user of directory.users) {
        if (normalizeUsername(user.name) === normalizeUsername(admin.username)) continue;
        const imp = await impersonateAs(admin, user.name);
        if (!imp.ok) {
          unreached.push({
            address: user.name,
            code: "impersonation-refused",
            message: imp.message,
          });
          continue;
        }
        const accountId = filesAccountId(imp.ctx);
        if (!accountId) {
          unreached.push({
            address: user.name,
            code: "no-files-account",
            message: "this account has no Files account to hold the policy",
          });
          continue;
        }
        await deliver(user.name, imp.ctx, accountId);
      }
      population = {
        read: directory.users.length,
        complete: directory.complete,
        total: directory.total,
      };
      // The installation carries the policy when every account the directory
      // lists received it -- and the directory was the whole directory.
      carrying = directory.complete && unreached.length === 0;
    }

    const job: PublishJob = {
      v: 1,
      id,
      startedAt,
      by: admin.username,
      population,
      reached,
      unreached,
      complete: carrying,
      ...(refusal ? { directory: refusal } : {}),
    };
    /*
     * The record, in the publishing administrator's own app folder. A publish
     * whose record cannot be written fails loudly rather than answering a job
     * no later read can find: what makes this answer worth anything is that
     * the account holds it, not that this process remembers it. An account
     * with no Files account at all has nowhere to keep it, and that is already
     * named in `unreached`.
     */
    if (ownAccountId) {
      /*
       * The record is what makes this answer worth anything later, so a write
       * that fails is said rather than swallowed -- but it is not the publish:
       * every copy is already in its account, and the report of what was
       * reached must not be thrown away because the note about it was.
       */
      try {
        await writePublishJob(own, ownAccountId, job);
      } catch (err) {
        job.record = "failed";
        job.recordMessage = (err as Error).message;
      }
    }
    return job;
  }

  api.post("/admin/policy", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const raw = await c.req.text();
    const parsed = parsePolicyDocumentDetailed(raw);
    if ("problem" in parsed) {
      return c.json({ error: "invalid_policy", message: parsed.problem }, 400);
    }
    /*
     * The publisher's own account is written in the same pass as the rest, so
     * one answer describes the whole attempt: what the directory held, what was
     * reached, and what the installation therefore is now. The outcome and the
     * job are one document — the run's report is the record the account keeps,
     * under the same id the copies carry — answered under both names because
     * the editor reads the outcome and a later read of this surface returns
     * the job.
     */
    let job: PublishJob;
    try {
      job = await publishAccountPolicy(session, parsed.doc);
    } catch (err) {
      return upstreamFailure(c, err);
    }
    const kicked = sessions.destroyAllExcept(session.id);
    return c.json({ outcome: job, job, kicked });
  });

  /**
   * The admin Users surface (ADR 0001): every individual
   * account on this server, plus whether this session may act on accounts at
   * all.
   *
   * `impersonation` probes the right the way the actions themselves use it —
   * impersonating a real account (`{user}%{admin}`) — and the probe answers
   * only what Stalwart's `Impersonate` permission allows: the acting
   * session's own permission list decides, not membership of any Gilbert
   * group. Acting checks are only meaningful on the accounts a force would
   * target. When the directory cannot be listed there is nobody to probe
   * with and the state is "unknown": no warning, the server still refuses at
   * action time. Roles are not consulted — Stalwart does not expose them
   * over JMAP.
   */
  api.get("/admin/users", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await sessionUpstream(session, true);
      const directory = await fetchDirectoryUsers(session.authorization, upstream);
      const enumeration = !("denied" in directory);
      const users = enumeration ? directory.users : [];
      const self = session.username.trim().toLowerCase();
      const probeName = users.find((u) => u.name !== self)?.name ?? null;
      let impersonation: "ok" | "denied" | "unknown" = "unknown";
      if (probeName) {
        const probeAuth = impersonationAuthorization(session, probeName);
        if (!probeAuth)
          impersonation = "denied"; // an app-password session
        else {
          try {
            await fetchUpstreamSession(probeAuth, upstreamFor(probeName));
            impersonation = "ok";
          } catch (err) {
            impersonation =
              err instanceof UpstreamError && err.status === 401 ? "denied" : "unknown";
          }
        }
      }
      const flagged =
        impersonation === "ok" && users.length
          ? await forcedFlagsFor(users, session)
          : /*
             * Nobody was probed, so nothing is known — and `false` is not
             * nothing. An app-password session, or one whose Stalwart
             * `Impersonate` right was withdrawn, cannot ask whether a password
             * change is forced on anybody, and stamping `false` on every row
             * tells the administrator that no account is under the change wall
             * while real users are walled out of the data path. `null` is the
             * third state, and the surface draws it: the roster is shown, and
             * which accounts are forced is not claimed.
             */
            users.map((u) => ({ ...u, forced: null }));
      return c.json({
        users: flagged,
        enumeration,
        enumerationMessage: "denied" in directory ? directory.denied : null,
        impersonation,
      });
    } catch (err) {
      if (err instanceof UpstreamError) return upstreamFailure(c, err);
      console.error("[gilbert] directory users query failed:", err);
      return c.json(
        { error: "directory_unavailable", message: (err as Error).message },
        502,
      );
    }
  });

  /**
   * The group label catalog surface (ADR 0005): list group mailboxes and read
   * or replace the labels.json in a group's own Files. The catalog is the
   * agent's, and so is the door: it is read and written as the installation's
   * agent — the deployment's own credential when it holds one, otherwise
   * impersonation from the administrator's session, which an app-password
   * sign-in cannot do.
   *
   * The agent's own door is defined once, in `agentAdmin.ts`, and shared with
   * the agent surfaces (ADR 0003).
   */
  api.get("/admin/groups", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await sessionUpstream(session, true);
      const directory = await fetchDirectoryGroups(session.authorization, upstream);
      if ("denied" in directory)
        return c.json({
          groups: [],
          enumeration: false,
          enumerationMessage: directory.denied,
        });
      return c.json({ groups: directory.groups, enumeration: true });
    } catch (err) {
      if (err instanceof UpstreamError) return upstreamFailure(c, err);
      console.error("[gilbert] directory groups query failed:", err);
      return c.json(
        { error: "directory_unavailable", message: (err as Error).message },
        502,
      );
    }
  });
}
