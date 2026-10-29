/**
 * The outbound surfaces (ADR 0040): the campaigns of a group, its Today, its
 * do-not-call list, and the two acts a caller takes on a row.
 *
 * Every handler resolves the group the caller names through `campaignAccount`,
 * which asks the caller's own session about membership and then acts as that
 * caller: nothing here reaches the installation's agent, so a group the agent
 * holds no grant on works like any other. Everything a handler touches — the
 * campaigns, the rows and the do-not-call list — lives in that one group account.
 */

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { readCardIndex } from "../outbound/cards.js";
import {
  listCampaigns,
  mutateDoNotCall,
  readCardCalls,
  readDoNotCall,
  readRows,
} from "../outbound/documents.js";
import { OutboundError } from "../outbound/errors.js";
import { normaliseNumber } from "../outbound/phone.js";
import { todayQueue } from "../outbound/queue.js";
import { campaignAccount } from "../outbound/scope.js";
import { listScriptPages, readScript } from "../outbound/script.js";
import {
  closeCampaign,
  createCampaign,
  importList,
  openCampaign,
  release,
  settle,
  take,
} from "../outbound/writes.js";
import type { LiveSession } from "../sessions.js";
import { isRecord } from "../shared/json.js";
import type {
  CampaignOutcome,
  CampaignScriptRef,
  CampaignWindow,
} from "../shared/outbound.js";
import { isPastWindow } from "../shared/outbound.js";
import type { Env } from "./shared.js";
import { failureFor, readJson, requireSession } from "./shared.js";

/** One string a body must carry, or a refusal that says which field. */
function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OutboundError("bad_request", `The field "${field}" is required.`, 400);
  }
  return value.trim();
}

/** One string a body may carry; absent and blank are the same absence. */
function optional(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new OutboundError("bad_request", `The field "${field}" is a string.`, 400);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** One instant a body may carry, or null: the same reading wherever a date is sent. */
function instantOf(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new OutboundError(
      "bad_request",
      `The field "${field}" is an ISO instant or null.`,
      400,
    );
  }
  return value;
}

/** The outcomes a campaign admits, as the creation body states them. */
function outcomesOf(value: unknown): CampaignOutcome[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OutboundError("bad_request", "A campaign needs at least one outcome.", 400);
  }
  const outcomes = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.label !== "string"
    ) {
      throw new OutboundError(
        "bad_request",
        "Each outcome needs an id and a label.",
        400,
      );
    }
    if (entry.id.trim() === "" || entry.label.trim() === "") {
      throw new OutboundError(
        "bad_request",
        "An outcome's id and label cannot be empty.",
        400,
      );
    }
    return { id: entry.id.trim(), label: entry.label.trim() };
  });
  // The document refuses two outcomes sharing an id, so the write does too: a
  // campaign stored here has to be one this build can read back.
  if (new Set(outcomes.map((outcome) => outcome.id)).size !== outcomes.length) {
    throw new OutboundError("bad_request", "Two outcomes cannot share an id.", 400);
  }
  return outcomes;
}

function scriptOf(value: unknown): CampaignScriptRef | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.nodeId !== "string" ||
    typeof value.revision !== "string"
  ) {
    throw new OutboundError(
      "bad_request",
      "A script names the page and the revision it was read at.",
      400,
    );
  }
  return { nodeId: value.nodeId, revision: value.revision };
}

function windowOf(value: unknown): CampaignWindow {
  if (value === undefined || value === null) return { from: null, to: null };
  if (!isRecord(value))
    throw new OutboundError("bad_request", "The window is a pair of dates.", 400);
  const from = instantOf(value.from, "window.from");
  const to = instantOf(value.to, "window.to");
  // A window that ends before it starts is a campaign nobody can work and a finding
  // that says nothing: refused where it is written, not discovered later.
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
    throw new OutboundError(
      "bad_request",
      "A campaign cannot end before it starts.",
      400,
    );
  }
  return { from, to };
}

export function registerOutboundRoutes(api: Hono<Env>): void {
  const outboundFailure = failureFor(OutboundError);

  api.get("/outbound/campaigns", requireSession, async (c) => {
    try {
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(c.req.query("group"), "group"),
      );
      const { docs } = await listCampaigns(ctx, accountId);
      /*
       * A window that has passed with rows still open is a finding for the group —
       * closed, extended, or carried into the next campaign — and never a list that
       * quietly stops existing. Only the campaigns past their window are read for
       * it, because that is the only state in which the count means anything.
       *
       * What cannot be read is not reported here: Today reads the same documents
       * and is the screen where the reader can do something about it.
       */
      const now = new Date();
      const findings: Array<{ uid: string; purpose: string; open: number }> = [];
      for (const campaign of docs) {
        if (campaign.state !== "running" || !isPastWindow(campaign, now)) continue;
        const { docs: rows } = await readRows(ctx, accountId, campaign.uid);
        const open = rows.filter((row) => row.state === "open").length;
        if (open > 0)
          findings.push({ uid: campaign.uid, purpose: campaign.purpose, open });
      }
      return c.json({ ok: true, campaigns: docs, findings });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /**
   * Close a campaign, carrying its open rows into a successor when asked.
   *
   * `carry` is the second of the two resolutions the record allows for work still
   * to do: the rows move to a new campaign with the same purpose and vocabulary,
   * and the one being closed keeps its own.
   */
  api.post("/outbound/campaigns/:uid/close", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError("bad_request", "A close names its group.", 400);
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(body.group, "group"),
      );
      const closed = await closeCampaign(ctx, accountId, c.req.param("uid"), {
        carry: body.carry === true,
        createdBy: c.get("session").username,
        now: new Date(),
        newUid: randomUUID,
      });
      return c.json({
        ok: true,
        campaign: closed.campaign,
        successor: closed.successor,
        carried: closed.carried,
      });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  api.post("/outbound/campaigns", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError("bad_request", "A campaign is described by a body.", 400);
      const group = required(body.group, "group");
      const { ctx, accountId } = await campaignAccount(c.get("session"), group);
      const campaign = await createCampaign(ctx, accountId, {
        uid: randomUUID(),
        purpose: required(body.purpose, "purpose"),
        outcomes: outcomesOf(body.outcomes),
        script: scriptOf(body.script),
        window: windowOf(body.window),
        createdBy: c.get("session").username,
        now: new Date(),
      });
      return c.json({ ok: true, campaign });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  api.post("/outbound/campaigns/:uid/rows", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError("bad_request", "An import is described by a body.", 400);
      const group = required(body.group, "group");
      const text = required(body.text, "text");
      const { ctx, accountId } = await campaignAccount(c.get("session"), group);
      const blocked = (await readDoNotCall(ctx, accountId)).numbers;
      const cards = await readCardIndex(ctx, accountId);
      const imported = await importList(
        ctx,
        accountId,
        c.req.param("uid"),
        text,
        { doNotCall: blocked, cards },
        new Date(),
        randomUUID,
      );
      return c.json({
        ok: true,
        added: imported.rows.length,
        matched: imported.matched,
        duplicate: imported.duplicate,
        blocked: imported.blocked,
        refused: imported.refused,
      });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /**
   * What was said to one card, read by whoever may read the group.
   *
   * The row dies with its campaign; this does not, which is what lets a card
   * opened in November say what a colleague said in October.
   */
  api.get("/outbound/card-calls", requireSession, async (c) => {
    try {
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(c.req.query("group"), "group"),
      );
      const cardUid = required(c.req.query("card"), "card");
      const { calls, trimmed } = await readCardCalls(ctx, accountId, cardUid);
      return c.json({ ok: true, calls, trimmed });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /**
   * The group's knowledge pages, as a campaign picks the one it reads aloud.
   *
   * The page's own revision travels with it, because that is what a campaign pins:
   * a script is the words as they stood when the list started, never as somebody
   * edited them on Wednesday.
   */
  api.get("/outbound/script-pages", requireSession, async (c) => {
    try {
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(c.req.query("group"), "group"),
      );
      return c.json({ ok: true, pages: await listScriptPages(ctx, accountId) });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /** Every row of a campaign, settled ones included: what a handoff is made of. */
  api.get("/outbound/campaigns/:uid/rows", requireSession, async (c) => {
    try {
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(c.req.query("group"), "group"),
      );
      const { docs } = await readRows(ctx, accountId, c.req.param("uid"));
      return c.json({ ok: true, rows: docs });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /** The words of the revision a campaign pinned, or null when the page is gone. */
  api.get("/outbound/campaigns/:uid/script", requireSession, async (c) => {
    try {
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(c.req.query("group"), "group"),
      );
      const campaign = await openCampaign(ctx, accountId, c.req.param("uid"));
      return c.json({
        ok: true,
        text: await readScript(ctx, accountId, campaign.script),
      });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  api.get("/outbound/do-not-call", requireSession, async (c) => {
    try {
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(c.req.query("group"), "group"),
      );
      const { numbers } = await readDoNotCall(ctx, accountId);
      return c.json({ ok: true, numbers });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /**
   * Put one number on the group's do-not-call list, or take it off.
   *
   * The number is read the way every other arrival is read — one canonical
   * E.164 form — because the list is matched against the rows by that string and
   * by nothing else. A number the build cannot resolve is refused here rather
   * than written as typed, which would be an entry the import could never match.
   */
  api.post("/outbound/do-not-call", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError(
          "bad_request",
          "A do-not-call entry is described by a body.",
          400,
        );
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(body.group, "group"),
      );
      const number = normaliseNumber(required(body.number, "number"));
      if (!number.ok) {
        throw new OutboundError(
          number.reason,
          "That is not a number this build can resolve: write it with its country code.",
          400,
        );
      }
      const blocked = body.blocked !== false;
      const doc = await mutateDoNotCall(ctx, accountId, (current) => ({
        version: 1,
        numbers: blocked
          ? [...new Set([...current.numbers, number.e164])].sort()
          : current.numbers.filter((entry) => entry !== number.e164),
        updatedAt: new Date().toISOString(),
      }));
      return c.json({ ok: true, numbers: doc.numbers });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  api.get("/outbound/today", requireSession, async (c) => {
    try {
      const session = c.get("session") as LiveSession;
      const { ctx, accountId } = await campaignAccount(
        session,
        required(c.req.query("group"), "group"),
      );
      const wanted = c.req.query("campaign") ?? "";
      const { docs: campaigns, problems } = await listCampaigns(ctx, accountId);
      const running = campaigns.filter(
        (campaign) =>
          campaign.state === "running" && (wanted === "" || campaign.uid === wanted),
      );
      const rows = [];
      for (const campaign of running) {
        const read = await readRows(ctx, accountId, campaign.uid);
        problems.push(...read.problems);
        rows.push(...read.docs);
      }
      // The whole queue, ordered: a campaign is one document, so the page the
      // reader sees is the pane's to cut, and the counts can never disagree with
      // the list they sit above.
      const today = todayQueue(rows, { caller: session.username, now: new Date() });
      return c.json({ ok: true, ...today, problems });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  api.post("/outbound/campaigns/:uid/rows/:rowUid/take", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError("bad_request", "A take names its group.", 400);
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(body.group, "group"),
      );
      const row = await take(
        ctx,
        accountId,
        c.req.param("uid"),
        c.req.param("rowUid"),
        c.get("session").username,
        new Date(),
      );
      return c.json({ ok: true, row });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  /**
   * Give a taken row back to the list.
   *
   * A caller holds one row at a time, so a row taken by mistake would keep them
   * from the list for the length of the lease. The release is the way out, and it
   * is only the holder's to make.
   */
  api.post("/outbound/campaigns/:uid/rows/:rowUid/release", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError("bad_request", "A release names its group.", 400);
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(body.group, "group"),
      );
      const row = await release(
        ctx,
        accountId,
        c.req.param("uid"),
        c.req.param("rowUid"),
        c.get("session").username,
        new Date(),
      );
      return c.json({ ok: true, row });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });

  api.post("/outbound/campaigns/:uid/rows/:rowUid/settle", requireSession, async (c) => {
    try {
      const body: unknown = await readJson(c);
      if (!isRecord(body))
        throw new OutboundError(
          "bad_request",
          "A settlement is described by a body.",
          400,
        );
      const { ctx, accountId } = await campaignAccount(
        c.get("session"),
        required(body.group, "group"),
      );
      const row = await settle(
        ctx,
        accountId,
        c.req.param("uid"),
        c.req.param("rowUid"),
        {
          outcome: required(body.outcome, "outcome"),
          note: optional(body.note, "note"),
          by: c.get("session").username,
          at: new Date(),
          cardUid: optional(body.cardUid, "cardUid"),
          nextCallAt: instantOf(body.nextCallAt, "nextCallAt"),
        },
      );
      return c.json({ ok: true, row });
    } catch (err) {
      return outboundFailure(c, err);
    }
  });
}
