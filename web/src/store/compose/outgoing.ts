import { ApiError, client } from "@/jmap/client";
import type { EmailAddress, EmailBodyPart, Id, Identity } from "@/jmap/types";
import { BASE_PATH } from "@/lib/basePath";
import { uid } from "@/lib/format";
import { t as translate } from "@/lib/i18n";
import { holdUntil } from "@/lib/schedule";
import { htmlToText } from "@/lib/text";
import { useMail } from "../mail";
import type { Draft, SendTarget } from "./types";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/*
 * How an inline image points at a blob while it is being edited, and how to
 * find one again on the way out.
 *
 * `client.downloadUrl` builds these, so under a subpath they carry the mount
 * prefix -- and the patterns have to as well. Neither would have failed
 * loudly. A bare `/api/blob/` still appears *inside* `/mail/api/blob/...`, so
 * the unanchored replacement would have matched only the tail and left `/mail`
 * standing in front of a `cid:` reference; the anchored match would simply
 * have missed, and the message would go out linking to the sender's own
 * webmail where the picture should be.
 */
const BLOB_URL_PREFIX = `${BASE_PATH}/api/blob/`;
const BLOB_URL_RE = escapeRe(BLOB_URL_PREFIX);
/**
 * The identities a draft's account sends with.
 *
 * The list on screen when the draft belongs to the account being read, and the
 * cached list of its own otherwise: a composer outlives a mailbox switch, and
 * its From list must not become the new account's.
 */
export function identitiesFor(
  accountId: Id,
  mail: ReturnType<typeof useMail.getState>,
): Identity[] {
  return accountId === mail.accountId
    ? mail.identities
    : (mail.identitiesByAccount[accountId] ?? []);
}
/** Build the JMAP Email creation object from a draft. */
export async function buildEmailObject(
  d: Draft,
  opts: { forSend: boolean; mailboxId?: Id | null; send?: SendTarget },
): Promise<Record<string, unknown>> {
  const mail = useMail.getState();
  /*
   * The draft's own account, not whatever mailbox is on screen: a composer
   * stays open across a switch, and the identity, the Drafts folder and the
   * create are all that account's. The send path passes the account it
   * captured when Send was pressed (`SendTarget`).
   */
  const accountId = opts.send?.accountId ?? d.accountId;
  const identities = identitiesFor(accountId, mail);
  const ident =
    opts.send?.identity ??
    identities.find((i) => i.id === d.identityId) ??
    mail.defaultIdentityFor(accountId);
  if (!ident) throw new Error(translate("No sending identity available"));
  const from: EmailAddress = { name: ident.name || null, email: ident.email };

  let html = d.format === "html" ? d.html : "";
  const text = d.format === "html" ? htmlToText(d.html) : d.text;

  // Inline attachments shown via blob URLs in the editor → back to cid: references.
  for (const a of d.attachments) {
    if (a.inline && a.cid && a.blobId && html) {
      const re = new RegExp(`${BLOB_URL_RE}[^"' )]*${escapeRe(a.blobId)}[^"' )]*`, "g");
      html = html.replace(re, `cid:${a.cid}`);
    }
  }
  // Inline images (data: URLs from the editor) → upload and reference by cid.
  const related: EmailBodyPart[] = [];
  const relatedInline: Array<{ blobId: Id; type: string; name: string; cid: string }> =
    [];
  // Images referencing stored blobs (e.g. signature logos kept in Files) → inline cid parts.
  if (html?.includes(BLOB_URL_PREFIX)) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of Array.from(doc.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const m = new RegExp(`^${BLOB_URL_RE}([^/]+)/([^/]+)/([^?]+)(?:\\?([^#]*))?`).exec(
        src,
      );
      if (!m) continue;
      const blobId = decodeURIComponent(m[2]!);
      const name = decodeURIComponent(m[3]!);
      const type = new URLSearchParams(m[4] ?? "").get("accept") ?? "image/png";
      const cid = `${uid("img")}@gilbert`;
      img.setAttribute("src", `cid:${cid}`);
      relatedInline.push({ blobId, type, name, cid });
    }
    html = doc.body.innerHTML;
  }
  if (html?.includes("data:image/")) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = Array.from(doc.querySelectorAll("img")).filter((i) =>
      i.getAttribute("src")?.startsWith("data:image/"),
    );
    for (const img of imgs) {
      const src = img.getAttribute("src")!;
      const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(src);
      if (!m) continue;
      const bin = atob(m[2]!);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const up = await client.upload(accountId, new Blob([bytes], { type: m[1]! }), {
        type: m[1]!,
      });
      const cid = `${uid("img")}@gilbert`;
      img.setAttribute("src", `cid:${cid}`);
      relatedInline.push({
        blobId: up.blobId,
        type: m[1]!,
        name: `image.${m[1]!.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`,
        cid,
      });
    }
    html = doc.body.innerHTML;
  }
  // Existing inline attachments referenced via cid (from reply/forward/draft) stay as related parts.
  for (const a of d.attachments) {
    if (a.inline && a.cid && a.blobId && html.includes(`cid:${a.cid}`))
      relatedInline.push({ blobId: a.blobId, type: a.type, name: a.name, cid: a.cid });
  }
  for (const r of relatedInline) {
    related.push({
      partId: null,
      blobId: r.blobId,
      size: 0,
      name: r.name,
      type: r.type,
      charset: null,
      disposition: "inline",
      cid: r.cid,
    });
  }

  const bodyValues: Record<string, { value: string }> = {};
  const alternative: Record<string, unknown>[] = [];
  bodyValues.text = { value: text };
  alternative.push({ partId: "text", type: "text/plain" });
  if (html) {
    bodyValues.html = { value: wrapHtmlDocument(html) };
    const htmlPart: Record<string, unknown> = { partId: "html", type: "text/html" };
    if (related.length)
      alternative.push({
        type: "multipart/related",
        subParts: [htmlPart, ...related.map(stripPart)],
      });
    else alternative.push(htmlPart);
  }
  const regular = d.attachments.filter((a) => !a.inline && a.blobId && !a.error);
  let bodyStructure: Record<string, unknown>;
  const alt = html
    ? { type: "multipart/alternative", subParts: alternative }
    : alternative[0]!;
  if (regular.length) {
    bodyStructure = {
      type: "multipart/mixed",
      subParts: [
        alt,
        ...regular.map((a) => ({
          blobId: a.blobId,
          type: a.type,
          name: a.name,
          disposition: "attachment",
        })),
      ],
    };
  } else bodyStructure = alt;

  const obj: Record<string, unknown> = {
    from: [from],
    subject: d.subject,
    sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    bodyStructure,
    bodyValues,
    "header:User-Agent:asText": "gilbert/2.0",
  };
  // Header properties are omitted when empty, never sent as null: JMAP servers
  // are entitled to reject null for a header field (Stalwart parses these as
  // address lists and fails the whole create), and on a create there is no
  // previous value that would need clearing.
  const replyTo = d.replyTo.length ? d.replyTo : (ident.replyTo ?? []);
  if (d.to.length) obj.to = d.to;
  if (d.cc.length) obj.cc = d.cc;
  /*
   * The draft's own Bcc and no fallback to the identity's, unlike `replyTo`
   * below: that address was written into this draft when it was opened, where
   * the sender could see it (`identityBcc`), and adding it again here would put
   * back a copy somebody had deliberately taken off.
   */
  if (d.bcc.length) obj.bcc = d.bcc;
  if (replyTo.length) obj.replyTo = replyTo;
  if (d.inReplyTo?.length) obj.inReplyTo = d.inReplyTo;
  if (d.references?.length) obj.references = d.references;
  if (d.priority === "high") {
    obj["header:X-Priority:asText"] = "1 (Highest)";
    obj["header:Importance:asText"] = "High";
  } else if (d.priority === "low") {
    obj["header:X-Priority:asText"] = "5 (Lowest)";
    obj["header:Importance:asText"] = "Low";
  }
  if (d.requestReceipt) obj["header:Disposition-Notification-To:asAddresses"] = [from];
  if (!opts.forSend) {
    const draftsId = mail.roleId("drafts", accountId);
    obj.mailboxIds = draftsId
      ? { [draftsId]: true }
      : { [mail.roleId("inbox", accountId)!]: true };
    obj.keywords = { $draft: true, $seen: true };
  } else {
    const sentId =
      opts.mailboxId ??
      opts.send?.sentId ??
      mail.roleId("sent", accountId) ??
      mail.roleId("inbox", accountId);
    obj.mailboxIds = { [sentId!]: true };
    obj.keywords = { $seen: true };
  }
  return obj;
}
function stripPart(p: EmailBodyPart): Record<string, unknown> {
  return {
    blobId: p.blobId,
    type: p.type,
    name: p.name,
    disposition: p.disposition,
    cid: p.cid,
  };
}

function wrapHtmlDocument(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;">${body}</body></html>`;
}
/**
 * The `EmailSubmission/set` create for a message, and the `Email` patch that
 * files it once the server accepts it.
 *
 * A scheduled send differs in two places: the envelope carries a
 * `HOLDUNTIL` parameter (RFC 4865 FUTURERELEASE, which is how JMAP asks for a
 * delay -- `sendAt` itself is read-only and server-derived), and the message is
 * filed under Scheduled rather than Sent, because it has not been sent yet.
 */
export function buildSubmission(opts: {
  identityId: Id;
  fromEmail: string;
  emailRef: string;
  rcpts: { email: string }[];
  sentId: Id | null;
  draftsId: Id | null;
  scheduledId: Id | null;
  sendAt: number | null;
}): { create: Record<string, unknown>; onSuccessUpdateEmail: Record<string, unknown> } {
  const scheduled = opts.sendAt !== null;
  const mailFrom: Record<string, unknown> = { email: opts.fromEmail };
  if (scheduled) mailFrom.parameters = { HOLDUNTIL: holdUntil(new Date(opts.sendAt!)) };
  const filedIn = scheduled ? opts.scheduledId : opts.sentId;
  const onSuccess: Record<string, unknown> = {
    "keywords/$draft": null,
    "keywords/$seen": true,
  };
  if (filedIn) onSuccess[`mailboxIds/${filedIn}`] = true;
  if (opts.draftsId && opts.draftsId !== filedIn)
    onSuccess[`mailboxIds/${opts.draftsId}`] = null;
  if (scheduled && opts.sentId && opts.sentId !== filedIn)
    onSuccess[`mailboxIds/${opts.sentId}`] = null;
  return {
    create: {
      identityId: opts.identityId,
      emailId: opts.emailRef,
      envelope: { mailFrom, rcptTo: opts.rcpts },
    },
    onSuccessUpdateEmail: onSuccess,
  };
}
/**
 * Whether a failed request may still have been carried out. A refusal — any
 * status below 500, a request timeout (408) aside — means the server did not
 * run it; no answer, a 5xx, or a 408 means it may have.
 */
export function sendOutcomeUnknown(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 408;
  return true;
}
