/**
 * A tiny in-memory JMAP server that mimics the subset of Stalwart that Gilbert
 * uses. For local development and demos only:  `npm run mock` then point the
 * server at it with STALWART_URL=http://127.0.0.1:8788 (user: demo / pass: demo).
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseOtpauthUrl, verifyTotp } from "../totp.js";
import { holdUntilOf, undoStatusOf } from "./futurerelease.js";
import {
  expandOccurrences,
  type Occurrence,
  occurrenceAt,
  occurrenceView,
  parseSyntheticId,
  splitOccurrencePatch,
  syntheticId,
} from "./recurrence.js";
import { type SIGNED_MESSAGES, signedMessage } from "./signedMessages.js";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
/**
 * Omit `urn:stalwart:jmap` from the session, so a sign-in can be tested
 * against a server Gilbert does not support. This is only that: the rest of
 * the mock still behaves like 0.16. Emulating 0.15 properly went with the
 * support for it.
 */
const NO_REGISTRY = process.env.MOCK_NO_REGISTRY === "1";
/**
 * Stalwart advertises FUTURERELEASE in the session but only honours it when
 * the MTA's own `futureRelease` setting is on -- and that setting defaults to
 * off, in which case the hold is dropped without a word and the message goes
 * out at once. Set MOCK_NO_FUTURE_RELEASE=1 to reproduce that trap.
 */
const NO_FUTURE_RELEASE = process.env.MOCK_NO_FUTURE_RELEASE === "1";
/** What the session advertises, matching Stalwart's own 30 days. */
const MAX_DELAYED_SEND = 86400 * 30;
/**
 * The mock's clock.
 *
 * Real time unless a test asks otherwise: `MOCK_NOW=<ISO instant>` at boot, or
 * `POST /mock/clock` (`{ now }` / `{ advanceMs }`) while it runs. Every stamp
 * the mock makes -- a node's `created`/`modified`, a message's `receivedAt`,
 * a submission's `sendAt` and the deadline behind its `undoStatus`, the `at`
 * of a chat document -- comes from here, so a test can put a schedule in the
 * past without waiting a minute for it (ADR 0003: the agent's time
 * triggers) and can watch a queued send become final.
 *
 * It is an offset against real time, not a frozen instant: with no override
 * the offset is zero, so nothing about the mock's timing differs from a plain
 * wall clock, and a moved clock still ticks. What it does not drive is the
 * mock's own demo intervals (the 30 s chat traffic, the 2 min inbox
 * injection): those stay real, because they are demo traffic rather than
 * anything a server does.
 */
const BOOT_NOW = Date.parse(process.env.MOCK_NOW ?? "");
let clockOffsetMs = Number.isNaN(BOOT_NOW) ? 0 : BOOT_NOW - Date.now();
/** The mock's notion of now, everywhere it stamps or compares a time. */
const now = () => Date.now() + clockOffsetMs;
const ACCOUNT = "a1";
/** How long a push subscription lives before the server drops it. */
const PUSH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** An account somebody has shared with the demo user. See the session below. */
const SHARED_ACCOUNT = "a2";
/** A group (team) mailbox the demo user is a member of. See the session below. */
const GROUP_ACCOUNT = "a3";
/** A second group (team) mailbox, so the chat switcher has two teams. */
const GROUP2_ACCOUNT = "a5";
/**
 * A second principal the mock knows, so the impersonation paths (ADR 0001)
 * have a target that is not the admin themselves. The mock has one data set
 * per principal; the target's account starts empty, like a fresh account's.
 */
const TARGET_ACCOUNT = "b1";
const TARGET_USER = process.env.MOCK_TARGET_USER ?? "bob@example.com";
const TARGET_PASS = process.env.MOCK_TARGET_PASS ?? "bob-password";
/**
 * The agent principal (ADR 0003).
 *
 * A real installation has one agent account with its own address, its own app
 * password and a grant on each group it works -- so its session shows the
 * group's account with `isPersonal: false`, exactly like a member's, and its
 * `myRights` on the group's mailboxes include `maySubmit` (live-verified on
 * 0.16.21, 2026-09-10, resolutions 12 and 14 of the ADR). The mock reproduces
 * both, because the worker's whole reach is derived from them: a fixture that
 * forgot the grant would leave every agent test passing against nothing.
 *
 * `MOCK_AGENT_ADDRESS` and `MOCK_AGENT_PASSWORD` name the principal; its app
 * passwords are minted through `x:AppPassword/set` like anybody's.
 */
export const AGENT_ADDRESS = process.env.MOCK_AGENT_ADDRESS ?? "gilbert@example.com";
export const AGENT_PASS = process.env.MOCK_AGENT_PASSWORD ?? "gilbert-password";
/** The agent's own account: its configuration documents live here (ADR 0003). */
const AGENT_ACCOUNT = "ag1";
const SHARED_CAPS: Obj = {
  "urn:ietf:params:jmap:mail": {},
  "urn:ietf:params:jmap:submission": {},
  "urn:ietf:params:jmap:vacationresponse": {},
  "urn:ietf:params:jmap:sieve": {},
  "urn:ietf:params:jmap:calendars": {},
  "urn:ietf:params:jmap:contacts": {},
  "urn:ietf:params:jmap:principals": {},
  "urn:ietf:params:jmap:quota": {},
  "urn:ietf:params:jmap:filenode": {},
};
const USER = process.env.MOCK_USER ?? "demo@example.com";
/**
 * The demo user is a Stalwart admin by default: `/api/account` reports the
 * admin marker in the resolved permission list, so the admin flag and the
 * administration surface are exercisable in dev:mock out of the box. Set
 * MOCK_ADMIN=0 for the non-admin case.
 *
 * The marker and the impersonation right below are fixture literals matching
 * the server's defaults (`GILBERT_ADMIN_PERMISSION`, live-verified
 * 2026-09-09). A mock run emulates the default configuration; an operator
 * who overrides the marker env while pointing Gilbert at the mock accepts
 * the drift.
 */
const MOCK_ADMIN = process.env.MOCK_ADMIN !== "0";
/** Exercise the guard that refuses to force another Gilbert admin (the
 *  target principal holds the admin marker too). */
const TARGET_IS_ADMIN = process.env.MOCK_TARGET_IS_ADMIN === "1";
/**
 * A principal the directory lists and the mock refuses to impersonate, named
 * by `MOCK_REFUSED_USER=carol@example.com`.
 *
 * The publish that writes the installation policy into every account walks
 * the directory and seals a session onto each one; an account the server will
 * not seal a session onto costs that account alone, leaving every other
 * publish written, and that branch is reachable only while the directory
 * holds such an account. Empty, the default, leaves the mock listing the
 * principals it will impersonate, because the admin-policy tests pin that
 * every listed account is reached -- a test that wants the refusal names the
 * address it stands in for.
 *
 * The refusal the mock answers is the 401 it answers for any composite it
 * will not seal (`resolveIdentity`), which the administrator's publish
 * reports as "no such account". A real 0.16.21 server refuses an
 * impersonation it will not grant with 403 (live-verified 2026-09-09 for a
 * group target, where the mock also answers 401, pinned by
 * `admin-group-labels.test.ts`). The live probe this owes: what a real server
 * answers for a listed individual it refuses, and whether that refusal is
 * distinguishable from the unknown-account one at all.
 */
const REFUSED_USER = process.env.MOCK_REFUSED_USER?.trim() ?? "";
/**
 * Whether this session may query the directory at all.
 *
 * A real 0.16 server gates `Principal/query` behind `allow_directory_query` or
 * the JmapPrincipalQuery permission (crates/jmap/src/principal/query.rs,
 * checked on source 2026-09-07) and refuses the request when the gate is
 * closed for the session, which is why a client degrades to typing an address
 * rather than failing the surface. `MOCK_NO_DIRECTORY_QUERY=1` at boot, or
 * `directoryGate.open = false` from a test that drives the mock in-process,
 * closes it. A mock run leaves it open, because the surfaces it stands in for
 * need the directory.
 *
 * The live probe this owes: which of 400 and 403 a real server answers a
 * closed gate with, and whether the refusal is the whole request or one
 * refused method call. The client treats the two alike (`fetchDirectoryPrincipals`
 * in `server/src/upstream.ts` turns either into a denied read), so the mock
 * answers 403 and nothing turns on the difference.
 */
export const directoryGate = { open: process.env.MOCK_NO_DIRECTORY_QUERY !== "1" };
/** The user-role permissions `/api/account` reports (ADR 0001). */
const USER_PERMISSIONS = ["jmapEmailGet", "sysAccountSettingsGet"];
/**
 * What `/api/account` reports for a principal: the user-role list, plus the
 * admin marker and the rights the admin role bundles (live-verified
 * 2026-09-09: `impersonate` and `scimAccess` ride along with
 * `sysAccountCreate`). Groups are never admins; the target principal holds
 * the marker only under MOCK_TARGET_IS_ADMIN=1.
 */
const permissionsOf = (username: string): string[] => {
  const admin =
    username === USER ? MOCK_ADMIN : username === TARGET_USER ? TARGET_IS_ADMIN : false;
  return admin
    ? [...USER_PERMISSIONS, "sysAccountCreate", "impersonate", "scimAccess"]
    : [...USER_PERMISSIONS];
};
/** Locale the fake directory reports for the account (POSIX style, as Stalwart does). */
const MOCK_LOCALE = process.env.MOCK_LOCALE ?? "en_US";
const PASS = process.env.MOCK_PASS ?? "demo";
/**
 * Credential state, mutable so the self-service flows can be exercised against
 * the mock the way they run against a real 0.16 server: the password changes,
 * 2FA starts demanding a code on every request, and app passwords keep working
 * without one. This is the demo principal's state; the target principal has
 * its own below. `principalState()` resolves whichever a request authenticated
 * as, keeping the demo principal's object identical to this export so tests
 * that read or write `account` keep working.
 */
export const account = {
  password: PASS,
  otpUrl: null as string | null,
  appPasswords: [] as Obj[],
};
/** The target principal's credential state; see `account`. */
export const targetAccount = {
  password: TARGET_PASS,
  otpUrl: null as string | null,
  appPasswords: [] as Obj[],
};
/** The agent principal's credential state; see `account`. */
export const agentAccount = {
  password: AGENT_PASS,
  otpUrl: null as string | null,
  appPasswords: [] as Obj[],
};
const MASKED = "[********]";

type Obj = Record<string, unknown>;
/**
 * The session state: what the session resource and the `sessionState` of a
 * response report. State that belongs to a data type lives in `typeStates`
 * below, because a client reads the two independently and a server keeps them
 * apart.
 */
const state = { n: 1 };
const nextState = () => String(state.n++);

/**
 * State tokens, one per data type (and per `x:` registry type, keyed by its
 * method-name prefix).
 *
 * A real 0.16 server keeps a state per type: `Email/get` and `FileNode/get`
 * hand back two unrelated tokens, and a client watching mail never sees its
 * `Email` state move because somebody uploaded a file. One counter for every
 * type makes the two indistinguishable -- and the agent's reconcile, which
 * walks `Email/changes` and `FileNode/changes` from separate recorded states
 * and writes back against the state it read (ADR 0003 and §6), cannot be
 * exercised against a mock that answers them from the same number.
 *
 * The tokens are per type but **not** per account: a real server scopes them
 * per account as well, and the mock does not, because the account dimension
 * would have to be threaded through every handler that stamps a state for a
 * difference no single-account test can observe. The direction of that
 * dishonesty is the safe one for compare-and-set: a write in one account moves
 * the token every account of that type sees, so a conditional write can be
 * refused that a real server would have accepted -- never accepted that a real
 * server would have refused.
 */
const typeStates = new Map<string, number>();
/** One data type's state, without moving it. */
const stateOf = (type: string): string => String(typeStates.get(type) ?? 1);
/** Move one data type's state on by one. */
function bumpState(type: string): void {
  typeStates.set(type, (typeStates.get(type) ?? 1) + 1);
}

/* ---------- data ---------- */
/*
 * The names are Stalwart's own defaults, which follow the Exchange convention:
 * "Deleted Items" and "Sent Items", not "Trash" and "Sent". The mock used the
 * short forms, so anything built from a folder's name read differently here
 * than in production -- "Empty Trash" against the mock, "Empty Deleted Items"
 * against a real server -- and every screenshot in the README showed a folder
 * list no user has. The role is what the client branches on; the name is only
 * ever displayed, which is exactly why it has to look right.
 */
/** Push subscriptions, as a fresh account has none. */
const pushSubscriptions: Obj[] = [];

const mailboxes: Obj[] = [
  mb("inbox", "Inbox", "inbox"),
  mb("drafts", "Drafts", "drafts"),
  mb("sent", "Sent Items", "sent"),
  mb("junk", "Junk Mail", "junk"),
  mb("trash", "Deleted Items", "trash"),
  mb("archive", "Archive", "archive"),
  mb("work", "Work", null),
  mb("work-inv", "Invoices", null, "work"),
  mb("news", "Newsletters", null),
];
function mb(
  id: string,
  name: string,
  role: string | null,
  parentId: string | null = null,
): Obj {
  return {
    id,
    name,
    parentId,
    role,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
  };
}

const blobs = new Map<string, { type: string; data: Buffer }>();
function putBlob(data: Buffer | string, type: string): string {
  const id = `b${randomUUID().slice(0, 8)}`;
  blobs.set(id, { type, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  return id;
}

const people = [
  ["Ada Lovelace", "ada@example.org"],
  ["Grace Hopper", "grace@example.org"],
  ["Linus Torvalds", "linus@kernel.example"],
  ["Margaret Hamilton", "margaret@nasa.example"],
  ["Alan Turing", "alan@bletchley.example"],
  ["GitHub", "noreply@github.example"],
  ["Stalwart Labs", "hello@stalw.art"],
  ["Weekly Digest", "digest@newsletter.example"],
  ["Finance Team", "finance@example.org"],
];
const subjects = [
  "Re: Q3 planning document",
  "Your invoice #4821 is ready",
  "Welcome to Stalwart!",
  "Lunch on Thursday?",
  "[PR] Fix push reconnect backoff",
  "Weekly digest: 12 new articles",
  "Photos from the hike",
  "Deployment window this weekend",
  "Contract draft v3 attached",
  "Can you review my slides?",
  "Reminder: dentist appointment",
  "Flight confirmation – BOS → SFO",
  "Team offsite agenda",
  "Re: Re: budget approval",
  "Security notice: new sign-in",
];
const emails: Obj[] = [];
let counter = 1;
/**
 * A real TNEF blob, built to the format description, so the winmail.dat
 * decoder has something to open that is not a hand-made fixture in its own
 * test file. Two files inside, one of them carrying a long name in the MAPI
 * stream behind an 8.3 title -- which is the case the decoder exists for.
 */
function winmailDat(): Buffer {
  const u16 = (v: number) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) =>
    Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const sum = (b: Buffer) => {
    let n = 0;
    for (const x of b) n = (n + x) & 0xffff;
    return n;
  };
  const attr = (level: number, id: number, data: Buffer) =>
    Buffer.concat([
      Buffer.from([level]),
      u32(id),
      u32(data.length),
      data,
      u16(sum(data)),
    ]);
  const asciiProp = (id: number, value: string) => {
    const bytes = Buffer.concat([Buffer.from(value, "latin1"), Buffer.from([0])]);
    const pad = Buffer.alloc((4 - (bytes.length % 4)) % 4);
    return Buffer.concat([
      u32(((id & 0xffff) << 16) | 0x001e),
      u32(bytes.length),
      bytes,
      pad,
    ]);
  };
  const mapi = (props: Buffer[]) => Buffer.concat([u32(props.length), ...props]);

  const renddata = Buffer.alloc(14);
  const title = (n: string) =>
    Buffer.concat([Buffer.from(n, "latin1"), Buffer.from([0])]);
  const notes = Buffer.from(
    "Numbers pulled from the mock, not from anywhere real.\n",
    "latin1",
  );
  const csv = Buffer.from("quarter,revenue\nQ1,120\nQ2,145\n", "latin1");

  return Buffer.concat([
    u32(0x223e9f78),
    u16(0x1234),
    attr(1, 0x00089006, u32(0x00010000)), // attTnefVersion
    attr(2, 0x00069002, renddata),
    attr(2, 0x00018010, title("QUARTE~1.CSV")),
    attr(
      2,
      0x00069005,
      mapi([
        asciiProp(0x3707, "Quarterly Revenue Final.csv"),
        asciiProp(0x370e, "text/csv"),
      ]),
    ),
    attr(2, 0x0006800f, csv),
    attr(2, 0x00069002, renddata),
    attr(2, 0x00018010, title("notes.txt")),
    attr(2, 0x0006800f, notes),
  ]);
}

/**
 * A really signed message, served as the raw blob a client verifies against.
 *
 * The signature is over exact bytes, so this deliberately does not go through
 * addEmail: that builds a message out of parts and would hand back a body it
 * had assembled rather than the one that was signed. Here the blob *is* the
 * fixture, byte for byte, and the JMAP metadata is arranged around it.
 *
 * `bodyStructure` says multipart/signed because that is what the client checks
 * before deciding to download anything -- a mock that omitted it would leave
 * the whole path unreachable while every stored byte was still correct.
 */
function addSignedEmail(o: {
  which: keyof typeof SIGNED_MESSAGES;
  from: [string, string];
  subject: string;
  daysAgo: number;
  mailbox: string;
  unread?: boolean;
}) {
  const id = `e${counter++}`;
  const raw = signedMessage(o.which);
  const received = new Date(now() - o.daysAgo * 86400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const body = "The Analytical Engine has no pretensions whatever to originate anything.";
  const textBlob = putBlob(body, "text/plain");
  const e: Obj = {
    id,
    blobId: putBlob(raw, "message/rfc822"),
    threadId: `t${id}`,
    mailboxIds: { [o.mailbox]: true },
    keywords: o.unread ? {} : { $seen: true },
    size: raw.length,
    receivedAt: received,
    sentAt: received,
    messageId: [`${id}@mock`],
    inReplyTo: null,
    references: null,
    from: [{ name: o.from[0], email: o.from[1] }],
    to: [{ name: "Demo User", email: USER }],
    cc: null,
    bcc: null,
    replyTo: null,
    sender: null,
    subject: o.subject,
    hasAttachment: false,
    preview: body.slice(0, 120),
    textBody: [
      {
        partId: "1",
        blobId: textBlob,
        size: body.length,
        name: null,
        type: "text/plain",
        charset: "utf-8",
        disposition: null,
        cid: null,
      },
    ],
    htmlBody: [],
    attachments: [],
    bodyValues: { "1": { value: body, isEncodingProblem: false, isTruncated: false } },
    bodyStructure: {
      partId: null,
      blobId: null,
      size: raw.length,
      type: "multipart/signed",
      name: null,
      charset: null,
      disposition: null,
      cid: null,
      subParts: [
        {
          partId: "1",
          blobId: textBlob,
          size: body.length,
          type: "text/plain",
          name: null,
          charset: "utf-8",
          disposition: null,
          cid: null,
        },
        {
          partId: "2",
          blobId: null,
          size: 0,
          type: "application/x-pkcs7-signature",
          name: "smime.p7s",
          charset: null,
          disposition: "attachment",
          cid: null,
        },
      ],
    },
  };
  emails.push(e);
  return e;
}

/*
 * A marketing template of the shape #290 was reported against.
 *
 * Nothing in it is unusual — an outer 600px wrapper on `bgcolor="#ffffff"`, a
 * `<style>` block, a coloured call to action, a grey footer — and that is the
 * point. Every one of those is enough to make `htmlDeclaresColors` true, so a
 * mock without one could not show what "apply the theme to messages too" does
 * to the mail people actually receive: nothing at all.
 */
const STYLED_MARKETING_HTML = `<html><head><style>
  a { color:#1155CC; text-decoration:underline }
  .h { font-size:20px; color:#111111 }
</style></head><body style="margin:0;background-color:#f4f4f4">
<table width="100%" bgcolor="#f4f4f4" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table width="600" bgcolor="#ffffff" cellpadding="0" cellspacing="0" style="background-color:#ffffff">
    <tr><td style="padding:24px"><p class="h">Your order is on its way</p>
      <p style="color:#333333">Thanks for shopping with us. Your parcel left the warehouse this morning.</p>
      <table cellpadding="0" cellspacing="0"><tr>
        <td bgcolor="#1155CC" style="border-radius:4px;padding:12px 20px">
          <a href="https://example.com/track" style="color:#FFFFFF;text-decoration:none">Track your parcel</a>
        </td></tr></table>
      <p style="color:#666666;font-size:12px">Order #4471 &middot; placed 2 September</p>
    </td></tr>
    <tr><td bgcolor="#222222" style="padding:16px;color:#dddddd;font-size:12px">
      You are receiving this because you bought something. <a href="https://example.com/x" style="color:#88bbff">Unsubscribe</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;

function addEmail(o: {
  from: [string, string];
  to?: string;
  subject: string;
  daysAgo: number;
  mailbox: string;
  threadId?: string;
  unread?: boolean;
  flagged?: boolean;
  html?: boolean;
  styled?: boolean;
  attach?: boolean;
  winmail?: boolean;
  inReplyTo?: string;
  /** The list to push onto; the demo account's `emails` by default. */
  into?: Obj[];
}) {
  const id = `e${counter++}`;
  const received = new Date(now() - o.daysAgo * 86400_000 - Math.random() * 3600_000 * 5)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const text = `Hi,\n\nThis is a sample message about "${o.subject}". It was generated by the Gilbert mock server so you can try the interface without a real mailbox.\n\nSome highlights:\n- Keyboard shortcuts (press ? )\n- Conversation view\n- Drag & drop to folders\n\nCheers,\n${o.from[0]}\n\n> On Monday, someone wrote:\n> This is the quoted part of an earlier message.\n> It should be collapsed by default.`;
  const html = `<html><body style="font-family:Arial"><p>Hi,</p><p>This is a <b>sample HTML message</b> about “${o.subject}”. It was generated by the Gilbert mock server.</p><ul><li>Keyboard shortcuts (press ?)</li><li>Conversation view</li><li><a href="https://stalw.art">Drag &amp; drop</a> to folders</li></ul><p><img src="https://example.com/tracker.gif" width="1" height="1" alt=""> <img src="cid:logo@mock" width="120" alt="logo"></p><p>Cheers,<br>${o.from[0]}</p><div class="gmail_quote">On Monday, someone wrote:<blockquote>This is the quoted part of an earlier message. It should be collapsed by default.</blockquote></div></body></html>`;
  const textBlob = putBlob(text, "text/plain");
  const shown = o.styled ? STYLED_MARKETING_HTML : html;
  const htmlBlob = putBlob(shown, "text/html");
  const attachments: Obj[] = [];
  if (o.attach) {
    attachments.push({
      partId: "3",
      blobId: putBlob("%PDF-1.4 mock", "application/pdf"),
      size: 48213,
      name: "contract-v3.pdf",
      type: "application/pdf",
      charset: null,
      disposition: "attachment",
      cid: null,
    });
    attachments.push({
      partId: "4",
      blobId: putBlob(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
        "image/png",
      ),
      size: 68,
      name: "pixel.png",
      type: "image/png",
      charset: null,
      disposition: "attachment",
      cid: null,
    });
  }
  if (o.winmail) {
    const dat = winmailDat();
    attachments.push({
      partId: "6",
      blobId: putBlob(dat, "application/ms-tnef"),
      size: dat.length,
      name: "winmail.dat",
      type: "application/ms-tnef",
      charset: null,
      disposition: "attachment",
      cid: null,
    });
  }
  if (o.html)
    attachments.push({
      partId: "5",
      blobId: putBlob(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
          "base64",
        ),
        "image/png",
      ),
      size: 68,
      name: "logo.png",
      type: "image/png",
      charset: null,
      disposition: "inline",
      cid: "logo@mock",
    });
  const e: Obj = {
    id,
    blobId: putBlob(
      `From: ${o.from[0]} <${o.from[1]}>\r\nTo: ${USER}\r\nSubject: ${o.subject}\r\nDate: ${received}\r\nMessage-ID: <${id}@mock>\r\n\r\n${text}`,
      "message/rfc822",
    ),
    threadId: o.threadId ?? `t${id}`,
    mailboxIds: { [o.mailbox]: true },
    keywords: {
      ...(o.unread ? {} : { $seen: true }),
      ...(o.flagged ? { $flagged: true } : {}),
    },
    size: 4000 + Math.floor(Math.random() * 20000),
    receivedAt: received,
    sentAt: received,
    messageId: [`${id}@mock`],
    inReplyTo: o.inReplyTo ? [o.inReplyTo] : null,
    references: o.inReplyTo ? [o.inReplyTo] : null,
    from: [{ name: o.from[0], email: o.from[1] }],
    to: [{ name: "Demo User", email: o.to ?? USER }],
    cc: null,
    bcc: null,
    replyTo: null,
    sender: null,
    subject: o.subject,
    hasAttachment: Boolean(o.attach),
    preview: text.slice(0, 120).replace(/\n/g, " "),
    textBody: [
      {
        partId: "1",
        blobId: textBlob,
        size: text.length,
        name: null,
        type: "text/plain",
        charset: "utf-8",
        disposition: null,
        cid: null,
      },
    ],
    htmlBody: o.html
      ? [
          {
            partId: "2",
            blobId: htmlBlob,
            size: shown.length,
            name: null,
            type: "text/html",
            charset: "utf-8",
            disposition: null,
            cid: null,
          },
        ]
      : [],
    attachments,
    bodyValues: {
      "1": { value: text, isEncodingProblem: false, isTruncated: false },
      ...(o.html
        ? {
            "2": { value: shown, isEncodingProblem: false, isTruncated: false },
          }
        : {}),
    },
    bodyStructure: {
      partId: null,
      blobId: null,
      size: 0,
      type: "multipart/mixed",
      name: null,
      charset: null,
      disposition: null,
      cid: null,
      subParts: [
        {
          partId: "1",
          blobId: textBlob,
          size: text.length,
          type: "text/plain",
          name: null,
          charset: "utf-8",
          disposition: null,
          cid: null,
        },
        ...(o.html
          ? [
              {
                partId: "2",
                blobId: htmlBlob,
                size: shown.length,
                type: "text/html",
                name: null,
                charset: "utf-8",
                disposition: null,
                cid: null,
              },
            ]
          : []),
        ...attachments,
      ],
    },
    "header:List-Unsubscribe:asText": o.from[1].includes("newsletter")
      ? "<mailto:unsub@newsletter.example?subject=unsubscribe>, <https://newsletter.example/unsub>"
      : null,
    "header:X-Priority:asText": o.subject.startsWith("Security") ? "1 (Highest)" : null,
    // Stalwart's spam filter writes the SpamAssassin-shaped set at delivery, so
    // delivered mail carries it and mail this account wrote does not.
    "header:X-Spam-Status:asText":
      o.mailbox === "junk"
        ? "Yes, score=14.2 required=5.0 tests=[BAYES_99=3.5, URIBL_BLOCKED=2.7, HTML_IMAGE_ONLY=1.4, SUBJ_ALL_CAPS=1.2, FROM_FREEMAIL=0.4] autolearn=no"
        : o.mailbox === "inbox"
          ? "No, score=-1.8 required=5.0 tests=[BAYES_00=-1.9, DKIM_VALID=-0.7, SPF_PASS=-0.1, HTML_MESSAGE=0.9]"
          : null,
  };
  (o.into ?? emails).push(e);
  return e;
}

/**
 * A raw message as the fields a JMAP filter and a mail view read.
 *
 * A server builds an Email object out of the message text; the mock needs the
 * part of that a filter matches on and a reader sees, and nothing more. This
 * reads unfolded RFC 5322 headers and one text body -- everything before a
 * message's first MIME boundary, or the first `text/plain` part when it
 * declares one.
 *
 * What it does not do, and a real server does: decode encoded words
 * (`=?utf-8?…?=`), decode a quoted-printable or base64 body, honour a
 * character set, walk nested parts, or recognise attachments (the importer
 * records none). A message written that way is imported here as its literal
 * bytes. A comma inside a quoted display name also splits the wrong way: the
 * address list is cut on commas alone.
 */
function parseRawMessage(raw: string): {
  subject: string | null;
  from: Obj[] | null;
  to: Obj[] | null;
  cc: Obj[] | null;
  messageId: string | null;
  text: string;
} {
  const [head = "", ...rest] = raw.split(/\r?\n\r?\n/);
  const body = rest.join("\n\n");
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/)) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (m) {
      headers.set(m[1]!.toLowerCase(), m[2]!);
      continue;
    }
    // A folded continuation belongs to the header above it.
    const last = [...headers.keys()].pop();
    if (last && /^[ \t]/.test(line))
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
  }
  const addresses = (value: string | undefined): Obj[] | null =>
    value === undefined
      ? null
      : value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const m = /^(.*)<([^>]*)>$/.exec(part);
            if (!m) return { name: null, email: part };
            const name = m[1]!.trim().replace(/^"|"$/g, "");
            return { name: name || null, email: m[2]!.trim() };
          });

  const type = headers.get("content-type") ?? "";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  let text = body;
  if (boundary) {
    const part = body
      .split(`--${boundary}`)
      .slice(1)
      .find((p) => /^content-type:\s*text\/plain/im.test(p.trimStart()));
    text = (part ?? "").replace(/^[\s\S]*?\r?\n\r?\n/, "");
  }
  return {
    subject: headers.get("subject") ?? null,
    from: addresses(headers.get("from")),
    to: addresses(headers.get("to")),
    cc: addresses(headers.get("cc")),
    messageId: headers.get("message-id")?.replace(/^<|>$/g, "") ?? null,
    text: text.trimEnd(),
  };
}

// Seed
for (let i = 0; i < 45; i++) {
  const p = people[i % people.length]!;
  const subj = subjects[i % subjects.length]!;
  const e = addEmail({
    from: [p[0]!, p[1]!],
    subject: subj,
    daysAgo: i * 0.7,
    mailbox: i % 9 === 8 ? "news" : i % 11 === 10 ? "work" : "inbox",
    unread: i % 3 === 0,
    flagged: i % 7 === 0,
    html: i % 2 === 0,
    attach: i % 5 === 0,
  });
  if (i % 4 === 0) {
    // thread replies
    addEmail({
      from: ["Demo User", USER],
      to: p[1]!,
      subject: `Re: ${subj}`,
      daysAgo: i * 0.7 - 0.2,
      mailbox: "sent",
      threadId: e.threadId as string,
      inReplyTo: `${e.id}@mock`,
      html: true,
    });
    addEmail({
      from: [p[0]!, p[1]!],
      subject: `Re: ${subj}`,
      daysAgo: i * 0.7 - 0.4,
      mailbox: "inbox",
      threadId: e.threadId as string,
      unread: i % 8 === 0,
      inReplyTo: `${e.id}@mock`,
      html: i % 3 === 0,
    });
  }
}
addEmail({
  from: ["Shop Updates", "orders@example.com"],
  subject: "Your order is on its way",
  daysAgo: 0.3,
  mailbox: "inbox",
  html: true,
  styled: true,
});
addEmail({
  from: ["Demo User", USER],
  to: "ada@example.org",
  subject: "Draft: ideas for the retreat",
  daysAgo: 0.1,
  mailbox: "drafts",
  html: true,
}).keywords = { $draft: true, $seen: true };
addEmail({
  from: ["Spammy", "win@lottery.example"],
  subject: "You have WON!!!",
  daysAgo: 2,
  mailbox: "junk",
  unread: true,
});
addEmail({
  from: ["Outlook User", "sales@partner.example"],
  subject: "Q3 figures (sent from Outlook)",
  daysAgo: 1,
  mailbox: "inbox",
  unread: true,
  winmail: true,
});
addEmail({
  from: ["Finance Team", "finance@example.org"],
  subject: "Invoice 2201 approved",
  daysAgo: 1,
  mailbox: "work-inv",
  unread: true,
});
addEmail({
  from: ["Finance Team", "finance@example.org"],
  subject: "Invoice 2202 pending",
  daysAgo: 2,
  mailbox: "work-inv",
  unread: true,
});

/*
 * Three signed messages, so every branch of the signature banner can be seen
 * without staging a certificate authority. Read "A note" first: that pins Ada's
 * certificate, after which the other two have something to disagree with.
 */
addSignedEmail({
  which: "good",
  from: ["Ada Lovelace", "ada@example.com"],
  subject: "A note",
  daysAgo: 0.2,
  mailbox: "inbox",
  unread: true,
});
addSignedEmail({
  which: "tampered",
  from: ["Ada Lovelace", "ada@example.com"],
  subject: "A note (altered in transit)",
  daysAgo: 0.25,
  mailbox: "inbox",
  unread: true,
});
addSignedEmail({
  which: "imposter",
  from: ["Ada Lovelace", "ada@example.com"],
  subject: "A note (signed by somebody else)",
  daysAgo: 0.3,
  mailbox: "inbox",
  unread: true,
});

// A thread whose unread message is not the last one: someone's server queued
// their reply for hours, so it landed after messages that answer it and sits in
// the middle of the conversation. Opening this thread at the newest message
// left that reply above the fold until the mark-read timer swept it (#87).
{
  const subj = "Compiler timings for the release";
  const t = addEmail({
    from: ["Grace Hopper", "grace@example.org"],
    subject: subj,
    daysAgo: 6,
    mailbox: "inbox",
    html: true,
  });
  const tid = t.threadId as string;
  const reply = (o: {
    from: [string, string];
    daysAgo: number;
    mailbox: string;
    to?: string;
    unread?: boolean;
    html?: boolean;
  }) =>
    addEmail({ ...o, subject: `Re: ${subj}`, threadId: tid, inReplyTo: `${t.id}@mock` });
  reply({
    from: ["Alan Turing", "alan@example.org"],
    daysAgo: 5.5,
    mailbox: "inbox",
    unread: true,
  });
  // Long enough after the unread one that the thread scrolls: opening at the
  // bottom put four messages between the reader and the mail they had not read.
  reply({
    from: ["Demo User", USER],
    to: "grace@example.org",
    daysAgo: 5,
    mailbox: "sent",
    html: true,
  });
  reply({ from: ["Grace Hopper", "grace@example.org"], daysAgo: 4.5, mailbox: "inbox" });
  reply({
    from: ["Margaret Hamilton", "margaret@example.org"],
    daysAgo: 4,
    mailbox: "inbox",
    html: true,
  });
  reply({
    from: ["Demo User", USER],
    to: "margaret@example.org",
    daysAgo: 3.5,
    mailbox: "sent",
  });
  reply({
    from: ["Grace Hopper", "grace@example.org"],
    daysAgo: 3,
    mailbox: "inbox",
    html: true,
  });
}
// Invitation email
{
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//mock//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:inv-1@mock\r\nDTSTAMP:20260820T100000Z\r\nDTSTART:20260825T140000Z\r\nDTEND:20260825T150000Z\r\nSUMMARY:Project kickoff\r\nORGANIZER;CN=Ada Lovelace:mailto:ada@example.org\r\nATTENDEE;CN=Demo User;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${USER}\r\nLOCATION:Room 4B\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const e = addEmail({
    from: ["Ada Lovelace", "ada@example.org"],
    subject: "Invitation: Project kickoff",
    daysAgo: 0.3,
    mailbox: "inbox",
    unread: true,
  });
  const b = putBlob(ics, "text/calendar");
  (e.bodyStructure as Obj).subParts = [
    ...((e.bodyStructure as Obj).subParts as Obj[]),
    {
      partId: "9",
      blobId: b,
      size: ics.length,
      type: "text/calendar",
      name: "invite.ics",
      charset: "utf-8",
      disposition: "attachment",
      cid: null,
    },
  ];
  (e.attachments as Obj[]).push({
    partId: "9",
    blobId: b,
    size: ics.length,
    type: "text/calendar",
    name: "invite.ics",
    charset: "utf-8",
    disposition: "attachment",
    cid: null,
  });
  e.hasAttachment = true;
}

const identities: Obj[] = [
  {
    id: "i1",
    name: "Demo User",
    email: USER,
    replyTo: null,
    bcc: null,
    textSignature: "-- \nDemo User\nGilbert",
    htmlSignature: "<div>-- <br><b>Demo User</b><br>Gilbert</div>",
    mayDelete: false,
  },
  {
    id: "i2",
    name: "Demo (alias)",
    email: "alias@example.com",
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  },
];
let vacation: Obj = {
  id: "singleton",
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: null,
  textBody: null,
  htmlBody: null,
};
const sieveScripts: Obj[] = [];
/* A calendar in the shared account, so "Shared with me" and a colleague's
   events appearing in the grid can be exercised. Read-only, as a share is. */
const sharedCalendars: Obj[] = [
  {
    id: "c9",
    name: "Grace — Work",
    description: null,
    color: "#c084fc",
    sortOrder: 0,
    isSubscribed: false,
    isVisible: true,
    isDefault: true,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: "UTC",
    shareWith: {},
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: false,
      mayWriteOwn: false,
      mayUpdatePrivate: false,
      mayRSVP: false,
      mayShare: false,
      mayDelete: false,
    },
  },
];
const sharedEvents: Obj[] = [];
/* A group (team) account the demo user is a member of: its own mailbox, and
   -- unlike a person who shared a folder -- the calendars, address books and
   files the team keeps. Only the mailbox is eager (sidebar counts); the other
   panes discover the rest the way they discover a2's shares. */
const groupMailboxes: Obj[] = [
  mb("g-inbox", "Inbox", "inbox"),
  mb("g-sent", "Sent Items", "sent"),
];
const groupEmails: Obj[] = [
  {
    id: "ge1",
    blobId: putBlob(
      "Subject: Welcome to the team mailbox\r\n\r\nHello from the group!",
      "message/rfc822",
    ),
    threadId: "gt1",
    mailboxIds: { "g-inbox": true },
    keywords: { $seen: false },
    size: 128,
    receivedAt: new Date(now()).toISOString(),
    subject: "Welcome to the team mailbox",
    from: [{ name: "Ada Lovelace", email: "ada@example.org" }],
    to: [{ name: "Team", email: "team@example.org" }],
    preview: "Hello from the group!",
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    messageId: ["ge1@mock"],
  },
];
/* More of the group's mail, through the same builder the demo account's own
   mail uses, so opening a message shows a real body rather than an empty
   pane. Counts are recomputed by recount() below, whichever folders the mail
   lands in. */
addEmail({
  from: ["Grace Hopper", "grace@example.org"],
  subject: "Q3 planning document",
  daysAgo: 0.5,
  mailbox: "g-inbox",
  unread: true,
  html: true,
  into: groupEmails,
});
addEmail({
  from: ["Team", "team@example.org"],
  to: "ada@example.org",
  subject: "Re: Q3 planning document",
  daysAgo: 1.2,
  mailbox: "g-sent",
  html: true,
  into: groupEmails,
});
const groupIdentities: Obj[] = [
  {
    id: "gi1",
    name: "Team",
    email: "team@example.org",
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: false,
  },
];
/* The impersonation target's own identities (ADR 0007). An administrator edits
   a person's list from their own session, so the list has to be one the next
   `Identity/get` sees: a fresh literal per call would answer 200 and change
   nothing, which is the failure the per-account lists above exist to avoid. */
const targetIdentities: Obj[] = [
  {
    id: "bi1",
    name: "Bob",
    email: TARGET_USER,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: true,
  },
];
/* The second group (design@example.org) the demo user belongs to, so the
   chat panel has two teams to switch between. Leaner than the first: an
   empty folder tree that answers the mailbox probe, one welcome message, an
   identity, and its own Files for chat. */
const group2Mailboxes: Obj[] = [mb("d-inbox", "Inbox", "inbox")];
const group2Emails: Obj[] = [
  {
    id: "de1",
    blobId: putBlob(
      "Subject: Welcome to the design mailbox\r\n\r\nHello from the design group!",
      "message/rfc822",
    ),
    threadId: "dt1",
    mailboxIds: { "d-inbox": true },
    keywords: { $seen: false },
    size: 128,
    receivedAt: new Date(now()).toISOString(),
    subject: "Welcome to the design mailbox",
    from: [{ name: "Margaret Hamilton", email: "margaret@nasa.example" }],
    to: [{ name: "Design", email: "design@example.org" }],
    preview: "Hello from the design group!",
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    messageId: ["de1@mock"],
  },
];
const group2Identities: Obj[] = [
  {
    id: "di1",
    name: "Design",
    email: "design@example.org",
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: false,
  },
];
/*
 * The agent principal's own account (ADR 0003).
 *
 * A real account of the directory ships its own mailbox tree and its own
 * identity, so the mock gives it both: mail addressed to the agent is ordinary
 * mail that lands in the agent's inbox and wakes it like any other state
 * change. What it deliberately does NOT ship is another account's data: its
 * calendars, address books, cards and Files start empty, because a group agent
 * works in the group's own account, and because the mock seeds nothing the
 * code under test is supposed to create itself -- the `gilbert/agent` folder
 * appears when the store writes its first document through `FileNode/set`.
 */
const agentMailboxes: Obj[] = [
  mb("inbox", "Inbox", "inbox"),
  mb("drafts", "Drafts", "drafts"),
  mb("sent", "Sent Items", "sent"),
  mb("junk", "Junk Mail", "junk"),
  mb("trash", "Deleted Items", "trash"),
];
const agentEmails: Obj[] = [];
const agentIdentities: Obj[] = [
  {
    id: "ai1",
    name: "Gilbert",
    email: AGENT_ADDRESS,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: "",
    mayDelete: false,
  },
];
/*
 * Mail per account. A group (team) mailbox carries its own folder tree,
 * messages and identity; the account that shared calendars, address books and
 * files carries none -- a person who shared a folder is not a mailbox the
 * reader can open. Whether a real 0.16 server answers Mailbox/get on a
 * folder-share account this way is unverified (mail folder sharing is
 * withdrawn there, and the sharee's session lists the sharer's whole account);
 * the mock says no so the two kinds stay apart, and the client's mailbox
 * probe lists only the accounts that answer with a tree.
 *
 * The target principal (ADR 0001) is a fresh account: it has its own Files
 * (see `targetFileNodes`) and nothing else yet. The agent principal has the
 * mailbox and identity an account of the directory has, and nothing else.
 */
const mailboxesFor = (accountId: unknown): Obj[] =>
  accountId === GROUP_ACCOUNT
    ? groupMailboxes
    : accountId === GROUP2_ACCOUNT
      ? group2Mailboxes
      : accountId === AGENT_ACCOUNT
        ? agentMailboxes
        : accountId === SHARED_ACCOUNT || accountId === TARGET_ACCOUNT
          ? []
          : mailboxes;
const emailsFor = (accountId: unknown): Obj[] =>
  accountId === GROUP_ACCOUNT
    ? groupEmails
    : accountId === GROUP2_ACCOUNT
      ? group2Emails
      : accountId === AGENT_ACCOUNT
        ? agentEmails
        : accountId === SHARED_ACCOUNT || accountId === TARGET_ACCOUNT
          ? []
          : emails;
const identitiesFor = (accountId: unknown): Obj[] =>
  accountId === GROUP_ACCOUNT
    ? groupIdentities
    : accountId === GROUP2_ACCOUNT
      ? group2Identities
      : accountId === AGENT_ACCOUNT
        ? agentIdentities
        : accountId === TARGET_ACCOUNT
          ? targetIdentities
          : accountId === SHARED_ACCOUNT
            ? []
            : identities;
const groupCalendars: Obj[] = [
  {
    id: "gc1",
    name: "Team calendar",
    description: null,
    color: "#0d9488",
    sortOrder: 0,
    isSubscribed: false,
    isVisible: true,
    isDefault: true,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: "UTC",
    shareWith: {},
    myRights: rightsCal(),
  },
  {
    id: "gt1",
    name: "Team tasks",
    description: "tasklist",
    color: "#eab308",
    sortOrder: 1,
    isSubscribed: false,
    isVisible: true,
    isDefault: false,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: "UTC",
    shareWith: {},
    myRights: rightsCal(),
  },
];
const groupEvents: Obj[] = [];
const eventsFor = (accountId: unknown): Obj[] =>
  accountId === SHARED_ACCOUNT
    ? sharedEvents
    : accountId === GROUP_ACCOUNT
      ? groupEvents
      : accountId === GROUP2_ACCOUNT ||
          accountId === TARGET_ACCOUNT ||
          accountId === AGENT_ACCOUNT
        ? []
        : events;
const calendarsFor = (accountId: unknown): Obj[] =>
  accountId === SHARED_ACCOUNT
    ? sharedCalendars
    : accountId === GROUP_ACCOUNT
      ? groupCalendars
      : accountId === GROUP2_ACCOUNT ||
          accountId === TARGET_ACCOUNT ||
          accountId === AGENT_ACCOUNT
        ? []
        : calendars;
const calendars: Obj[] = [
  {
    id: "c1",
    name: "Personal",
    description: null,
    color: "#0f766e",
    sortOrder: 0,
    isSubscribed: true,
    isVisible: true,
    isDefault: true,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: "UTC",
    shareWith: null,
    myRights: rightsCal(),
  },
  {
    id: "c2",
    name: "Work",
    description: null,
    color: "#2563eb",
    sortOrder: 1,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: "UTC",
    shareWith: null,
    myRights: rightsCal(),
  },
  {
    id: "t1",
    name: "Tasks",
    description: "tasklist",
    color: "#7c3aed",
    sortOrder: 2,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    includeInAvailability: "all",
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: "UTC",
    shareWith: null,
    myRights: rightsCal(),
  },
];
function rightsCal() {
  return {
    mayReadFreeBusy: true,
    mayReadItems: true,
    mayWriteAll: true,
    mayWriteOwn: true,
    mayUpdatePrivate: true,
    mayRSVP: true,
    mayShare: true,
    mayDelete: true,
  };
}
const events: Obj[] = [];
{
  const now = new Date();
  const d = (dayOff: number, h: number) => {
    const x = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOff,
      h,
      0,
      0,
    );
    return x;
  };
  const local = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T${String(x.getHours()).padStart(2, "0")}:00:00`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  events.push({
    id: "ev1",
    calendarIds: { c1: true },
    "@type": "Event",
    uid: "ev1",
    title: "Standup",
    start: local(d(0, 9)),
    timeZone: tz,
    duration: "PT30M",
    recurrenceRule: {
      "@type": "RecurrenceRule",
      frequency: "weekly",
      byDay: [{ day: "mo" }, { day: "tu" }, { day: "we" }, { day: "th" }, { day: "fr" }],
    },
    showWithoutTime: false,
    status: "confirmed",
    freeBusyStatus: "busy",
    privacy: "public",
  });
  events.push({
    id: "ev2",
    calendarIds: { c2: true },
    "@type": "Event",
    uid: "ev2",
    title: "Design review",
    start: local(d(1, 14)),
    timeZone: tz,
    duration: "PT1H30M",
    showWithoutTime: false,
    locations: { l: { "@type": "Location", name: "Room 2" } },
    participants: {
      me: {
        "@type": "Participant",
        name: "Demo User",
        calendarAddress: `mailto:${USER}`,
        roles: { owner: true, attendee: true },
        participationStatus: "accepted",
      },
      p2: {
        "@type": "Participant",
        name: "Ada Lovelace",
        calendarAddress: "mailto:ada@example.org",
        roles: { attendee: true, required: true },
        participationStatus: "needs-action",
        expectReply: true,
      },
    },
    organizerCalendarAddress: `mailto:${USER}`,
  });
  events.push({
    id: "ev3",
    calendarIds: { c1: true },
    "@type": "Event",
    uid: "ev3",
    title: "Conference",
    start: `${local(d(3, 0)).slice(0, 10)}T00:00:00`,
    duration: "P2D",
    showWithoutTime: true,
    timeZone: null,
  });
  /*
   * One event in a zone that is not the reader's, because every other fixture
   * here uses the machine's own and so cannot tell a correct conversion from
   * no conversion at all. Dragging this one is what proves a move keeps the
   * time the event says it happens at.
   */
  events.push({
    id: "ev9",
    calendarIds: { c1: true },
    "@type": "Event",
    uid: "ev9",
    title: "Tokyo sync",
    start: local(d(2, 15)),
    timeZone: "Asia/Tokyo",
    duration: "PT1H",
    showWithoutTime: false,
    color: "#7c3aed",
  });
  events.push({
    id: "ev4",
    calendarIds: { c1: true },
    "@type": "Event",
    uid: "ev4",
    title: "Lunch with Grace",
    start: local(d(2, 12)),
    timeZone: tz,
    duration: "PT1H",
    showWithoutTime: false,
    color: "#db2777",
  });
  // Two in the shared account, so a colleague's calendar has something in it.
  sharedEvents.push({
    id: "sv1",
    calendarIds: { c9: true },
    "@type": "Event",
    uid: "sv1",
    title: "Grace: release planning",
    start: local(d(1, 10)),
    timeZone: tz,
    duration: "PT1H",
    showWithoutTime: false,
    status: "confirmed",
    freeBusyStatus: "busy",
    privacy: "public",
  });
  sharedEvents.push({
    id: "sv2",
    calendarIds: { c9: true },
    "@type": "Event",
    uid: "sv2",
    title: "Grace: on leave",
    start: `${local(d(4, 0)).slice(0, 10)}T00:00:00`,
    duration: "P1D",
    showWithoutTime: true,
    timeZone: null,
  });
  groupEvents.push({
    id: "gv1",
    calendarIds: { gc1: true },
    "@type": "Event",
    uid: "gv1",
    title: "Team sync",
    start: local(d(2, 11)),
    timeZone: tz,
    duration: "PT45M",
    showWithoutTime: false,
    status: "confirmed",
    freeBusyStatus: "busy",
    privacy: "public",
  });
  events.push({
    id: "task1",
    calendarIds: { t1: true },
    "@type": "Task",
    uid: "task1",
    title: "Order office supplies",
    progress: "needs-action",
    due: `${local(d(3, 0)).slice(0, 10)}T00:00:00`,
    priority: 5,
  });
  groupEvents.push({
    id: "gtask1",
    calendarIds: { gt1: true },
    "@type": "Task",
    uid: "gtask1",
    title: "Prepare the shipping manifest",
    progress: "in-process",
    due: `${local(d(2, 0)).slice(0, 10)}T00:00:00`,
    priority: 1,
  });
}
const participantIdentities: Obj[] = [
  {
    id: "pi1",
    name: "Demo User",
    calendarAddress: `mailto:${USER}`,
    sendTo: { imip: `mailto:${USER}` },
    isDefault: true,
  },
];
const abRights = (write = true) => ({
  mayRead: true,
  mayWrite: write,
  mayShare: write,
  mayDelete: write,
});
const addressBooks: Obj[] = [
  {
    id: "ab1",
    name: "Personal",
    description: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: true,
    shareWith: {},
    myRights: abRights(),
  },
];
/* A book in the shared account, so "Shared with me" and addressing a message
   from somebody else's contacts can be exercised at all. Read-only, which is
   what a share usually is. */
const sharedAddressBooks: Obj[] = [
  {
    id: "ab9",
    name: "Team contacts",
    description: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    shareWith: {},
    myRights: abRights(false),
  },
];
const sharedCards: Obj[] = [
  {
    id: "sc1",
    addressBookIds: { ab9: true },
    name: { full: "Katherine Johnson" },
    emails: { e1: { address: "katherine@example.org", contexts: {} } },
    phones: {},
    organizations: {},
    nicknames: {},
    addresses: {},
    notes: {},
    updated: new Date(now()).toISOString(),
  },
  {
    id: "sc2",
    addressBookIds: { ab9: true },
    name: { full: "Dorothy Vaughan" },
    emails: { e1: { address: "dorothy@example.org", contexts: {} } },
    phones: {},
    organizations: {},
    nicknames: {},
    addresses: {},
    notes: {},
    updated: new Date(now()).toISOString(),
  },
];
/**
 * One sort property, as Email/query defines them. `hasKeyword` sorts a
 * boolean, and false comes before true -- which is what makes "unread first"
 * an *ascending* sort on $seen.
 */
function compareBy(x: Obj, y: Obj, property: string, keyword?: string): number {
  const addr = (v: unknown) =>
    String(((v as Obj[] | undefined)?.[0] as Obj | undefined)?.email ?? "");
  switch (property) {
    case "receivedAt":
      return String(x.receivedAt).localeCompare(String(y.receivedAt));
    case "sentAt":
      return String(x.sentAt ?? x.receivedAt).localeCompare(
        String(y.sentAt ?? y.receivedAt),
      );
    case "size":
      return Number(x.size ?? 0) - Number(y.size ?? 0);
    case "subject":
      return String(x.subject ?? "").localeCompare(String(y.subject ?? ""));
    case "from":
      return addr(x.from).localeCompare(addr(y.from));
    case "to":
      return addr(x.to).localeCompare(addr(y.to));
    case "hasKeyword": {
      const has = (e: Obj) =>
        keyword && (e.keywords as Obj | undefined)?.[keyword] ? 1 : 0;
      return has(x) - has(y);
    }
    default:
      return 0;
  }
}

/** A server that does not implement sorting on keywords, so the fallback can be developed against. */
const NO_KEYWORD_SORT = process.env.MOCK_NO_KEYWORD_SORT === "1";

/** The floor Stalwart puts under a requested EventSource ping interval. */
const PING_FLOOR_SECONDS = 30;

/*
 * An account that may not send calendar invitations.
 *
 * 0.16.21 rejects a `CalendarEvent/set` that asks for scheduling messages when
 * the account lacks the `calendarSchedulingSend` permission, rather than
 * accepting the write and quietly sending nothing. **Confirmed live on 0.16.21
 * (2026-09-06)** against an account holding a role with that permission
 * disabled: `sendSchedulingMessages: true` came back `notCreated` with
 * `forbidden` and the text below, while the identical request with the flag
 * false was created normally. Set MOCK_NO_SCHEDULING_SEND=1 to develop against
 * that account.
 */
const NO_SCHEDULING_SEND = process.env.MOCK_NO_SCHEDULING_SEND === "1";
const SCHEDULING_FORBIDDEN =
  "This account is not allowed to send calendar scheduling messages.";

const groupAddressBooks: Obj[] = [
  {
    id: "gab1",
    name: "Team directory",
    description: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    shareWith: {},
    myRights: abRights(true),
  },
];
const groupCards: Obj[] = [
  {
    id: "gs1",
    addressBookIds: { gab1: true },
    name: { full: "Marie Curie" },
    emails: { e1: { address: "marie@example.org", contexts: {} } },
    phones: {},
    organizations: {},
    nicknames: {},
    addresses: {},
    notes: {},
    updated: new Date(now()).toISOString(),
  },
  {
    id: "gs2",
    addressBookIds: { gab1: true },
    name: { full: "Niels Bohr" },
    emails: { e1: { address: "niels@example.org", contexts: {} } },
    phones: {},
    organizations: {},
    nicknames: {},
    addresses: {},
    notes: {},
    updated: new Date(now()).toISOString(),
  },
];
const booksFor = (accountId: unknown): Obj[] =>
  accountId === SHARED_ACCOUNT
    ? sharedAddressBooks
    : accountId === GROUP_ACCOUNT
      ? groupAddressBooks
      : accountId === GROUP2_ACCOUNT ||
          accountId === TARGET_ACCOUNT ||
          accountId === AGENT_ACCOUNT
        ? []
        : addressBooks;
/** One per contact, by index; a gap means that card has no birthday. */
const BIRTHDAYS: Array<{ year?: number; month: number; day: number } | null> = [
  { year: 1815, month: 12, day: 10 },
  { month: 6, day: 9 }, // no year: the common case
  { year: 1912, month: 6, day: 23 },
  null,
  { year: 2000, month: 2, day: 29 }, // lands on the 28th in a non-leap year
  { year: 1918, month: 8, day: 26 },
];

const cards: Obj[] = people.slice(0, 6).map((p, i) => {
  const [given, surname] = p[0]!.split(" ");
  return {
    id: `cc${i}`,
    addressBookIds: { ab1: true },
    "@type": "Card",
    version: "1.0",
    uid: `uid-cc${i}`,
    kind: "individual",
    name: {
      components: [
        { kind: "given", value: given },
        { kind: "surname", value: surname ?? "" },
      ],
      isOrdered: true,
    },
    emails: { e1: { address: p[1], contexts: { work: true } } },
    phones:
      i % 2
        ? { p1: { number: `+1 555 010${i}`, features: { mobile: true } } }
        : undefined,
    organizations: i % 3 ? { o1: { name: "Example Corp" } } : undefined,
    /*
     * Birthdays on most but not all of them, and one with no year, because a
     * card that records only a day and month is the common case rather than
     * the exceptional one.
     */
    anniversaries: BIRTHDAYS[i]
      ? {
          a1: {
            "@type": "Anniversary",
            kind: "birth",
            date: { "@type": "PartialDate", ...BIRTHDAYS[i] },
          },
        }
      : undefined,
  };
});
/**
 * The directory: every principal this server knows, which is what
 * `Principal/query` and `Principal/get` answer from. Exported so a test can
 * enlarge it: a directory larger than one page is the only way to exercise the
 * paging a reader of a real installation needs, and the mock's own handful of
 * principals fit in a single page.
 */
export const principals: Obj[] = people.slice(0, 5).map((p, i) => ({
  id: `pr${i}`,
  type: "individual",
  name: p[0],
  description: null,
  email: p[1],
  timeZone: "UTC",
}));
// A principal the directory lists and the mock will not seal a session onto,
// so the publish's "one account refused, the rest written" branch is reachable
// here (see `REFUSED_USER`). It sits before the agent principal in the
// directory on purpose: a fan-out that stopped at the refusal would leave the
// accounts after it -- the agent's own among them -- without the policy.
// Present only when the environment names it.
if (REFUSED_USER)
  principals.push({
    id: "pr-refused",
    type: "individual",
    name: "Refused Account",
    description: null,
    email: REFUSED_USER,
    timeZone: "UTC",
  });
// Group principals, so the directory and the sharing pickers can offer
// teams. The demo user is a member of `team@example.org` (its account is in
// the demo session below); `design@example.org` is the agent's own group, which
// the demo is not a member of and still administers through the agent's grant;
// `legal@example.org` is a group neither holds, for the surfaces that must
// refuse (ADR 0005, ADR 0003 "Admin surfaces").
principals.push(
  {
    id: "pr-team",
    type: "group",
    name: "Team",
    description: null,
    email: "team@example.org",
    timeZone: "UTC",
  },
  {
    id: "pr-legal",
    type: "group",
    name: "Legal",
    description: null,
    email: "legal@example.org",
    timeZone: "UTC",
  },
);
// The agent principal, a directory account like any other: it can be found in
// the directory, mentioned in a group chat and impersonated by an admin who
// manages it (ADR 0003 and the v1 scope).
principals.push({
  id: "pr-agent",
  type: "individual",
  name: "Gilbert",
  description: null,
  email: AGENT_ADDRESS,
  timeZone: "UTC",
});
const fileNodes: Obj[] = [
  {
    id: "f1",
    parentId: null,
    nodeType: "directory",
    blobId: null,
    size: null,
    name: "Documents",
    type: null,
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
    role: "documents",
  },
  {
    id: "f2",
    parentId: "f1",
    nodeType: "file",
    blobId: putBlob("hello world", "text/plain"),
    size: 11,
    name: "notes.txt",
    type: "text/plain",
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  },
  {
    id: "f3",
    parentId: null,
    nodeType: "file",
    blobId: putBlob("%PDF-1.4 mock", "application/pdf"),
    size: 14,
    name: "report.pdf",
    type: "application/pdf",
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  },
];

/* What the shared account holds. Its own nodes, so opening the share in Files
   shows something different from the reader's own folders rather than the same
   list under another name. */
const sharedFileNodes: Obj[] = [
  {
    id: "s1",
    parentId: null,
    nodeType: "directory",
    blobId: null,
    size: null,
    name: "Team plans",
    type: null,
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  },
  {
    id: "s2",
    parentId: "s1",
    nodeType: "file",
    blobId: putBlob("shared notes", "text/plain"),
    size: 12,
    name: "roadmap.txt",
    type: "text/plain",
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  },
];
/** The node list an account owns. */
const groupFileNodes: Obj[] = [
  {
    id: "gf1",
    parentId: null,
    nodeType: "directory",
    blobId: null,
    size: null,
    name: "Team files",
    type: null,
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  },
  {
    id: "gf2",
    parentId: "gf1",
    nodeType: "file",
    blobId: putBlob("Team agenda\n", "text/plain"),
    size: 11,
    name: "agenda.txt",
    type: "text/plain",
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  },
];
const nodesFor = (accountId: unknown): Obj[] =>
  accountId === SHARED_ACCOUNT
    ? sharedFileNodes
    : accountId === GROUP_ACCOUNT
      ? groupFileNodes
      : accountId === GROUP2_ACCOUNT
        ? group2FileNodes
        : accountId === TARGET_ACCOUNT
          ? targetFileNodes
          : accountId === AGENT_ACCOUNT
            ? agentFileNodes
            : fileNodes;

/** The second group's Files: chat provisions its `gilbert` folder on demand. */
const group2FileNodes: Obj[] = [];

/** The node list the target principal (ADR 0001) owns: an empty account. */
const targetFileNodes: Obj[] = [];

/**
 * The agent's own Files (ADR 0003): where its configuration documents live.
 * Empty on purpose -- the mock seeds nothing the code under test is supposed to
 * create itself, so the `gilbert/agent` folders appear only once a write asks
 * for them.
 */
const agentFileNodes: Obj[] = [];
function fr() {
  return {
    mayRead: true,
    mayAddChildren: true,
    mayRename: true,
    mayDelete: true,
    mayModifyContent: true,
    mayShare: true,
  };
}

function recountMail(ms: Obj[], es: Obj[]) {
  for (const m of ms) {
    const inBox = es.filter((e) => (e.mailboxIds as Obj)[m.id as string]);
    m.totalEmails = inBox.length;
    m.unreadEmails = inBox.filter((e) => !(e.keywords as Obj).$seen).length;
    const threads = new Set(inBox.map((e) => e.threadId));
    m.totalThreads = threads.size;
    m.unreadThreads = new Set(
      inBox.filter((e) => !(e.keywords as Obj).$seen).map((e) => e.threadId),
    ).size;
  }
}
/* Counts follow the mail, for whichever account holds it. */
function recount() {
  recountMail(mailboxes, emails);
  recountMail(groupMailboxes, groupEmails);
  recountMail(group2Mailboxes, group2Emails);
  recountMail(agentMailboxes, agentEmails);
}
recount();

/* ---------- helpers ---------- */
function pick(o: Obj, props?: string[] | null): Obj {
  if (!props) return o;
  const out: Obj = { id: o.id };
  for (const p of props)
    if (p in o) out[p] = o[p];
    else if (p.startsWith("header:")) out[p] = null;
  return out;
}
function resolveRefs(
  args: Obj,
  responses: [string, Obj, string][],
  creations: Record<string, string>,
): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("#")) {
      const r = v as { resultOf: string; name: string; path: string };
      const resp = responses.find((x) => x[2] === r.resultOf && x[0] === r.name);
      out[k.slice(1)] = resp ? jsonPointer(resp[1], r.path) : [];
    } else out[k] = resolveCreationIds(v, creations, k);
  }
  return out;
}

/**
 * Creation references (RFC 8620 5.3): a `#creationId` anywhere a real id would
 * go, pointing at something created earlier in the same request. Sending a
 * message uses one -- `EmailSubmission/set` names the email as `#m` -- so
 * without this the mock quietly declines to create any submission at all.
 *
 * `onSuccessUpdateEmail` is left alone: its keys are creation ids by design and
 * the method that receives them resolves them itself.
 */
function resolveCreationIds(
  value: unknown,
  creations: Record<string, string>,
  key?: string,
): unknown {
  if (key === "onSuccessUpdateEmail") return value;
  if (typeof value === "string") {
    return value.startsWith("#") && creations[value.slice(1)]
      ? creations[value.slice(1)]!
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveCreationIds(v, creations));
  if (value && typeof value === "object") {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      const nk = k.startsWith("#") && creations[k.slice(1)] ? creations[k.slice(1)]! : k;
      out[nk] = resolveCreationIds(v, creations, k);
    }
    return out;
  }
  return value;
}
function jsonPointer(obj: unknown, path: string): unknown {
  const parts = path.split("/").filter(Boolean);
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "*") {
      const rest = parts.slice(i + 1).join("/");
      const arr = (cur as unknown[]).flatMap((x) => {
        const v = jsonPointer(x, `/${rest}`);
        return Array.isArray(v) ? v : [v];
      });
      return arr;
    }
    cur = (cur as Obj)?.[p];
  }
  return cur;
}
function matchFilter(e: Obj, f: Obj | undefined): boolean {
  if (!f) return true;
  if (f.operator) {
    const conds = (f.conditions as Obj[]).map((c) => matchFilter(e, c));
    return f.operator === "AND"
      ? conds.every(Boolean)
      : f.operator === "OR"
        ? conds.some(Boolean)
        : !conds.some(Boolean);
  }
  const kw = e.keywords as Obj;
  if (f.inMailbox && !(e.mailboxIds as Obj)[f.inMailbox as string]) return false;
  if (f.hasKeyword && !kw[f.hasKeyword as string]) return false;
  if (f.notKeyword && kw[f.notKeyword as string]) return false;
  if (f.hasAttachment !== undefined && Boolean(e.hasAttachment) !== f.hasAttachment)
    return false;
  const hay =
    `${e.subject} ${JSON.stringify(e.from)} ${JSON.stringify(e.to)} ${e.preview}`.toLowerCase();
  for (const k of ["text", "subject", "from", "to", "body"])
    if (f[k] && !hay.includes(String(f[k]).toLowerCase())) return false;
  if (f.before && String(e.receivedAt) >= String(f.before)) return false;
  if (f.after && String(e.receivedAt) < String(f.after)) return false;
  if (f.minSize && Number(e.size) < Number(f.minSize)) return false;
  if (f.maxSize && Number(e.size) > Number(f.maxSize)) return false;
  return true;
}
function applyPatch(obj: Obj, patch: Obj) {
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes("/")) {
      const [root, ...rest] = k.split("/");
      const key = rest.join("/");
      const target = (obj[root!] as Obj) ?? {};
      if (v === null) delete target[key];
      else target[key] = v;
      obj[root!] = target;
    } else obj[k] = v;
  }
}

/* ---------- method handlers ---------- */
type Handler = (args: Obj, who: Identity) => Obj | [string, Obj][];
/** A method-level failure, surfaced as ["error", {type, description}, id]. */
class MethodError extends Error {
  constructor(
    public readonly type: string,
    description?: string,
  ) {
    super(description ?? type);
  }
}

const MAX_OBJECTS = 500;

/**
 * Stalwart refuses a whole method call that carries more objects than it will
 * process at once - it does not quietly handle the first 500. Enforce the same
 * ceiling the session advertises, so an unbatched client fails here too.
 */
function enforceLimits(name: string, args: Obj): void {
  const tooLarge = () => {
    throw new MethodError(
      "requestTooLarge",
      "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call.",
    );
  };
  if (name.endsWith("/get")) {
    const ids = args.ids as unknown[] | null | undefined;
    if (Array.isArray(ids) && ids.length > MAX_OBJECTS) tooLarge();
  }
  if (name.endsWith("/set")) {
    const n =
      Object.keys((args.create as Obj) ?? {}).length +
      Object.keys((args.update as Obj) ?? {}).length +
      ((args.destroy as unknown[] | undefined)?.length ?? 0);
    if (n > MAX_OBJECTS) tooLarge();
  }
}

/**
 * The compare-and-set every `/set` on the mock honours: `ifInState` names the
 * state the client read, and a set whose type has moved on since is refused --
 * the whole method call, with the error object RFC 8620 §5.3 defines for it,
 * which is the shape a JMAP client sees (`web/src/...` raises its typed error
 * from exactly this). Nothing the request asked for is applied: the check runs
 * before any object is touched, the way a real server fails the call rather
 * than the objects in it.
 *
 * Not checked against a live server: the error *type* is the RFC's, not a
 * string quoted from 0.16. The behaviour it stands for is the one the agent
 * design rests on -- documents plus conditional writes, no lock anywhere
 * (ADR 0003, §6) -- so a mock that ignored `ifInState` would leave every
 * lease and every job update untested.
 *
 * Asked of a real Stalwart 0.16 instance on 2026-09-11, on credentials the
owner supplies, by
 * `scripts/probe-conditional-writes.mjs`), and this simulation matches every
 * answer: `FileNode/set` honours `ifInState`; a mismatch arrives as
 * `stateMismatch`, never as `invalidArguments`; the FileNode state token
 * advances on every write that matters, so a token read before one is refused
 * after it; and a blob **upload** — which writes no node — does not advance it.
 * That last answer is what makes the order `writeAppFileAt` uses (read the
 * state, upload, set conditionally) safe, and the probe asks that composed order
 * as its own question.
 */
function checkIfInState(a: Obj, type: string): void {
  const asked = a.ifInState;
  if (asked === undefined || asked === null) return;
  if (String(asked) !== stateOf(type))
    throw new MethodError(
      "stateMismatch",
      `The ${type} objects have changed since the state given in ifInState.`,
    );
}

/**
 * The response of a `/set`, stamped with the state of the type it wrote: the
 * state a client read (`oldState`) and the state it left behind (`newState`),
 * which is the token its next conditional write must carry.
 */
const setResp = (type: string, extra: Obj = {}): Obj => {
  const oldState = stateOf(type);
  bumpState(type);
  return {
    accountId: ACCOUNT,
    oldState,
    newState: stateOf(type),
    created: {},
    updated: {},
    destroyed: [],
    ...extra,
  };
};

/*
 * `Mailbox/get` does not return `shareWith` unless a client asks for it by
 * name: a `/get` with no `properties` comes back without the field at all.
 * Confirmed on 0.16.19 (2026-08-27) against a mailbox that really was shared.
 * The mock handing it over unasked meant a client that never asked still saw
 * every share, and the one place that did not -- the real server -- showed
 * nothing shared at all.
 *
 * Calendars and address books used to behave the same way and no longer do.
 * 0.16.21 fixed `Calendar/get` and `AddressBook/get` to return every property
 * when `properties` is omitted or null, `shareWith` included. **Confirmed live
 * on 0.16.21 (2026-09-06):** both come back with the full set, while
 * `Mailbox/get` on the same server still omits it — so this stays, and it
 * stays applied to mailboxes alone.
 */
function hideShareWithUnlessAsked(a: Obj, res: { list: Obj[] }): { list: Obj[] } {
  if (a.properties) return res;
  return { ...res, list: res.list.map(({ shareWith: _drop, ...rest }) => rest) };
}

function genericGet(list: Obj[], type: string) {
  return (a: Obj) => {
    const ids = a.ids as string[] | null | undefined;
    const found = ids
      ? (ids.map((id) => list.find((x) => x.id === id)).filter(Boolean) as Obj[])
      : list;
    return {
      accountId: ACCOUNT,
      state: stateOf(type),
      list: found.map((x) => pick(x, a.properties as string[] | null)),
      notFound: ids ? ids.filter((id) => !list.some((x) => x.id === id)) : [],
    };
  };
}
/**
 * An id, as either a stored event or one occurrence of one.
 *
 * A synthetic id whose base is gone, or whose date the rule no longer
 * generates (excluded, or past a `count`), resolves to nothing — `notFound`,
 * the way the server answers for an occurrence that is not there any more.
 */
function resolveEvent(list: Obj[], id: string): { base: Obj; occ?: Occurrence } | null {
  const direct = list.find((x) => x.id === id);
  if (direct) return { base: direct };
  const parsed = parseSyntheticId(id);
  if (!parsed) return null;
  const base = list.find((x) => x.id === parsed.baseId);
  if (!base) return null;
  const occ = occurrenceAt(base, parsed.recurrenceId);
  return occ ? { base, occ } : null;
}

/** Thrown from an onCreate hook to refuse a create the way a real server would. */
class SetError extends Error {
  constructor(
    readonly type: string,
    readonly description: string,
    readonly properties?: string[],
  ) {
    super(description);
  }
  toJSON(): Obj {
    return {
      type: this.type,
      description: this.description,
      ...(this.properties ? { properties: this.properties } : {}),
    };
  }
}

function genericSet(
  list: Obj[],
  prefix: string,
  onCreate: ((o: Obj) => void) | undefined,
  type: string,
) {
  return (a: Obj) => {
    /* Compare-and-set first, before anything is touched: a stale `ifInState`
       refuses the whole call, so nothing this request asked for happens. */
    checkIfInState(a, type);
    const created: Obj = {};
    const updated: Obj = {};
    const destroyed: string[] = [];
    const notCreated: Obj = {};
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const id = `${prefix}${randomUUID().slice(0, 6)}`;
      const o = { ...(obj as Obj), id };
      try {
        onCreate?.(o);
      } catch (err) {
        if (!(err instanceof SetError)) throw err;
        notCreated[cid] = err.toJSON();
        continue;
      }
      list.push(o);
      created[cid] = { id };
    }
    for (const [id, patch] of Object.entries((a.update as Obj) ?? {})) {
      const o = list.find((x) => x.id === id);
      if (o) {
        applyPatch(o, patch as Obj);
        updated[id] = null;
      }
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) {
        list.splice(i, 1);
        destroyed.push(id);
      }
    }
    return setResp(type, {
      created,
      updated,
      destroyed,
      ...(Object.keys(notCreated).length ? { notCreated } : {}),
    });
  };
}

/* ---------- calendar events ---------- */

/**
 * `CalendarEvent/set`, including the synthetic-id handling 0.16.20 added.
 *
 * An update or destroy aimed at an occurrence does not touch the series: it
 * writes a `recurrenceOverrides` entry keyed by that date, exactly as Stalwart
 * does — `{ excluded: true }` for a destroy, the patch merged in for an update.
 *
 * The refusals are the point of reproducing this at all:
 *
 * - a base event and one of its instances in the same request is refused, both
 *   ids at once, because the server cannot apply them in a defined order;
 * - the same id twice is "Duplicate event id.";
 * - the ten event-level properties are refused with `invalidProperties`;
 * - and the twelve inherited ones are dropped in silence, with the response
 *   still saying the update succeeded. A mock that applied them would let a
 *   client that sends them look correct everywhere except a real server.
 */
/**
 * Enough of an iCalendar reader to stand in for Stalwart's.
 *
 * It reads per VEVENT rather than across the whole file, because a file is the
 * case an emailed invitation never was: an export carries a year of them, and a
 * regex over the whole text would find the first DTSTART and call that the
 * answer. One event still comes back as a bare object, the shape this returned
 * when an invitation was all it had to handle.
 *
 * The synthetic organiser and attendee only go on events that arrived with a
 * METHOD. Those are scheduling messages, which is what the invitation fixtures
 * are; a plain export is not addressed to anyone, and inventing participants
 * for it would make imported events look like invitations nobody sent.
 */
function calendarEventParse(a: Obj) {
  const parsed: Obj = {};
  const notParsable: string[] = [];
  for (const b of a.blobIds as string[]) {
    const blob = blobs.get(b);
    if (!blob) {
      notParsable.push(b);
      continue;
    }
    const text = blob.data.toString();
    const field = (src: string, k: string) =>
      new RegExp(`^${k}[^:\r\n]*:(.*)$`, "m").exec(src)?.[1]?.trim();
    const method = field(text, "METHOD");
    const bodies = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
    const events = bodies.map((body) => {
      const g = (k: string) => field(body, k);
      const ds = g("DTSTART") ?? "20260101T000000Z";
      const de = g("DTEND") ?? ds;
      const toLocal = (s: string) =>
        `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00`;
      const start = new Date(`${toLocal(ds)}Z`);
      const end = new Date(`${toLocal(de)}Z`);
      return {
        "@type": "Event",
        uid: g("UID"),
        title: g("SUMMARY"),
        start: toLocal(ds),
        timeZone: "Etc/UTC",
        duration: `PT${Math.round((end.getTime() - start.getTime()) / 60000)}M`,
        method,
        locations: g("LOCATION") ? { l: { name: g("LOCATION") } } : undefined,
        participants: method
          ? {
              org: {
                name: "Ada Lovelace",
                calendarAddress: "mailto:ada@example.org",
                roles: { owner: true },
              },
              me: {
                name: "Demo User",
                calendarAddress: `mailto:${USER}`,
                roles: { attendee: true, required: true },
                participationStatus: "needs-action",
              },
            }
          : undefined,
      };
    });
    if (!events.length) {
      notParsable.push(b);
      continue;
    }
    parsed[b] = events.length === 1 ? events[0] : events;
  }
  return { accountId: ACCOUNT, parsed, notParsable };
}

function calendarEventSet(a: Obj) {
  /* CalendarEvent is an account-wide set like any other, so a conditional
     write is honoured here too (see `checkIfInState`). */
  checkIfInState(a, "CalendarEvent");
  /* Writes go to whichever account owns the calendar, so events land in that
     account's list (own, or a group's) rather than always the demo's. */
  const events = eventsFor(a.accountId);
  const created: Obj = {};
  const updated: Obj = {};
  const destroyed: string[] = [];
  const notCreated: Obj = {};
  const notUpdated: Obj = {};
  const notDestroyed: Obj = {};

  /*
   * An account that may not send invitations refuses the whole request the
   * moment it asks for them, and refuses it per object rather than as a method
   * error. Confirmed live on 0.16.21 for all three of create, update and
   * destroy; the same requests with the flag absent or false went through.
   * The flag alone decides it — the server does not first check whether the
   * event has anyone to notify.
   */
  if (NO_SCHEDULING_SEND && a.sendSchedulingMessages === true) {
    const denied = () => new SetError("forbidden", SCHEDULING_FORBIDDEN).toJSON();
    for (const cid of Object.keys((a.create as Obj) ?? {})) notCreated[cid] = denied();
    for (const id of Object.keys((a.update as Obj) ?? {})) notUpdated[id] = denied();
    for (const id of (a.destroy as string[]) ?? []) notDestroyed[id] = denied();
    return setResp("CalendarEvent", {
      created,
      updated,
      destroyed,
      ...(Object.keys(notCreated).length ? { notCreated } : {}),
      ...(Object.keys(notUpdated).length ? { notUpdated } : {}),
      ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}),
    });
  }

  for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
    const o: Obj = { ...(obj as Obj), id: `ev${randomUUID().slice(0, 6)}` };
    // Stalwart 0.16 rejects the RFC 8984 array outright and silently discards
    // participants addressed the RFC 8984 way. The mock did neither, which is
    // how #26 and #30 reached a live server unnoticed — so it does both.
    if (o.recurrenceRules) {
      notCreated[cid] = new SetError("invalidProperties", "Invalid property.", [
        "recurrenceRules",
      ]).toJSON();
      continue;
    }
    const parts = o.participants as Record<string, Obj> | undefined;
    if (parts && Object.values(parts).some((p) => !p.calendarAddress))
      delete o.participants;
    if (o.replyTo && !o.organizerCalendarAddress) delete o.replyTo;
    o.uid = o.uid ?? randomUUID();
    events.push(o);
    created[cid] = { id: o.id };
  }

  const updates = Object.entries((a.update as Obj) ?? {});
  const destroys = ((a.destroy as string[]) ?? []).slice();
  const seen = new Set<string>();

  /* A base and one of its instances cannot be settled in the same request. */
  const baseOf = (id: string): string | null => {
    const r = resolveEvent(events, id);
    return r ? (r.base.id as string) : null;
  };
  const touched = new Map<string, { base: string[]; instance: string[] }>();
  for (const id of [...updates.map(([id]) => id), ...destroys]) {
    const b = baseOf(id);
    if (!b) continue;
    const entry = touched.get(b) ?? { base: [], instance: [] };
    (parseSyntheticId(id) ? entry.instance : entry.base).push(id);
    touched.set(b, entry);
  }
  const conflicted = new Set<string>();
  for (const [, e] of touched) {
    if (e.base.length && e.instance.length)
      for (const id of [...e.base, ...e.instance]) conflicted.add(id);
  }
  const conflict = () =>
    new SetError(
      "invalidProperties",
      "A base event and its instances cannot be modified in the same request.",
      ["id"],
    ).toJSON();

  for (const [id, patch] of updates) {
    if (conflicted.has(id)) {
      notUpdated[id] = conflict();
      continue;
    }
    if (seen.has(id)) {
      notUpdated[id] = new SetError("invalidProperties", "Duplicate event id.", [
        "id",
      ]).toJSON();
      continue;
    }
    seen.add(id);
    const resolved = resolveEvent(events, id);
    if (!resolved) {
      notUpdated[id] = { type: "notFound" };
      continue;
    }
    if (!resolved.occ) {
      applyPatch(resolved.base, patch as Obj);
      updated[id] = null;
      continue;
    }
    const { rejected, applied } = splitOccurrencePatch(patch as Obj);
    if (rejected) {
      notUpdated[id] = new SetError(
        "invalidProperties",
        "This property cannot be modified on a single occurrence.",
        [rejected],
      ).toJSON();
      continue;
    }
    writeOverride(resolved.base, resolved.occ, applied);
    updated[id] = null;
  }

  for (const id of destroys) {
    if (conflicted.has(id)) {
      notDestroyed[id] = conflict();
      continue;
    }
    const resolved = resolveEvent(events, id);
    if (!resolved) {
      notDestroyed[id] = { type: "notFound" };
      continue;
    }
    if (resolved.occ) {
      // One date off a series, which is an override rather than a deletion.
      writeOverride(resolved.base, resolved.occ, { excluded: true }, true);
      destroyed.push(id);
      continue;
    }
    const i = events.findIndex((x) => x.id === id);
    if (i >= 0) {
      events.splice(i, 1);
      destroyed.push(id);
    }
  }

  return setResp("CalendarEvent", {
    created,
    updated,
    destroyed,
    ...(Object.keys(notCreated).length ? { notCreated } : {}),
    ...(Object.keys(notUpdated).length ? { notUpdated } : {}),
    ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}),
  });
}

/**
 * Merge a patch into the override for one date.
 *
 * Stalwart fills `start` and `duration` in when the patch leaves them out, so
 * an override always carries its own timing; the mock does the same, or a
 * client could depend on inheriting them and be right only here.
 */
function writeOverride(base: Obj, occ: Occurrence, patch: Obj, replace = false) {
  const overrides = (base.recurrenceOverrides as Record<string, Obj> | undefined) ?? {};
  const existing = replace ? {} : (overrides[occ.recurrenceId] ?? {});
  const next: Obj = { ...existing };
  if (!replace) {
    if (!("start" in next)) next.start = occ.start;
    if (!("duration" in next) && base.duration) next.duration = base.duration;
  }
  applyPatch(next, patch);
  overrides[occ.recurrenceId] = next;
  base.recurrenceOverrides = overrides;
}

/* ---------- submissions ---------- */
/**
 * Held messages, the way Stalwart models them: `sendAt` is derived from the
 * envelope's FUTURERELEASE parameter rather than set by the client, and
 * `undoStatus` reports whether the message is still in the queue.
 */
const submissions: Obj[] = [];

function submissionView(sub: Obj): Obj {
  return { ...sub, undoStatus: undoStatusOf(sub, now()) };
}

function matchSubmissionFilter(sub: Obj, f: Obj | undefined): boolean {
  if (!f) return true;
  if (f.undoStatus && undoStatusOf(sub, now()) !== f.undoStatus) return false;
  if (
    Array.isArray(f.emailIds) &&
    !(f.emailIds as string[]).includes(sub.emailId as string)
  )
    return false;
  if (
    Array.isArray(f.identityIds) &&
    !(f.identityIds as string[]).includes(sub.identityId as string)
  )
    return false;
  return true;
}

const handlers: Record<string, Handler> = {
  // 0.16 exposes the account locale here, under a permission ordinary users
  // actually have (unlike x:Account below, which needs sysAccountGet).
  "x:AccountSettings/get": (a) => {
    const ids = (a.ids as string[] | null) ?? ["singleton"];
    const list = ids
      .filter((id) => id === "singleton")
      .map((id) => ({ id, locale: MOCK_LOCALE, timeZone: null, description: null }));
    return {
      accountId: ACCOUNT,
      state: stateOf("x:AccountSettings"),
      list: list.map((x) => pick(x, a.properties as string[] | null)),
      notFound: ids.filter((id) => id !== "singleton"),
    };
  },
  // Stalwart's directory extension - the client reads the account locale from here.
  "x:Account/get": (a) => {
    const ids = (a.ids as string[] | null) ?? [ACCOUNT];
    const list = ids
      .filter((id) => id === ACCOUNT)
      .map((id) => ({ id, name: USER, locale: MOCK_LOCALE, timeZone: null }));
    return {
      accountId: ACCOUNT,
      state: stateOf("x:Account"),
      list,
      notFound: ids.filter((id) => id !== ACCOUNT),
    };
  },
  "Mailbox/get": (a) =>
    hideShareWithUnlessAsked(
      a,
      genericGet(mailboxesFor(a.accountId), "Mailbox")(a) as { list: Obj[] },
    ) as never,
  "Mailbox/set": (a) => {
    /* Folder management runs on whichever account is active -- the reader's
       own, or the group mailbox they opened -- so the set must find the
       folder in that account's tree, not always in the demo's. */
    const r = genericSet(
      mailboxesFor(a.accountId),
      "m",
      (o) =>
        Object.assign(o, {
          ...mb(o.id as string, o.name as string, null, (o.parentId as string) ?? null),
          ...o,
        }),
      "Mailbox",
    )(a);
    recount();
    return r;
  },
  "Mailbox/changes": () => ({
    accountId: ACCOUNT,
    oldState: "1",
    newState: stateOf("Mailbox"),
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
  }),
  "Email/query": (a) => {
    let list = emailsFor(a.accountId).filter((e) => matchFilter(e, a.filter as Obj));
    /*
     * Honour the sort rather than always answering newest-first. This used to
     * ignore it entirely, which reproduced a server that silently returns a
     * different order from the one asked for -- the one shape of wrongness a
     * client cannot detect.
     */
    const sort = (a.sort as Obj[] | undefined) ?? [
      { property: "receivedAt", isAscending: false },
    ];
    if (NO_KEYWORD_SORT && sort.some((c) => String(c.property) === "hasKeyword")) {
      // A method-level failure, the way a real server refuses an optional sort:
      // the whole call fails rather than the sort being quietly dropped.
      throw new MethodError("unsupportedSort", "Sorting on hasKeyword is not supported.");
    }
    list.sort((x, y) => {
      for (const c of sort) {
        const asc = c.isAscending !== false;
        const cmp = compareBy(x, y, String(c.property), c.keyword as string | undefined);
        if (cmp !== 0) return asc ? cmp : -cmp;
      }
      return 0;
    });
    if (a.collapseThreads) {
      const seen = new Set<string>();
      list = list.filter((e) => {
        const t = e.threadId as string;
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });
    }
    const pos = Number(a.position ?? 0);
    const limit = Number(a.limit ?? 50);
    return {
      accountId: ACCOUNT,
      queryState: stateOf("Email"),
      canCalculateChanges: false,
      position: pos,
      ids: list.slice(pos, pos + limit).map((e) => e.id),
      total: list.length,
      limit,
    };
  },
  "Email/get": (a) => genericGet(emailsFor(a.accountId), "Email")(a),
  /*
   * Real changes, not an empty answer.
   *
   * This used to return three empty arrays whatever had happened, so the
   * client's whole reconciliation path -- `Email/changes`, then deciding what
   * to do with what came back -- never ran against the mock. A bug living in
   * that path could not be reproduced here at all, which is how one reached
   * production and survived being "fixed" once (#100). The log below is what
   * the real server can answer from.
   */
  "Email/changes": (a) => {
    const since = Number(a.sinceState ?? 0);
    /* One account's changes, not the mock's whole log: a real server answers
       per account, and the agent reconciling a group's mail must not be handed
       the demo user's. */
    const accountId = String(a.accountId ?? ACCOUNT);
    const relevant = emailChanges.filter(
      (c) => c.accountId === accountId && c.state > since,
    );
    const pick = (k: "created" | "updated" | "destroyed") => [
      ...new Set(relevant.flatMap((c) => c[k])),
    ];
    return {
      accountId: ACCOUNT,
      oldState: String(a.sinceState ?? "1"),
      newState: stateOf("Email"),
      hasMoreChanges: false,
      created: pick("created"),
      updated: pick("updated"),
      destroyed: pick("destroyed"),
    };
  },
  "Email/set": (a) => {
    const list = emailsFor(a.accountId);
    const r = genericSet(
      list,
      "e",
      (o) => {
        const bv = (o.bodyValues as Record<string, { value: string }>) ?? {};
        const walk = (p: Obj | undefined, acc: Obj[]) => {
          if (!p) return;
          if (p.partId && bv[p.partId as string])
            acc.push({
              ...p,
              blobId: putBlob(bv[p.partId as string]!.value, p.type as string),
              size: bv[p.partId as string]!.value.length,
            });
          (p.subParts as Obj[] | undefined)?.forEach((s) => walk(s, acc));
        };
        const parts: Obj[] = [];
        walk(o.bodyStructure as Obj, parts);
        o.textBody = parts.filter((p) => p.type === "text/plain");
        o.htmlBody = parts.filter((p) => p.type === "text/html");
        o.attachments = [];
        const collect = (p: Obj | undefined) => {
          if (!p) return;
          if (p.blobId && !p.partId && p.type !== "multipart/mixed")
            (o.attachments as Obj[]).push({ ...p, size: p.size ?? 0 });
          (p.subParts as Obj[] | undefined)?.forEach(collect);
        };
        collect(o.bodyStructure as Obj);
        o.hasAttachment = (o.attachments as Obj[]).length > 0;
        o.threadId = o.inReplyTo
          ? (list.find(
              (e) =>
                (e.messageId as string[] | null)?.[0] === (o.inReplyTo as string[])[0],
            )?.threadId ?? `t${o.id}`)
          : `t${o.id}`;
        o.receivedAt = new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
        o.size = 2000;
        o.preview = (bv.text?.value ?? "").slice(0, 100);
        o.messageId = [`${o.id}@mock`];
        o.blobId = putBlob(
          `Subject: ${o.subject}\r\n\r\n${bv.text?.value ?? ""}`,
          "message/rfc822",
        );
      },
      "Email",
    )(a);
    recount();
    /* The change is visible at the state the set left behind: record that
       state, so a client asking from the state it read before is told what
       arrived. Nothing is bumped here -- `setResp` already moved the Email
       state, and a second bump would put the change beyond the state the
       client is handed. */
    recordEmailChange(
      String(a.accountId ?? ACCOUNT),
      {
        created: Object.values((r.created ?? {}) as Record<string, { id: string }>).map(
          (x) => x.id,
        ),
        updated: Object.keys((a.update as Obj) ?? {}),
        destroyed: (r.destroyed as string[] | undefined) ?? [],
      },
      String(r.newState),
    );
    /* A real server pushes a state change after a set, and the client acts on
       it -- `Email/changes` runs and the store reconciles what came back. The
       mock stayed silent, so that whole path never ran here and a bug living
       in it could not be reproduced: marking a message read went round the
       server and back on the live instance, and did nothing at all on the mock
       (#100). Announced now, the way Stalwart does. */
    broadcast(["Email", "Mailbox", "Thread"], (a.accountId as string) ?? ACCOUNT);
    return r;
  },
  /*
   * Mail arriving in an account -- the only way a message gets in here: the
   * mock has no MTA, so a test delivers with the same method the client uses to
   * put a message it already has into a mailbox.
   *
   * A real 0.16 server parses that blob into the Email object: subject,
   * addresses, size, preview and the body a `text`/`body` filter matches all
   * come from the message itself, never from the request. A stub object with
   * none of them leaves an agent's rule with nothing to match incoming mail
   * on, so the mock reads the same fields out of a small subset of RFC 5322
   * (see `parseRawMessage`, which says what it does not decode), and it
   * announces the arrival the way a delivery would: a change log entry and a
   * state change. Mail that lands silently is mail no worker reconciling from
   * a recorded state ever sees (ADR 0003).
   */
  "Email/import": (a) => {
    const created: Obj = {};
    const list = emailsFor(a.accountId);
    const arrived: string[] = [];
    for (const [cid, spec] of Object.entries((a.emails as Obj) ?? {})) {
      const s = spec as Obj;
      const id = `e${counter++}`;
      const raw = blobs.get(s.blobId as string)?.data.toString() ?? "";
      const parsed = parseRawMessage(raw);
      const textBlob = putBlob(parsed.text, "text/plain");
      list.push({
        id,
        blobId: s.blobId,
        threadId: `t${id}`,
        mailboxIds: s.mailboxIds,
        keywords: s.keywords ?? {},
        size: raw.length,
        receivedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        preview: parsed.text.slice(0, 120).replace(/\n/g, " "),
        hasAttachment: false,
        messageId: [parsed.messageId ?? `${id}@mock`],
        textBody: [
          {
            partId: "1",
            blobId: textBlob,
            size: parsed.text.length,
            name: null,
            type: "text/plain",
            charset: "utf-8",
            disposition: null,
            cid: null,
          },
        ],
        htmlBody: [],
        attachments: [],
        bodyValues: {
          "1": { value: parsed.text, isEncodingProblem: false, isTruncated: false },
        },
      });
      created[cid] = { id };
      arrived.push(id);
    }
    recount();
    const res = setResp("Email", { created });
    recordEmailChange(
      String(a.accountId ?? ACCOUNT),
      { created: arrived },
      String(res.newState),
    );
    if (arrived.length)
      broadcast(["Email", "Mailbox", "Thread"], (a.accountId as string) ?? ACCOUNT);
    return res;
  },
  "Thread/get": (a) => {
    const ids = a.ids as string[];
    const list = ids
      .map((id) => ({
        id,
        emailIds: emailsFor(a.accountId)
          .filter((e) => e.threadId === id)
          .sort((x, y) => String(x.receivedAt).localeCompare(String(y.receivedAt)))
          .map((e) => e.id),
      }))
      .filter((t) => t.emailIds.length);
    return {
      accountId: ACCOUNT,
      state: stateOf("Thread"),
      list,
      notFound: ids.filter((id) => !list.some((t) => t.id === id)),
    };
  },
  // Stalwart 0.16 registry objects backing self-service credentials. The
  // object they read and write is the *authenticating principal's* — the mock
  // knows two principals, and each has its own password, 2FA state and app
  // passwords.
  "x:AccountPassword/get": (_a, who) => {
    const st = principalState(who.username);
    return {
      accountId: ACCOUNT,
      state: stateOf("x:AccountPassword"),
      list: [
        {
          id: "singleton",
          otpAuth: { otpUrl: st.otpUrl ? MASKED : null, otpCode: null },
        },
      ],
      notFound: [],
    };
  },
  "x:AccountPassword/set": (a, who) => {
    /* The password record is a registry object with its own state, so the
       change-password flow can be made conditional like everything else. */
    checkIfInState(a, "x:AccountPassword");
    const st = principalState(who.username);
    const patch = (a.update as Obj)?.singleton as Obj | undefined;
    if (!patch) return setResp("x:AccountPassword", { updated: {} });
    const current = patch.currentSecret as string | undefined;
    const code = (patch["otpAuth/otpCode"] ??
      (patch.otpAuth as Obj | undefined)?.otpCode) as string | undefined;
    if (!current) {
      return setResp("x:AccountPassword", {
        notUpdated: {
          singleton: {
            type: "forbidden",
            description:
              "Current secret must be provided to change the password or OTP auth.",
          },
        },
      });
    }
    if (current !== st.password) {
      return setResp("x:AccountPassword", {
        notUpdated: {
          singleton: { type: "forbidden", description: "Current secret is incorrect." },
        },
      });
    }
    if (st.otpUrl && !code) {
      return setResp("x:AccountPassword", {
        notUpdated: {
          singleton: {
            type: "forbidden",
            description:
              "Current OTP code is required to change the password or OTP auth.",
          },
        },
      });
    }
    if (st.otpUrl && !checkOtpFor(st, code!)) {
      return setResp("x:AccountPassword", {
        notUpdated: {
          singleton: { type: "forbidden", description: "Current secret is incorrect." },
        },
      });
    }
    const secret = patch.secret as string | undefined;
    if (secret !== undefined && secret !== MASKED) {
      if (secret.length < 8) {
        return setResp("x:AccountPassword", {
          notUpdated: {
            singleton: {
              type: "invalidProperties",
              properties: ["secret"],
              description: "Password must be at least 8 characters long.",
            },
          },
        });
      }
      st.password = secret;
    }
    if ("otpAuth/otpUrl" in patch) {
      const url = patch["otpAuth/otpUrl"] as string | null;
      if (url !== MASKED) st.otpUrl = url;
    }
    return setResp("x:AccountPassword", { updated: { singleton: null } });
  },
  /*
   * Push subscriptions. The JMAP half can be modelled; delivery cannot -- that
   * runs through the browser vendor's real push service, so nothing local will
   * ever make a notification appear.
   *
   * What is worth reproducing is the handshake, because it is the part that
   * fails quietly: a subscription is created unverified and stays silent until
   * the client echoes back a code the server pushed. A mock that marked one
   * verified on creation would let a client ship without ever implementing
   * that, and the symptom in production is "registered, and no notifications".
   */
  "PushSubscription/get": (a) => {
    const ids =
      (a.ids as string[] | null) ?? pushSubscriptions.map((s) => s.id as string);
    const list = pushSubscriptions.filter((s) => ids.includes(s.id as string));
    // `keys` is write-only in JMAP: the server never hands it back.
    return {
      accountId: ACCOUNT,
      state: stateOf("PushSubscription"),
      list: list.map((s) => {
        const { keys: _drop, ...rest } = s;
        return rest;
      }),
      notFound: ids.filter((i) => !list.some((s) => s.id === i)),
    };
  },
  "PushSubscription/set": (a) => {
    /* A subscription is a set like any other: `ifInState` decides it. */
    checkIfInState(a, "PushSubscription");
    const created: Obj = {};
    const notCreated: Obj = {};
    const updated: Obj = {};
    const notUpdated: Obj = {};
    const destroyed: string[] = [];
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const o = obj as Obj;
      const keys = (o.keys ?? {}) as Obj;
      // Stalwart 0.16 was fixed to accept the unpadded base64url the W3C Push
      // API produces; padding it would be the client inventing a shape.
      for (const k of ["p256dh", "auth"]) {
        const v = String(keys[k] ?? "");
        if (!v) {
          notCreated[cid] = {
            type: "invalidProperties",
            properties: ["keys"],
            description: `Missing ${k}.`,
          };
          break;
        }
        if (v.includes("=") || v.includes("+") || v.includes("/")) {
          notCreated[cid] = {
            type: "invalidProperties",
            properties: ["keys"],
            description: `${k} must be unpadded base64url.`,
          };
          break;
        }
      }
      if (notCreated[cid]) continue;
      if (!String(o.url ?? "").startsWith("https://")) {
        notCreated[cid] = {
          type: "invalidProperties",
          properties: ["url"],
          description: "Push endpoint must be https.",
        };
        continue;
      }
      // A filter condition with a null value is not a filter -- the real server
      // answers "Invalid filter" and refuses the whole subscription. Gilbert
      // shipped `inMailbox: null` meaning "the inbox", which meant nothing at
      // all here, and the mock accepted it happily. It does not any more.
      const badFilter = Object.entries((o.emailPush ?? {}) as Obj).find(([, cfg]) => {
        const f = ((cfg as Obj)?.filter ?? {}) as Obj;
        return Object.values(f).some((v) => v === null || v === undefined);
      });
      if (badFilter) {
        notCreated[cid] = {
          type: "invalidArguments",
          properties: ["emailPush"],
          description: "Invalid filter.",
        };
        continue;
      }
      // One per device: re-subscribing replaces rather than accumulates.
      const deviceId = String(o.deviceClientId ?? "");
      const clash = pushSubscriptions.findIndex((s) => s.deviceClientId === deviceId);
      if (clash >= 0) pushSubscriptions.splice(clash, 1);
      const id = `ps${randomUUID().slice(0, 6)}`;
      /*
       * A subscription expires, and this used to hand back `expires: null`.
       * That is the one shape that makes the client's real problem invisible in
       * development: JMAP puts a ceiling of seven days on a push subscription
       * and expects the client to re-register before it lapses, so a client
       * that never renews works perfectly against a mock that never expires
       * anything and goes silent a week after being deployed. Seven days here,
       * so "does this client renew?" is a question the mock can answer.
       */
      const expires = new Date(now() + PUSH_TTL_MS).toISOString();
      pushSubscriptions.push({
        id,
        deviceClientId: deviceId,
        url: o.url,
        types: o.types ?? null,
        emailPush: o.emailPush ?? null,
        expires,
        keys,
        verified: false,
        code: `v${randomUUID().slice(0, 8)}`,
      });
      created[cid] = { id, expires };
    }
    for (const [id, patch] of Object.entries((a.update as Obj) ?? {})) {
      const s = pushSubscriptions.find((x) => x.id === id);
      if (!s) {
        notUpdated[id] = { type: "notFound" };
        continue;
      }
      const code = (patch as Obj).verificationCode;
      if (code !== undefined) {
        if (code !== s.code) {
          notUpdated[id] = {
            type: "invalidProperties",
            properties: ["verificationCode"],
            description: "Verification code does not match.",
          };
          continue;
        }
        s.verified = true;
      }
      updated[id] = null;
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = pushSubscriptions.findIndex((x) => x.id === id);
      if (i >= 0) {
        pushSubscriptions.splice(i, 1);
        destroyed.push(id);
      }
    }
    return setResp("PushSubscription", {
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
    });
  },
  "x:AppPassword/get": (a, who) =>
    genericGet(principalState(who.username).appPasswords, "x:AppPassword")(a),
  "x:AppPassword/set": (a, who) => {
    /* The registry's own state, so a credential write is conditional too: a
       rotation built on a read is refused when somebody else moved first. */
    checkIfInState(a, "x:AppPassword");
    const st = principalState(who.username);
    const created: Obj = {};
    const destroyed: string[] = [];
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const id = `ap${randomUUID().slice(0, 6)}`;
      // Real app passwords carry their credential id, so the server can spot
      // one by its shape alone. Mirror that.
      const secret = `$app$${id}$${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const row: Obj = {
        id,
        description: (obj as Obj).description ?? "App password",
        createdAt: new Date(now()).toISOString(),
        expiresAt: null,
        secret,
      };
      st.appPasswords.push(row);
      created[cid] = { id, secret, createdAt: row.createdAt };
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = st.appPasswords.findIndex((x) => x.id === id);
      if (i >= 0) {
        st.appPasswords.splice(i, 1);
        destroyed.push(id);
      }
    }
    return setResp("x:AppPassword", { created, destroyed });
  },
  "Identity/get": (a) => genericGet(identitiesFor(a.accountId), "Identity")(a),
  "Identity/set": (a) => {
    // Stalwart's cap is `value.len() < 2048` on a Rust string: 2047 bytes of
    // UTF-8, not characters. Anything longer is refused by name.
    for (const [where, entries] of [
      ["notCreated", (a.create as Obj) ?? {}],
      ["notUpdated", (a.update as Obj) ?? {}],
    ] as const) {
      for (const [key, obj] of Object.entries(entries)) {
        const over = ["htmlSignature", "textSignature"].find((prop) => {
          const v = (obj as Obj)[prop];
          return typeof v === "string" && Buffer.byteLength(v, "utf8") > 2047;
        });
        if (over)
          return setResp("Identity", {
            [where]: {
              [key]: {
                type: "invalidProperties",
                properties: [over],
                description: "Invalid property.",
              },
            },
          });
      }
    }
    /* The list the *request* named, not the demo user's: `Identity/get` reads
       per account (group and agent accounts have identities of their own), so
       a set that wrote the module-level list would answer 200 and change
       nothing the caller can see — which is how a group's signature edits
       silently did nothing. */
    return genericSet(
      identitiesFor(a.accountId),
      "i",
      (o) =>
        Object.assign(o, {
          replyTo: null,
          bcc: null,
          textSignature: "",
          htmlSignature: "",
          mayDelete: true,
          ...o,
        }),
      "Identity",
    )(a);
  },
  "EmailSubmission/get": (a) => {
    const ids = a.ids as string[] | null | undefined;
    const found = ids
      ? (ids.map((id) => submissions.find((x) => x.id === id)).filter(Boolean) as Obj[])
      : submissions;
    return {
      accountId: ACCOUNT,
      state: stateOf("EmailSubmission"),
      list: found.map((x) => pick(submissionView(x), a.properties as string[] | null)),
      notFound: ids ? ids.filter((id) => !submissions.some((x) => x.id === id)) : [],
    };
  },
  "EmailSubmission/query": (a) => {
    const list = submissions.filter((s) =>
      matchSubmissionFilter(s, a.filter as Obj | undefined),
    );
    list.sort((x, y) => String(x.sendAt).localeCompare(String(y.sendAt)));
    const pos = Number(a.position ?? 0);
    const limit = Number(a.limit ?? 50);
    return {
      accountId: ACCOUNT,
      queryState: stateOf("EmailSubmission"),
      canCalculateChanges: false,
      position: pos,
      ids: list.slice(pos, pos + limit).map((s) => s.id),
      total: list.length,
      limit,
    };
  },
  "EmailSubmission/set": (a) => {
    /* A submission is a set on the account, and the send path is exactly where
       a confused client sends twice if a lost race is not refused. */
    checkIfInState(a, "EmailSubmission");
    const created: Obj = {};
    const notCreated: Obj = {};
    const updated: Obj = {};
    const notUpdated: Obj = {};
    for (const [cid, raw] of Object.entries((a.create as Obj) ?? {})) {
      const sub = raw as Obj;
      const emailId = sub.emailId as string;
      const e = emailsFor(a.accountId).find((x) => x.id === emailId);
      if (!e) {
        notCreated[cid] = {
          type: "invalidProperties",
          properties: ["emailId"],
          description: "Blob for email not found.",
        };
        continue;
      }
      const hold = holdUntilOf(sub.envelope as Obj | undefined, now());
      if (Number.isNaN(hold)) {
        notCreated[cid] = {
          type: "invalidProperties",
          properties: ["envelope"],
          description: "Failed to parse mailFrom parameters.",
        };
        continue;
      }
      // Stalwart rejects MAIL FROM outright past its own limit.
      if (hold !== null && hold > now() + MAX_DELAYED_SEND * 1000) {
        notCreated[cid] = {
          type: "forbiddenMailFrom",
          description: `Server rejected MAIL-FROM: 501 5.5.4 Requested release time exceeds maximum of ${new Date(now() + MAX_DELAYED_SEND * 1000).toISOString()}.`,
        };
        continue;
      }
      // With the MTA extension off, the hold is dropped in silence.
      const sendAt = hold !== null && !NO_FUTURE_RELEASE ? hold : now();
      const rec: Obj = {
        id: `s${randomUUID().slice(0, 6)}`,
        identityId: sub.identityId ?? null,
        emailId,
        threadId: e.threadId ?? null,
        envelope: sub.envelope ?? null,
        sendAt: new Date(sendAt).toISOString(),
        undoStatus: null,
        deliveryStatus: null,
      };
      submissions.push(rec);
      created[cid] = {
        id: rec.id,
        sendAt: rec.sendAt,
        undoStatus: undoStatusOf(rec, now()),
      };
      const patch = (a.onSuccessUpdateEmail as Obj)?.[`#${cid}`] as Obj | undefined;
      if (patch) applyPatch(e, patch);
    }
    for (const [id, raw] of Object.entries((a.update as Obj) ?? {})) {
      const patch = raw as Obj;
      const sub = submissions.find((x) => x.id === id);
      if (!sub) {
        notUpdated[id] = { type: "notFound" };
        continue;
      }
      if (patch.undoStatus !== "canceled") {
        notUpdated[id] = {
          type: "invalidProperties",
          properties: ["undoStatus"],
          description: "Only cancellation is supported.",
        };
        continue;
      }
      const status = undoStatusOf(sub, now());
      if (status !== "pending") {
        notUpdated[id] = {
          type: "cannotUnsend",
          description:
            status === "canceled"
              ? "The message was already cancelled."
              : "The message has already been sent.",
        };
        continue;
      }
      sub.undoStatus = "canceled";
      updated[id] = null;
    }
    recount();
    return setResp("EmailSubmission", {
      created,
      updated,
      ...(Object.keys(notCreated).length ? { notCreated } : {}),
      ...(Object.keys(notUpdated).length ? { notUpdated } : {}),
    });
  },
  "VacationResponse/get": () => ({
    accountId: ACCOUNT,
    state: stateOf("VacationResponse"),
    list: [vacation],
    notFound: [],
  }),
  "VacationResponse/set": (a) => {
    checkIfInState(a, "VacationResponse");
    const p = (a.update as Obj)?.singleton as Obj | undefined;
    if (p) vacation = { ...vacation, ...p };
    return setResp("VacationResponse", { updated: { singleton: null } });
  },
  "Quota/get": () => ({
    accountId: ACCOUNT,
    state: "1",
    list: [
      {
        id: "q1",
        resourceType: "octets",
        used: 734003200,
        hardLimit: 2147483648,
        scope: "account",
        name: "Storage",
        types: ["Email"],
      },
    ],
    notFound: [],
  }),
  "SieveScript/get": genericGet(sieveScripts, "SieveScript"),
  "SieveScript/set": (a) => {
    const r = genericSet(
      sieveScripts,
      "sv",
      (o) => Object.assign(o, { isActive: false, ...o }),
      "SieveScript",
    )(a);
    const act = a.onSuccessActivateScript as string | undefined;
    if (act) {
      const id = act.startsWith("#")
        ? ((r.created as Obj)[act.slice(1)] as Obj)?.id
        : act;
      for (const s of sieveScripts) s.isActive = s.id === id;
    }
    if (a.onSuccessDeactivateScript) for (const s of sieveScripts) s.isActive = false;
    return r;
  },
  "SieveScript/validate": () => ({ accountId: ACCOUNT, error: null }),
  "Calendar/get": (a) => genericGet(calendarsFor(a.accountId), "Calendar")(a),
  /*
   * `isSubscribed` is deliberately not among the defaults a new calendar is
   * filled with. Stalwart leaves a calendar the client creates unsubscribed
   * unless the create says otherwise — a mock that set the flag for it would
   * let a client that never sends it look correct everywhere except a real
   * server (the task-list bug this models). The client's own create paths
   * (a task list, a plain calendar) say `isSubscribed: true`.
   */
  "Calendar/set": (a) =>
    genericSet(
      calendarsFor(a.accountId),
      "c",
      (o) =>
        Object.assign(o, {
          color: "#0f766e",
          isVisible: true,
          isDefault: false,
          includeInAvailability: "all",
          timeZone: null,
          shareWith: null,
          myRights: rightsCal(),
          description: null,
          sortOrder: 0,
          ...o,
        }),
      "Calendar",
    )(a),
  /*
   * With `expandRecurrences` every id that comes back is synthetic — a one-off
   * included, which is what a live 0.16.19 does and what makes `baseEventId`
   * useless as a test for a series. Without it (the `findByUid` path) the
   * stored ids come back untouched, because callers hand those straight to a
   * destroy and mean the whole event.
   */
  "CalendarEvent/query": (a) => {
    const list = eventsFor(a.accountId);
    const filter = (a.filter as Obj) ?? {};
    const matching = list.filter(
      (e) =>
        (!filter.uid || e.uid === filter.uid) &&
        (!filter.inCalendar ||
          Boolean((e.calendarIds as Obj | undefined)?.[filter.inCalendar as string])),
    );
    if (!a.expandRecurrences) {
      return {
        accountId: a.accountId ?? ACCOUNT,
        queryState: "1",
        canCalculateChanges: false,
        position: 0,
        ids: matching.map((e) => e.id),
        total: matching.length,
      };
    }
    const from = filter.after
      ? new Date(filter.after as string)
      : new Date(-8640000000000);
    const to = filter.before
      ? new Date(filter.before as string)
      : new Date(8640000000000);
    const ids: string[] = [];
    for (const e of matching)
      for (const occ of expandOccurrences(e, from, to))
        ids.push(syntheticId(e.id as string, occ.recurrenceId));
    return {
      accountId: a.accountId ?? ACCOUNT,
      queryState: "1",
      canCalculateChanges: false,
      position: 0,
      ids,
      total: ids.length,
    };
  },
  "CalendarEvent/get": (a) => {
    const list = eventsFor(a.accountId);
    const ids = a.ids as string[] | null | undefined;
    if (!ids) return genericGet(list, "CalendarEvent")(a);
    const found: Obj[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const resolved = resolveEvent(list, id);
      if (!resolved) {
        notFound.push(id);
        continue;
      }
      found.push(
        resolved.occ ? occurrenceView(resolved.base, resolved.occ) : resolved.base,
      );
    }
    return {
      accountId: ACCOUNT,
      state: stateOf("CalendarEvent"),
      list: found.map((x) => pick(x, a.properties as string[] | null)),
      notFound,
    };
  },
  // Stalwart 0.16 rejects the RFC 8984 array outright and silently discards
  // participants addressed the RFC 8984 way. The mock did neither, which is how
  // #26 and #30 reached a live server unnoticed — so it now does both.
  "CalendarEvent/set": (a) => calendarEventSet(a),
  "CalendarEvent/parse": (a) => calendarEventParse(a),
  "ParticipantIdentity/get": genericGet(participantIdentities, "ParticipantIdentity"),
  // Principal/query honours the type filter: Stalwart 0.16.21 maps
  // PrincipalFilter::Type Individual -> user accounts and Group -> groups
  // (crates/jmap/src/principal/query.rs; checked on source 2026-09-07,
  // re-verify against a live server with a dated comment per repo
  // convention). Other filters are ignored here — nothing in Gilbert sends
  // them yet. Directory queries are gated the way the real server gates them:
  // see `directoryGate` and the refusal in the request handler below.
  //
  // It honours `position` and `limit` the way a 0.16 query method does, and
  // answers `total` when `calculateTotal` asks for it (the JMAP query shape
  // Stalwart implements; assumed 2026-09-13 from the spec and its own query
  // code, never probed live). The live probe this owes: a directory of more
  // than one page read with `position`/`limit` and again with
  // `calculateTotal`, against a real 0.16.21 server, to see whether the total
  // and the page offsets are the ones assumed here — it is written down as
  // owed in `src/mock/directory-paging.test.ts`.
  "Principal/query": (a) => {
    // A real 0.16 server wants the filter as a single object and refuses an
    // array with notRequest (verified live 2026-09-07); the mock accepts the
    // object form, matching on type, email or name.
    const f = a.filter as { type?: unknown; email?: unknown; name?: unknown } | undefined;
    const type = typeof f?.type === "string" ? f.type : null;
    const email = typeof f?.email === "string" ? f.email.toLowerCase() : null;
    const name = typeof f?.name === "string" ? f.name.toLowerCase() : null;
    const list = principals.filter((p) => {
      const pType = p.type as string | undefined;
      const pEmail = (p.email as string | undefined)?.toLowerCase() ?? "";
      const pName = (p.name as string | undefined)?.toLowerCase() ?? "";
      if (type && pType !== type) return false;
      if (email && pEmail !== email) return false;
      if (name && pName !== name && pEmail !== name) return false;
      return true;
    });
    const total = list.length;
    // `position` is where the page starts within the whole result, counting
    // back from the end when negative; `limit` is how many ids come back.
    // A caller that names no limit — absent, null or negative — gets the rest
    // of the list, which is also what a caller that names none got before
    // paging existed. Whether a real server refuses the negative forms with
    // invalidArguments instead is part of the live probe above.
    const asked =
      typeof a.position === "number" && Number.isFinite(a.position)
        ? Math.trunc(a.position)
        : 0;
    const start = asked < 0 ? Math.max(0, total + asked) : Math.min(asked, total);
    const askedLimit =
      typeof a.limit === "number" && Number.isFinite(a.limit) && a.limit > 0
        ? Math.trunc(a.limit)
        : total - start;
    const page = list.slice(start, start + askedLimit);
    return {
      accountId: ACCOUNT,
      queryState: "1",
      canCalculateChanges: false,
      position: start,
      ids: page.map((p) => p.id),
      // `total` is the population the query matched, answered only when the
      // caller asks for it: it is the number a paging reader uses to know
      // which page was the last one.
      ...(a.calculateTotal ? { total } : {}),
    };
  },
  "Principal/get": genericGet(principals, "Principal"),
  // One busy block a day across whatever range was asked for. It used to answer
  // with a single block on the first day whatever the range, which was all an
  // availability bar a day wide could show -- and left a bar covering several
  // days looking as though everyone were free for all but the first of them.
  "Principal/getAvailability": (a) => {
    const from = new Date(String(a.utcStart));
    const to = new Date(String(a.utcEnd));
    const list: Obj[] = [];
    for (
      let day = new Date(from);
      day < to && list.length < 31;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const date = day.toISOString().slice(0, 11);
      list.push({
        utcStart: `${date}13:00:00Z`,
        utcEnd: `${date}14:30:00Z`,
        busyStatus: "confirmed",
        event: null,
      });
    }
    return { accountId: ACCOUNT, list };
  },
  "AddressBook/get": (a) => genericGet(booksFor(a.accountId), "AddressBook")(a),
  "AddressBook/set": (a) => {
    /* Stalwart refuses `isSubscribed` on a book shared read-only -- "You are
       not allowed to modify this address book", confirmed live on 0.16.19
       (2026-08-27) from the account holding the share -- while it accepts the
       identical write on a writable book and on calendars. Whether the book
       the update names can be written is the test, not which account it lives
       in: a group's own writable book accepts, a colleague's read-only one
       refuses, and a mock that got this wrong would agree with a belief that
       shipped. Calendars accept the same write; the difference is the
       server's, not ours. */
    checkIfInState(a, "AddressBook");
    if (a.update) {
      const readonly = Object.keys(a.update as Obj).some((id) => {
        const book = booksFor(a.accountId).find((b) => b.id === id);
        return book && !(book.myRights as Obj).mayWrite;
      });
      if (readonly) {
        const notUpdated: Obj = {};
        for (const id of Object.keys(a.update as Obj))
          notUpdated[id] = {
            type: "forbidden",
            description: "You are not allowed to modify this address book.",
          };
        return {
          accountId: a.accountId,
          oldState: stateOf("AddressBook"),
          newState: stateOf("AddressBook"),
          updated: null,
          notUpdated,
        };
      }
    }
    return genericSet(
      booksFor(a.accountId),
      "ab",
      (o) =>
        Object.assign(o, {
          description: null,
          sortOrder: 0,
          isDefault: false,
          isSubscribed: true,
          shareWith: {},
          myRights: abRights(),
          ...o,
        }),
      "AddressBook",
    )(a);
  },
  "ContactCard/query": (a) => {
    const list =
      a.accountId === SHARED_ACCOUNT
        ? sharedCards
        : a.accountId === GROUP_ACCOUNT
          ? groupCards
          : a.accountId === GROUP2_ACCOUNT || a.accountId === AGENT_ACCOUNT
            ? []
            : cards;
    return {
      accountId: a.accountId ?? ACCOUNT,
      queryState: "1",
      canCalculateChanges: false,
      position: 0,
      ids: list.map((c) => c.id),
      total: list.length,
    };
  },
  "ContactCard/get": (a) =>
    genericGet(
      a.accountId === SHARED_ACCOUNT
        ? sharedCards
        : a.accountId === GROUP_ACCOUNT
          ? groupCards
          : a.accountId === GROUP2_ACCOUNT || a.accountId === AGENT_ACCOUNT
            ? []
            : cards,
      "ContactCard",
    )(a),
  "ContactCard/set": (a) => {
    checkIfInState(a, "ContactCard");
    const list =
      a.accountId === GROUP_ACCOUNT
        ? groupCards
        : a.accountId === SHARED_ACCOUNT
          ? sharedCards
          : a.accountId === GROUP2_ACCOUNT || a.accountId === AGENT_ACCOUNT
            ? []
            : cards;
    if (a.accountId === SHARED_ACCOUNT) {
      /* Grace's books are read-only shares, so nothing in them may be written
         -- created, updated or destroyed. A member of a *group* writes to the
         group's own books (GROUP_ACCOUNT), whose rights say mayWrite. */
      const refuse = (_k: string) => ({
        type: "forbidden",
        description: "You are not allowed to modify this address book.",
      });
      const created = (a.create as Obj | undefined) ? {} : undefined;
      const updated = (a.update as Obj | undefined) ? {} : undefined;
      const destroyed = (a.destroy as string[] | undefined) ? [] : undefined;
      return {
        accountId: a.accountId,
        oldState: stateOf("ContactCard"),
        newState: stateOf("ContactCard"),
        ...(created
          ? {
              created,
              notCreated: Object.fromEntries(
                Object.keys(a.create as Obj).map((k) => [k, refuse(k)]),
              ),
            }
          : {}),
        ...(updated
          ? {
              updated,
              notUpdated: Object.fromEntries(
                Object.keys(a.update as Obj).map((k) => [k, refuse(k)]),
              ),
            }
          : {}),
        ...(destroyed
          ? {
              destroyed,
              notDestroyed: Object.fromEntries(
                (a.destroy as string[]).map((id) => [id, refuse(id)]),
              ),
            }
          : {}),
      };
    }
    return genericSet(list, "cc", undefined, "ContactCard")(a);
  },
  "ContactCard/parse": (a) => {
    const parsed: Obj = {};
    for (const b of a.blobIds as string[]) {
      const t = blobs.get(b)?.data.toString() ?? "";
      const fn = /^FN:(.*)$/m.exec(t)?.[1]?.trim() ?? "Imported";
      const em = /^EMAIL[^:]*:(.*)$/m.exec(t)?.[1]?.trim();
      parsed[b] = [
        {
          "@type": "Card",
          version: "1.0",
          uid: randomUUID(),
          kind: "individual",
          name: { full: fn },
          emails: em ? { e1: { address: em } } : undefined,
        },
      ];
    }
    return { accountId: ACCOUNT, parsed, notParsable: [] };
  },
  "FileNode/query": (a) => {
    const f = (a.filter as Obj) ?? {};
    const fileNodes = nodesFor(a.accountId);
    // `nodeType` is a filter 0.16.19 really applies -- checked live on
    // 2026-08-27, where it returned the two directories out of seven nodes. The
    // mock ignoring it was worse than not having it: the sidebar tree asks for
    // directories and was handed files, which it then drew as folders.
    const list = fileNodes.filter((n) => {
      if (
        f.isTopLevel ? n.parentId != null : f.parentId ? n.parentId !== f.parentId : false
      )
        return false;
      if (f.nodeType && n.nodeType !== f.nodeType) return false;
      return true;
    });
    // Position/limit paging, the way a real JMAP server answers it: the ids
    // come in the server's own order (here, insertion order = creation
    // order), `total` counts every match regardless of the page, and the
    // page never runs past the list. The chat transcript pages backwards
    // from the end through this (older messages on scroll-up, ADR 0005).
    const total = list.length;
    const position = Number(a.position ?? 0);
    const limit = a.limit as number | undefined;
    const ids = list.map((n) => n.id);
    const paged = limit == null ? ids : ids.slice(position, position + limit);
    return {
      accountId: ACCOUNT,
      queryState: "1",
      canCalculateChanges: false,
      position,
      ids: paged,
      total,
    };
  },
  "FileNode/get": (a) => genericGet(nodesFor(a.accountId), "FileNode")(a),
  "FileNode/changes": (a) => {
    // FileNode/changes on a real 0.16 server works from a `sinceState` and
    // reports what changed (verified live 2026-09-07, see the Stalwart skill);
    // the mock answers the same way from its own change log. The log holds
    // creates, updates and destroys and all three are answered here: chat is
    // append-only (ADR 0005), but the agent's documents are rewritten in place
    // and removed again (a job that finishes, a claim that is released), and a
    // watcher told about creates alone would never see either.
    //
    // `newState` is the account's current FileNode state, so a caller that
    // stored it can ask again from there; `hasMoreChanges` is false because
    // the log answers its whole window in one go (see `fileNodeChanges` for
    // what a caller past that window gets instead).
    const since = Number(a.sinceState ?? 0);
    const accountId = String(a.accountId ?? ACCOUNT);
    const relevant = fileNodeChanges.filter(
      (c) => c.accountId === accountId && c.state > since,
    );
    const pick = (k: "created" | "updated" | "destroyed") => [
      ...new Set(relevant.flatMap((c) => c[k])),
    ];
    return {
      accountId: ACCOUNT,
      oldState: String(a.sinceState ?? "1"),
      newState: stateOf("FileNode"),
      hasMoreChanges: false,
      created: pick("created"),
      updated: pick("updated"),
      destroyed: pick("destroyed"),
    };
  },
  "FileNode/set": (a) => {
    const res = genericSet(
      nodesFor(a.accountId),
      "f",
      (o) => {
        const stamp = new Date(now()).toISOString();
        Object.assign(o, {
          created: stamp,
          modified: stamp,
          myRights: fr(),
          shareWith: {},
          size: o.blobId ? (blobs.get(o.blobId as string)?.data.length ?? 0) : null,
          type: o.type ?? null,
          blobId: o.blobId ?? null,
          ...o,
        });
        // Without nodeType, a node is a directory precisely when it carries no
        // file properties. Keep it internally so query and get stay consistent.
        if (!o.nodeType)
          o.nodeType = o.blobId || o.size != null || o.type ? "file" : "directory";
      },
      "FileNode",
    )(a);
    /* A real server pushes a FileNode StateChange after a set, and the chat
       client acts on it -- `FileNode/changes` runs and the store reconciles
       what came back. Keep the mock announcing sets the way Stalwart does,
       so the re-sync path (and the unread badge driven by it) is exercised
       here rather than only on a live instance. */
    const created = Object.values(
      (res.created ?? {}) as Record<string, { id: string }>,
    ).map((x) => x.id);
    const updated = Object.keys(res.updated ?? {});
    const destroyed = (res.destroyed as string[] | undefined) ?? [];
    if (created.length || updated.length || destroyed.length) {
      /* All three, not just the creates: a job document rewritten in place and
         a lease released are both invisible to a client that only ever hears
         about creates. The change is recorded at the state the set left
         (`newState`), which is the token its readers are handed. */
      recordFileNodeChange(
        String(a.accountId ?? ACCOUNT),
        { created, updated, destroyed },
        String(res.newState),
      );
      broadcast(["FileNode"], (a.accountId as string) ?? ACCOUNT);
    }
    return res;
  },
};

/* ---------- http ---------- */
function unauthorized(res: ServerResponse) {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Basic realm="mock"',
  });
  res.end(JSON.stringify({ type: "about:blank", status: 401, title: "Unauthorized" }));
}

interface Identity {
  /** The principal the request acts as (the target under impersonation). */
  username: string;
  /** The principal's own (personal) account id. */
  accountId: string;
  /** Whether the presented secret was an app password of that principal. */
  appPassword: boolean;
}

/** Per-principal credential state; the demo's is the exported `account`. */
const principalState = (username: string) =>
  username === TARGET_USER
    ? targetAccount
    : username === AGENT_ADDRESS
      ? agentAccount
      : account;

function checkOtpFor(state: typeof account, code: string | undefined): boolean {
  if (!state.otpUrl) return true;
  const params = parseOtpauthUrl(state.otpUrl);
  return Boolean(code && params && verifyTotp(params, code));
}

/**
 * Validate a principal's secret; returns the credential kind, or null.
 * `refuseAppPassword` mirrors Stalwart refusing app passwords for
 * impersonation. App passwords skip the second factor, which is exactly what
 * lets a webmail session survive 2FA being switched on.
 */
function validCredential(
  username: string,
  secret: string,
  refuseAppPassword: boolean,
): "password" | "app-password" | null {
  const state = principalState(username);
  if (state.appPasswords.some((a) => a.secret === secret)) {
    return refuseAppPassword ? null : "app-password";
  }
  if (!state.otpUrl) return secret === state.password ? "password" : null;
  const at = secret.lastIndexOf("$");
  if (at < 0) return null;
  return secret.slice(0, at) === state.password &&
    checkOtpFor(state, secret.slice(at + 1))
    ? "password"
    : null;
}

const knownPrincipal = (username: string) =>
  // The refused principal is listed in the directory and is one the mock will
  // not seal a session onto, in either direction (see `REFUSED_USER`).
  username !== REFUSED_USER &&
  (username === USER ||
    username === TARGET_USER ||
    // The agent principal is a real account in the directory (ADR 0003), so it
    // authenticates by itself and an admin may also impersonate it to manage it.
    username === AGENT_ADDRESS ||
    // The impersonation probe acts on a real account from the directory, the
    // way a force would; the directory principals are valid targets for a
    // master that holds the right (group principals are refused separately).
    principals.some((p) => p.email === username));

/**
 * Authenticate the request and say who it acts as.
 *
 * Two shapes of username: a plain principal, and Stalwart 0.16's composite
 * impersonation username `{target}%{master}`, which authenticates as the
 * target using the *master's* credentials. The mock reproduces what the 0.16
 * source does (checked 2026-09-07, stalwartlabs/stalwart `authentication.rs`,
 * v0.16.21; re-verify against a live server with a dated comment per repo
 * convention): the username splits at the first `%`; a master identical to
 * the target is not impersonation; app passwords are refused for
 * impersonation; and the master must hold the impersonation right, which
 * `/api/account` reports as the `impersonate` permission (ADR 0001) — the
 * demo holds it exactly when it is a Stalwart admin, matching the live
 * server where the admin role bundles it.
 *
 * Group principals never authenticate, directly or as an impersonation
 * target — Stalwart 0.16 has no credential for them and refuses the
 * composite with a 403 (live-verified 2026-09-09). Members reach the
 * group's own account through their own session instead (ADR 0005); the
 * mock reproduces the refusal so no surface can lean on group
 * impersonation.
 */
const isGroupPrincipal = (username: string): boolean =>
  principals.some((p) => p.type === "group" && p.email === username);

/**
 * The account a known individual actually owns. Impersonation lands on the
 * target's own account: the demo's, the target principal's (ADR 0001).
 * Group principals are refused before this runs; directory individuals the
 * mock does not give an account to resolve to the demo account, matching a
 * probe that only ever names a real account.
 */
const principalAccountId = (username: string): string => {
  if (username === USER) return ACCOUNT;
  if (username === TARGET_USER) return TARGET_ACCOUNT;
  if (username === AGENT_ADDRESS) return AGENT_ACCOUNT;
  return ACCOUNT;
};

function resolveIdentity(req: IncomingMessage): Identity | null {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return null;
  const raw = Buffer.from(h.slice(6), "base64").toString();
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const u = raw.slice(0, sep);
  const p = raw.slice(sep + 1);
  const at = u.indexOf("%");
  if (at >= 0) {
    const target = u.slice(0, at);
    const master = u.slice(at + 1);
    if (target === master) {
      // Stalwart drops a master identical to the target: a plain login.
      return resolvePlain(target, p);
    }
    // The mock has one impersonator: the demo user. A composite naming any
    // other master (or target) fails like an unknown account; the master
    // must hold Stalwart's `Impersonate` permission, which the resolved
    // permission list reports (ADR 0001). A group principal as target is
    // refused like a real 0.16 server (see above).
    if (master !== USER) return null;
    if (!validCredential(master, p, true)) return null;
    if (!permissionsOf(master).includes("impersonate")) return null;
    if (!knownPrincipal(target) || isGroupPrincipal(target)) return null;
    return {
      username: target,
      accountId: principalAccountId(target),
      appPassword: false,
    };
  }
  return resolvePlain(u, p);
}

function resolvePlain(username: string, secret: string): Identity | null {
  if (!knownPrincipal(username) || isGroupPrincipal(username)) return null;
  const kind = validCredential(username, secret, false);
  if (!kind) return null;
  return {
    username,
    accountId:
      username === TARGET_USER
        ? TARGET_ACCOUNT
        : username === AGENT_ADDRESS
          ? AGENT_ACCOUNT
          : ACCOUNT,
    appPassword: kind === "app-password",
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** The session-level capabilities: identical for every principal. */
const sessionCapabilities = {
  "urn:ietf:params:jmap:core": {
    maxSizeUpload: 50000000,
    maxConcurrentUpload: 4,
    maxSizeRequest: 10000000,
    maxConcurrentRequests: 4,
    maxCallsInRequest: 16,
    maxObjectsInGet: MAX_OBJECTS,
    maxObjectsInSet: MAX_OBJECTS,
    collationAlgorithms: ["i;ascii-casemap"],
  },
  "urn:ietf:params:jmap:mail": {},
  "urn:ietf:params:jmap:submission": {},
  "urn:ietf:params:jmap:vacationresponse": {},
  "urn:ietf:params:jmap:webpush-vapid": {
    applicationServerKey:
      "BBvig2GPmqohMJJHMzp6bTKviHibYiVCyAY8gdq2fPhS-9YfO9_0TnhMyZ0a0JxTsbCqd3zm1rEiXsXsL3jveJY",
  },
  "urn:ietf:params:jmap:emailpush": {},
  "urn:ietf:params:jmap:sieve": { implementation: "mock" },
  "urn:ietf:params:jmap:calendars": {},
  "urn:ietf:params:jmap:calendars:parse": {},
  "urn:ietf:params:jmap:contacts": {},
  "urn:ietf:params:jmap:contacts:parse": {},
  "urn:ietf:params:jmap:principals": {},
  "urn:ietf:params:jmap:principals:availability": {},
  "urn:ietf:params:jmap:quota": {},
  "urn:ietf:params:jmap:blob": {},
  "urn:ietf:params:jmap:filenode": {},
};

/** The capabilities of a principal's own account. */
const personalCapabilities = (): Obj => ({
  "urn:ietf:params:jmap:mail": {},
  "urn:ietf:params:jmap:submission": {
    maxDelayedSend: MAX_DELAYED_SEND,
    submissionExtensions: {
      FUTURERELEASE: [],
      SIZE: [],
      DSN: [],
      DELIVERYBY: [],
      "MT-PRIORITY": ["MIXER"],
      REQUIRETLS: [],
    },
  },
  "urn:ietf:params:jmap:vacationresponse": {},
  "urn:ietf:params:jmap:sieve": {},
  "urn:ietf:params:jmap:calendars": {},
  "urn:ietf:params:jmap:contacts": {},
  "urn:ietf:params:jmap:principals": {},
  "urn:ietf:params:jmap:quota": {},
  "urn:ietf:params:jmap:filenode": {},
  ...(NO_REGISTRY ? {} : { "urn:stalwart:jmap": {} }),
});

/**
 * The JMAP session resource, per principal.
 *
 * The mock knows three principals: the demo user, whose session also lists
 * the account somebody shared with them and the two group mailboxes (ADR
 * 0005); the agent principal (ADR 0003), whose session lists the group
 * accounts it was granted and nothing else of anybody's; and the target
 * principal of the impersonation flows (ADR 0001), whose session is a single
 * fresh personal account. Admin state is not a
 * session fact — it lives in the `/api/account` permission list (ADR 0001),
 * which is why no account in here marks an admin.
 *
 * The shared account carries the *same* capability list as a personal one,
 * because that is what Stalwart does -- checked on 0.16.19 (2026-08-27),
 * where a shared account advertised mail, calendars, contacts and the rest,
 * identical to a personal one, whatever had actually been shared. Giving the
 * mock a truthful shared account is the only way to exercise the Files
 * "Shared with me" list, and the only way this stays honest about what can
 * be inferred from a capability, which is nothing.
 *
 * `authType` is the one thing this document carries that a real 0.16
 * session resource does not: the proxy needs to know whether the session may
 * be put behind the forced-password-change wall (ADR 0001), and Stalwart's
 * session resource does not expose how the principal authenticated (checked
 * 2026-09-07, stalwartlabs/stalwart `crates/jmap/src/api/session.rs`, v0.16.21;
 * re-verify against a live server with a dated comment per repo convention).
 * The mock reports it because it validates the secret itself; a real
 * deployment cannot distinguish app-password sessions today, so they are
 * treated as password sessions there.
 */
const sessionFor = (identity: Identity) => ({
  capabilities: sessionCapabilities,
  accounts: {
    /* A share is a person's business, a group is a membership. The agent is
       granted on the groups (ADR 0003), so it is handed those accounts --
       and never the account somebody shared with the demo user. */
    ...(identity.username === USER
      ? {
          [SHARED_ACCOUNT]: {
            name: "grace@example.org",
            isPersonal: false,
            isReadOnly: false,
            accountCapabilities: SHARED_CAPS,
          },
        }
      : {}),
    ...(identity.username === USER || identity.username === AGENT_ADDRESS
      ? {
          [GROUP_ACCOUNT]: {
            name: "team@example.org",
            isPersonal: false,
            isReadOnly: false,
            accountCapabilities: SHARED_CAPS,
          },
        }
      : {}),
    /* `design@example.org` is the agent's own group: it grants the agent and
       not the demo user, which is the membership the group surfaces read -- the
       administrator who is not a member reaches it by the agent's grant. */
    ...(identity.username === AGENT_ADDRESS
      ? {
          [GROUP2_ACCOUNT]: {
            name: "design@example.org",
            isPersonal: false,
            isReadOnly: false,
            accountCapabilities: SHARED_CAPS,
          },
        }
      : {}),
    [identity.accountId]: {
      name: identity.username,
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: personalCapabilities(),
    },
  },
  primaryAccounts: {
    ...Object.fromEntries(
      [
        "mail",
        "submission",
        "vacationresponse",
        "sieve",
        "calendars",
        "contacts",
        "principals",
        "quota",
        "filenode",
        "blob",
      ].map((c) => [`urn:ietf:params:jmap:${c}`, identity.accountId]),
    ),
    ...(NO_REGISTRY ? {} : { "urn:stalwart:jmap": identity.accountId }),
  },
  username: identity.username,
  apiUrl: `http://127.0.0.1:${PORT}/jmap/`,
  downloadUrl: `http://127.0.0.1:${PORT}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `http://127.0.0.1:${PORT}/jmap/upload/{accountId}/`,
  eventSourceUrl: `http://127.0.0.1:${PORT}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: String(state.n),
  ...(identity.appPassword ? { authType: "app-password" } : {}),
});

const sseClients = new Set<ServerResponse>();
/**
 * What changed and when, so `Email/changes` can answer honestly.
 *
 * Each entry records the account it happened in -- a real server answers
 * `Email/changes` per account, and one shared log would hand a group's agent
 * the demo user's mail -- and the Email state the change is visible at, which
 * is what a client asking from a recorded state is matched against. Those
 * states are the mock's own counters, so the comparison is numeric where a
 * real server's state strings are opaque.
 *
 * The log is a bounded window: past 200 entries the oldest are dropped, and a
 * client that fell further behind is served an incomplete answer with
 * `hasMoreChanges: false`. A real server pages the rest instead -- the one
 * shape of this the mock does not reproduce. The window is far longer than any
 * test needs, and the client refetches from scratch if it ever falls behind.
 */
const emailChanges: Array<{
  accountId: string;
  state: number;
  created: string[];
  updated: string[];
  destroyed: string[];
}> = [];
function recordEmailChange(
  accountId: string,
  change: { created?: string[]; updated?: string[]; destroyed?: string[] },
  state: string,
) {
  emailChanges.push({
    accountId,
    state: Number(state),
    created: change.created ?? [],
    updated: change.updated ?? [],
    destroyed: change.destroyed ?? [],
  });
  if (emailChanges.length > 200) emailChanges.splice(0, emailChanges.length - 200);
}

/**
 * What FileNodes were created, updated or destroyed, so `FileNode/changes` can
 * answer honestly. Group chat (ADR 0005) rides this rail: a message is a node
 * created in the group account's `gilbert/chat` folder, and another member's
 * client re-syncs by asking what changed since the state it last saw -- the
 * same shape Email/changes gives the mail stores. The agent's documents ride it
 * too, and there an update counts as much as a create: a job document is
 * rewritten in place and a lease is released by removing one, so a client told
 * about creates alone would never see either.
 */
const fileNodeChanges: Array<{
  accountId: string;
  state: number;
  created: string[];
  updated: string[];
  destroyed: string[];
}> = [];
function recordFileNodeChange(
  accountId: string,
  change: { created?: string[]; updated?: string[]; destroyed?: string[] },
  state: string,
) {
  fileNodeChanges.push({
    accountId,
    state: Number(state),
    created: change.created ?? [],
    updated: change.updated ?? [],
    destroyed: change.destroyed ?? [],
  });
  if (fileNodeChanges.length > 200)
    fileNodeChanges.splice(0, fileNodeChanges.length - 200);
}

function broadcast(types: string[], accountId: string = ACCOUNT) {
  /* Each type carries its own state, the way a real StateChange does: a client
     that watches mail must not be told FileNode's state as if it were Email's. */
  const payload = `event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed: { [accountId]: Object.fromEntries(types.map((t) => [t, stateOf(t)])) } })}\n\n`;
  for (const c of sseClients) c.write(payload);
}

/** Exported so tests can drive the mock in-process and shut it down. */
export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  /*
   * The mock's clock, moved by whoever is testing it (see `now`). It is
   * mock-only by construction -- no real server carries such a route, so
   * nothing in the product can come to depend on it -- and it answers before
   * authentication because its callers are tests that have not signed in yet.
   * The mock binds 127.0.0.1 and nowhere else, so it is not a remote control.
   */
  if (url.pathname === "/mock/clock" && req.method === "POST") {
    let body: { now?: string; advanceMs?: number } = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}") as typeof body;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "the body must be JSON" }));
    }
    /* The instant the mock is being moved to, resolved before the offset is
       stored: the response reports that exact instant, so a test does not have
       to read a clock that is already ticking again. */
    let target: number | null = null;
    if (typeof body.now === "string") {
      const at = Date.parse(body.now);
      if (Number.isNaN(at)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "now must be an ISO 8601 instant" }));
      }
      target = at;
    } else if (typeof body.advanceMs === "number" && Number.isFinite(body.advanceMs)) {
      target = now() + body.advanceMs;
    } else {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "send { now } or { advanceMs }" }));
    }
    clockOffsetMs = target - Date.now();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ now: new Date(target).toISOString() }));
  }
  const identity = resolveIdentity(req);
  if (!identity) return unauthorized(res);
  if (url.pathname === "/.well-known/jmap" || url.pathname === "/jmap/session") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(sessionFor(identity)));
  }
  // The account info endpoint; the only place a server reports its edition
  // and the authenticated principal's resolved permission list (ADR 0001).
  if (url.pathname === "/api/account" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        permissions: permissionsOf(identity.username),
        edition: "oss",
        locale: MOCK_LOCALE,
      }),
    );
  }
  if (url.pathname === "/jmap/" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString()) as {
      methodCalls: [string, Obj, string][];
      using?: string[];
    };
    // A capability the server cannot parse fails the whole request, not the one
    // call that wanted it - which is why an over-eager `using` is so damaging.
    // Stalwart decides this by parsing the urn, not by looking it up in the
    // session, so a capability it hands out per-account is still usable here:
    // `urn:stalwart:jmap` never appears in the session-level capabilities and
    // the registry calls that name it work all the same.
    const known = new Set([
      ...Object.keys(sessionCapabilities),
      ...Object.keys(personalCapabilities()),
    ]);
    const unknown = (body.using ?? []).find((u) => !known.has(u));
    if (unknown) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          type: "urn:ietf:params:jmap:error:unknownCapability",
          status: 400,
          detail: `Unknown capability: ${JSON.stringify(unknown)}`,
        }),
      );
    }
    // The directory gate (`directoryGate`): a session the server will not let
    // query the directory is refused here, before any method runs, rather than
    // in a method answer — which is why a client that reads the directory has
    // to treat a refused request as a refused read.
    if (
      !directoryGate.open &&
      body.methodCalls.some(([name]) => name === "Principal/query")
    ) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          type: "about:blank",
          status: 403,
          title: "Forbidden",
          detail: "Directory queries are not allowed for this account.",
        }),
      );
    }
    const responses: [string, Obj, string][] = [];
    const touched = new Map<string, Set<string>>();
    const creations: Record<string, string> = {};
    for (const [name, rawArgs, id] of body.methodCalls) {
      const h = handlers[name];
      // The registry, and every x: method with it, arrived in 0.16.
      if (!h) {
        responses.push(["error", { type: "unknownMethod" }, id]);
        continue;
      }
      try {
        const args = resolveRefs(rawArgs, responses, creations);
        enforceLimits(name, args);
        const r = h(args, identity);
        responses.push([name, r as Obj, id]);
        for (const [cid, obj] of Object.entries(((r as Obj).created as Obj) ?? {})) {
          const newId = (obj as Obj)?.id;
          if (typeof newId === "string") creations[cid] = newId;
        }
        if (name.endsWith("/set") || name.endsWith("/import")) {
          const type = name.split("/")[0]!;
          const accountId = (args as Obj).accountId ?? ACCOUNT;
          const set = touched.get(accountId as string) ?? new Set<string>();
          set.add(type);
          touched.set(accountId as string, set);
        }
      } catch (err) {
        if (err instanceof MethodError)
          responses.push(["error", { type: err.type, description: err.message }, id]);
        else
          responses.push(["error", { type: "serverFail", description: String(err) }, id]);
      }
    }
    if (touched.size) {
      nextState();
      setTimeout(() => {
        /* A state change names the account that changed, so a group write is
           announced for the group's account — the reader's session has it too,
           and their client refreshes the shared view from there. */
        for (const [accountId, types] of touched) {
          broadcast(
            [...types, ...(types.has("Email") ? ["Mailbox", "Thread"] : [])],
            accountId,
          );
        }
      }, 50);
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({ methodResponses: responses, sessionState: String(state.n) }),
    );
  }
  if (url.pathname.startsWith("/jmap/upload/") && req.method === "POST") {
    const data = await readBody(req);
    const type = req.headers["content-type"] ?? "application/octet-stream";
    /*
     * An upload stores a blob and writes no node, so this simulation leaves
     * every state token where it was — which is point (d) of the owed probe in
     * `checkIfInState`: whether a real 0.16 server agrees. It matters because
     * the production write path uploads the blob **after** reading the token
     * and before the conditional write (`writeAppFileIn`), so a server that
     * moved the token on upload would refuse every conditional write the agent
     * makes — it would never claim a unit and never append an audit entry. The
     * choice is pinned by `compare-and-set.test.ts` so a change here is noticed
     * rather than inherited.
     */
    const blobId = putBlob(data, type);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({ accountId: ACCOUNT, blobId, type, size: data.length }),
    );
  }
  if (url.pathname.startsWith("/jmap/download/")) {
    const [, , , , blobId] = url.pathname.split("/");
    const b = blobs.get(blobId ?? "");
    if (!b) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": url.searchParams.get("accept") ?? b.type,
      "content-length": b.data.length,
    });
    return res.end(b.data);
  }
  if (url.pathname.startsWith("/jmap/eventsource")) {
    /*
     * The `ping` query parameter, and what comes back for it.
     *
     * **Confirmed live on 0.16.21 (2026-09-06):** the interval is in **seconds**
     * — `data: {"interval": 30}` — where up to 0.16.20 the same field carried
     * milliseconds. The server floors it at 30 s (asking for 1, 2 or 5 all
     * answered 30 and pinged every 30 s) and honours anything above (45 pinged
     * at 45 s and said 45, 60 at 60 and said 60). `ping=0` disables pings
     * altogether; a value that is not a number at all — `abc`, or empty — is a
     * 400 before the stream opens.
     *
     * The first ping arrives one whole interval in, not on connect, so nothing
     * is written here: `flushHeaders` opens the stream on its own. A mock that
     * pinged immediately would let a client treat the first ping as an
     * connection-established signal and hang forever against the real thing.
     */
    const raw = url.searchParams.get("ping");
    const asked = Number(raw);
    if (raw === null || raw === "" || !Number.isInteger(asked) || asked < 0) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ type: "urn:ietf:params:jmap:error:notRequest", status: 400 }),
      );
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.flushHeaders();
    sseClients.add(res);
    const interval = asked === 0 ? 0 : Math.max(asked, PING_FLOOR_SECONDS);
    const t = interval
      ? setInterval(
          () => res.write(`event: ping\ndata: {"interval": ${interval}}\n\n`),
          interval * 1000,
        )
      : null;
    req.on("close", () => {
      if (t) clearInterval(t);
      sseClients.delete(res);
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}).listen(PORT, "127.0.0.1", () => {
  console.log(
    `[mock-stalwart] listening on http://127.0.0.1:${PORT}  (login: ${USER} / ${PASS})`,
  );
  console.log(
    `[mock-stalwart] run the app with: STALWART_URL=http://127.0.0.1:${PORT} npm run dev`,
  );
});

// Periodically inject a new inbox email to demo push
setInterval(() => {
  const p = people[Math.floor(Math.random() * people.length)]!;
  const injected = addEmail({
    from: [p[0]!, p[1]!],
    subject: `Live update ${new Date(now()).toLocaleTimeString()}`,
    daysAgo: 0,
    mailbox: "inbox",
    unread: true,
    html: true,
  });
  recount();
  /* The injected message is a real arrival: it moves the Email state and lands
     in the change log, so a client reconciling from a recorded state sees it. */
  bumpState("Email");
  recordEmailChange(ACCOUNT, { created: [String(injected.id)] }, stateOf("Email"));
  broadcast(["Email", "Mailbox", "Thread"]);
}, 120_000).unref();

// Post demo chat messages from other members every 30 s per group, so the
// chat panel's live rail has something to show in dev:mock and the group
// switcher has traffic in both teams (ADR 0005). A group's `gilbert/chat`
// folder existing means chat is provisioned -- the client's warm sync
// creates it at sign-in for a session that holds the group.
function postChatDemo(nodes: Obj[], accountId: string, senders: number) {
  const gilbert = nodes.find((n) => n.nodeType === "directory" && n.name === "gilbert");
  const chat = gilbert
    ? nodes.find(
        (n) =>
          n.nodeType === "directory" && n.parentId === gilbert.id && n.name === "chat",
      )
    : undefined;
  if (!chat) return;
  const [name, email] = people[Math.floor(Math.random() * senders)]!;
  const doc = JSON.stringify({
    v: 1,
    from: email,
    at: new Date(now()).toISOString(),
    text: `Live message ${new Date(now()).toLocaleTimeString()} — from ${name}`,
  });
  const id = `f${randomUUID().slice(0, 6)}`;
  nodes.push({
    id,
    parentId: chat.id,
    nodeType: "file",
    blobId: putBlob(doc, "application/json"),
    size: doc.length,
    name: `${id}.json`,
    type: "application/json",
    created: new Date(now()).toISOString(),
    modified: new Date(now()).toISOString(),
    myRights: fr(),
    shareWith: {},
  });
  /* A node the mock itself adds: the FileNode state moves first, so the change
     is recorded at a state its readers can advance to. */
  bumpState("FileNode");
  recordFileNodeChange(accountId, { created: [id] }, stateOf("FileNode"));
  broadcast(["FileNode"], accountId);
}
setInterval(() => {
  postChatDemo(groupFileNodes, GROUP_ACCOUNT, 2);
  postChatDemo(group2FileNodes, GROUP2_ACCOUNT, 2);
}, 30_000).unref();
