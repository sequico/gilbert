/**
 * The agent surfaces and the group label catalog (ADR 0003, ADR 0005).
 *
 * The installation's agent, the groups that have granted it, its model, its
 * app password and the group documents the fleet works from — and the label
 * catalog, which is written through the same agent door. The member's view of
 * a group's agent lives here too, behind `requireSession` alone, because it
 * exists for exactly them.
 */

import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readGroupLabels, writeGroupLabels } from "../account.js";
import {
  AGENT_INSTRUCTION_FILE,
  AGENT_PREAMBLE_FILE,
  agentRuleJsonSchema,
} from "../agent/documents.js";
import { AgentDocumentError, AgentStore } from "../agent/store.js";
import type { AgentGroupAnswer } from "../agent/views.js";
import {
  AgentAdminError,
  addAgentLabels,
  agentStatus,
  agentStore,
  emptyGroupDocuments,
  groupAgentView,
  groupAuditExport,
  memberAgentView,
  memberGroupMembers,
  pendingApprovals,
  readAgentProse,
  readDraft,
  readGroupNotebook,
  readGroupPolicy,
  readProviders,
  readRules,
  resolveGroupAccess,
  runRuleNow,
  saveAgentProse,
  saveGroupNotebook,
  saveGroupPolicy,
  saveRules,
  writeProviders,
} from "../agentAdmin.js";
import { agentAddress } from "../config.js";
import type { Env } from "./shared.js";
import {
  groupDenial,
  readJson,
  requireAdmin,
  requireSession,
  upstreamFailure,
} from "./shared.js";

export function registerAgentRoutes(api: Hono<Env>): void {
  api.get("/admin/groups/:name/labels", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, { need: "labels" });
      if (!access.ok) return groupDenial(c, access);
      const labels = await readGroupLabels(access.ctx, access.accountId);
      /* A catalog the validator refuses reads as no catalog: the surface shows
         what it can render, and a write over one is refused where it is made. */
      return c.json({ labels: labels.state === "catalog" ? labels.labels : [] });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/groups/:name/labels", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ labels?: unknown }>(c);
    if (!body || !Array.isArray(body.labels))
      return c.json({ error: "bad_request", message: "labels must be an array" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "labels" });
      if (!access.ok) return groupDenial(c, access);
      await writeGroupLabels(access.ctx, access.accountId, body.labels);
      return c.json({ ok: true });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  // ---------- The agent fleet (ADR 0003) ----------
  /**
   * The agent surfaces (ADR 0003): the installation's one agent, the groups
   * that have granted it, the agents running for it, its model,
   * its app password, and the group documents the fleet works from.
   *
   * Membership is not written here — the operator grants the agent in
   * Stalwart's own administration and these routes verify it — and a
   * deployment with no agent answers plainly instead of failing.
   */
  const agentFailure = (c: Context, err: unknown) => {
    // Narrowed the way `refusal` narrows a status, for the same reason.
    if (err instanceof AgentDocumentError) {
      // A document this build cannot use and could not bring to the current
      // shape is a fault of the stored documents, not of the mail server: it
      // answers with its own code so the surface says that and not "could not
      // reach the mail server".
      return c.json({ error: "agent_document_not_current", detail: err.detail }, 500);
    }
    if (err instanceof AgentAdminError) {
      // The reason travels flat beside its code — `{ error, ...params }`, the
      // shape a group refusal already answers with — so the surface composes
      // the sentence from the catalogue in force and no English is put on the
      // wire for it to fall back on.
      const { code, ...params } = err.reason;
      return c.json({ error: code, ...params }, err.status as ContentfulStatusCode);
    }
    return upstreamFailure(c, err);
  };

  /**
   * The published schema of a rule document (ADR 0003 resolution 2).
   *
   * What the admin surface authors, in the standard form anything outside this
   * codebase validates against — and the same catalogue the runtime reads, so
   * the two cannot drift. Reading it needs no more than the admin shield.
   */
  api.get("/admin/agent/rule-schema", requireSession, requireAdmin, (c) =>
    c.json(agentRuleJsonSchema()),
  );

  api.get("/admin/agents", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      return c.json(await agentStatus(session));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * A group's agent surface. A group the agent does not hold answers 200 with
   * the refusal and empty documents rather than 403: "the agent is not granted
   * here" is a state of the surface, not a failed request — the documents are
   * the agent's, so a group it cannot reach has nothing to show — and the
   * surface names the section a person was standing at instead of failing at
   * the door.
   */
  api.get("/admin/groups/:name/agent", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const identity = agentAddress();
    try {
      const access = await resolveGroupAccess(session, name, {
        need: "agent documents",
      });
      if (!access.ok)
        return c.json({
          group: name,
          granted: false,
          agentAddress: identity,
          error: access.error,
          need: access.need,
          ...emptyGroupDocuments(),
        } satisfies AgentGroupAnswer);
      const view = await groupAgentView(access, access.accountId);
      return c.json({
        group: name,
        agentAddress: identity,
        ...view,
      } satisfies AgentGroupAnswer);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * A group's audit trail, month by month, for an administrator to keep.
   *
   * The months are the declared retention's window — the same one
   * `pruneAudit` (executor.ts) drops a document at a time — so this is the
   * copy the retention decision promises before the oldest month goes.
   */
  api.get("/admin/groups/:name/agent/audit", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, {
        need: "agent documents",
      });
      if (!access.ok) return groupDenial(c, access);
      return c.json(await groupAuditExport(access, access.accountId, name));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.get("/admin/groups/:name/agent/rules", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, { need: "automations" });
      if (!access.ok) return groupDenial(c, access);
      return c.json(await readRules(access, access.accountId));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/groups/:name/agent/rules", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ rules?: unknown }>(c);
    if (!body || !Array.isArray(body.rules))
      return c.json({ error: "bad_request", message: "rules must be an array" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "automations" });
      if (!access.ok) return groupDenial(c, access);
      const rules = await saveRules(
        access,
        access.accountId,
        body.rules,
        session.username,
      );
      return c.json({ ok: true, rules });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /*
   * Run one of a group's automations now, on a message a person names (ADR 0003). The answer is the job, which the agent holding the group's claim
   * picks up on its next pass: the surface can say when it was asked for and
   * the run's own record says what came of it.
   */
  api.post("/admin/groups/:name/agent/run", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    const body = await readJson<{ ruleId?: unknown; emailId?: unknown }>(c);
    if (!body || typeof body.ruleId !== "string")
      return c.json({ error: "bad_request", message: "ruleId must be a string" }, 400);
    try {
      const access = await resolveGroupAccess(session, name, { need: "automations" });
      if (!access.ok) return groupDenial(c, access);
      return c.json({
        ok: true,
        job: await runRuleNow(
          access,
          access.accountId,
          {
            ruleId: body.ruleId,
            emailId: body.emailId,
          },
          session.username,
        ),
      });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.get("/admin/agent/providers", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      return c.json(await readProviders(session));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/agent/providers", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const body = await readJson<{ provider?: unknown }>(c);
    if (!body)
      return c.json({ error: "bad_request", message: "provider is required" }, 400);
    try {
      await writeProviders(session, body);
      return c.json({ ok: true });
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * The installation's own rules of prose (ADR 0019), written here and read by
   * every group's runs.
   *
   * It is the same document type as a group's standing instruction, at the
   * outermost reach, and it lives in the Master's account — which is the
   * account the boot already holds a credential for, so the pair of routes
   * differs from the group's only in whose files they reach.
   */
  api.get("/admin/agent/instruction", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const { store } = await agentStore(session);
      return c.json(await readAgentProse(store, AGENT_PREAMBLE_FILE));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post("/admin/agent/instruction", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      const body = await readJson<{ text?: string }>(c);
      const text = typeof body?.text === "string" ? body.text : "";
      const { store } = await agentStore(session);
      return c.json(
        await saveAgentProse(store, AGENT_PREAMBLE_FILE, text, session.username),
      );
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post(
    "/admin/groups/:name/agent/labels",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(session, name, { need: "labels" });
        if (!access.ok) return groupDenial(c, access);
        const { added } = await addAgentLabels(access, access.accountId);
        return c.json({ ok: true, added });
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * The group's notebook: the facts its agent holds in every call (ADR 0003).
   * Administrator-only, like the standing instruction beside it — memory the
   * model is given on every run is configuration, and members read it rather
   * than write it.
   */
  api.get(
    "/admin/groups/:name/agent/notebook",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(session, name, { need: "notebook" });
        if (!access.ok) return groupDenial(c, access);
        return c.json(await readGroupNotebook(access));
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  api.post(
    "/admin/groups/:name/agent/notebook",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const body = await readJson<{ facts?: unknown }>(c);
        const access = await resolveGroupAccess(session, name, { need: "notebook" });
        if (!access.ok) return groupDenial(c, access);
        return c.json(await saveGroupNotebook(access, body, session.username));
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * The group's standing instruction: the house rules its agent carries into
   * every model call (ADR 0003 resolution 17). Administrator-only, like the
   * rules document beside it — a text the model is told to follow is
   * configuration, and members read the rules rather than write them.
   */
  api.get(
    "/admin/groups/:name/agent/instruction",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const access = await resolveGroupAccess(session, name, {
          need: "standing instruction",
        });
        if (!access.ok) return groupDenial(c, access);
        return c.json(
          await readAgentProse(
            new AgentStore(access.ctx, access.accountId),
            AGENT_INSTRUCTION_FILE,
          ),
        );
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  api.post(
    "/admin/groups/:name/agent/instruction",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const body = await readJson<{ text?: string }>(c);
        const text = typeof body?.text === "string" ? body.text : "";
        const access = await resolveGroupAccess(session, name, {
          need: "standing instruction",
        });
        if (!access.ok) return groupDenial(c, access);
        return c.json(
          await saveAgentProse(
            new AgentStore(access.ctx, access.accountId),
            AGENT_INSTRUCTION_FILE,
            text,
            session.username,
          ),
        );
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * The group's policy: who its runs stop for, and whether they may reach
   * outside the group without a person (ADR 0006).
   *
   * Its own route beside the instruction because it is its own document: a
   * member reads it on the member door with the automations it governs, and an
   * administrator writes it here. Read for everyone, written by an
   * administrator, like every other document in this app folder.
   */
  api.get("/admin/groups/:name/agent/policy", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const access = await resolveGroupAccess(session, name, { need: "policy" });
      if (!access.ok) return groupDenial(c, access);
      return c.json(await readGroupPolicy(access));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  api.post(
    "/admin/groups/:name/agent/policy",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      try {
        const body = await readJson<{ review?: unknown; allowExternal?: unknown }>(c);
        const access = await resolveGroupAccess(session, name, { need: "policy" });
        if (!access.ok) return groupDenial(c, access);
        return c.json(
          await saveGroupPolicy(
            access,
            { review: body?.review, allowExternal: body?.allowExternal },
            session.username,
          ),
        );
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  /**
   * An author's reading (ADR 0003): the draft, the envelope it belongs to, the
   * group's instruction and the group's notebook go to the installation's
   * model, which answers in words about the gaps.
   *
   * Not a run: nothing is compiled, no document is produced, and its tokens are
   * counted in the Master's account as authoring. The answer is model prose
   * shown as prose — unlike a refusal, which travels as a code the surface
   * composes a sentence from.
   */
  api.post(
    "/admin/groups/:name/agent/reading",
    requireSession,
    requireAdmin,
    async (c) => {
      const session = c.get("session");
      const name = c.req.param("name") ?? "";
      const body = await readJson<{
        about?: unknown;
        draft?: unknown;
        envelope?: unknown;
      }>(c);
      const draft = typeof body?.draft === "string" ? body.draft.trim() : "";
      if (!draft)
        return c.json({ error: "bad_request", message: "draft must be a string" }, 400);
      try {
        const access = await resolveGroupAccess(session, name, {
          need: "standing instruction",
        });
        if (!access.ok) return groupDenial(c, access);
        return c.json(
          await readDraft(session, {
            access,
            about: typeof body?.about === "string" ? body.about : "a draft",
            draft,
            ...(typeof body?.envelope === "string" ? { envelope: body.envelope } : {}),
          }),
        );
      } catch (err) {
        return agentFailure(c, err);
      }
    },
  );

  api.get("/admin/agent/approvals", requireSession, requireAdmin, async (c) => {
    const session = c.get("session");
    try {
      // The queue's own answer: the list, and the reach it was built from.
      return c.json(await pendingApprovals(session));
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * The member's view of a group's agent — `requireSession` and nothing more,
   * because a member is not an administrator and this surface exists for
   * exactly them (ADR 0003, "Members see, never change"). It reads the group's
   * own documents — its automations and the standing instruction the agent
   * carries into every model call — and writes nothing, ever.
   */
  api.get("/agent/group/:name", requireSession, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const view = await memberAgentView(session, name);
      if ("ok" in view) return groupDenial(c, view);
      return c.json(view);
    } catch (err) {
      return agentFailure(c, err);
    }
  });

  /**
   * A group's members, for the `@` picker beside the chat.
   *
   * Its own route rather than a field of the view above, because the picker
   * asks it when a mention begins and nothing else needs it: the chat opens
   * without this read, and a reader who never mentions anybody never causes
   * one. The answer is the installation's own roster read — made as the
   * Master, the one principal that may ask Stalwart's registry (ADR 0003) —
   * and `members` is null when nobody could read it, which the surface renders
   * as the transcript it already has.
   */
  api.get("/agent/group/:name/members", requireSession, async (c) => {
    const session = c.get("session");
    const name = c.req.param("name") ?? "";
    try {
      const view = await memberGroupMembers(session, name);
      if ("ok" in view) return groupDenial(c, view);
      return c.json(view);
    } catch (err) {
      return agentFailure(c, err);
    }
  });
}
