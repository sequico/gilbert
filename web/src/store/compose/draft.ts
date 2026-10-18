import { htmlSignatureBlock, textSignatureBlock } from "@gilbert/shared/signature";
import { client } from "@/jmap/client";
import type { Email, EmailAddress, Id, Identity } from "@/jmap/types";
import { parseMailto, sameAddress, uniqueAddresses } from "@/lib/address";
import { uid } from "@/lib/format";
import { sanitizeEditorHtml, sanitizeEmailHtml } from "@/lib/html";
import { remoteImagesAllowed } from "@/lib/remoteImages";
import { escapeHtml, htmlToText, quoteText, textToHtml } from "@/lib/text";
import { useContacts } from "../contacts";
import { useMail } from "../mail";
import { settings } from "../settings";
import type { ComposeAttachment, Draft, Priority } from "./types";

export function blankDraft(init: Partial<Draft> = {}): Draft {
  const s = settings();
  return {
    key: uid("d"),
    accountId: useMail.getState().accountId ?? "",
    draftId: null,
    identityId: null,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "",
    html: "",
    text: "",
    format: s.composeFormat,
    attachments: [],
    inReplyTo: null,
    references: null,
    relatedEmailId: null,
    relatedKeyword: null,
    requestReceipt: s.requestReadReceipt,
    priority: "normal",
    showCc: false,
    showBcc: false,
    showReplyTo: false,
    minimized: false,
    maximized: false,
    dirty: false,
    savedAt: null,
    saving: false,
    error: null,
    signatureHtml: "",
    replyMode: null,
    sendAt: null,
    ...init,
  };
}
export function signatureBlock(
  identity: Identity | undefined,
  format: "html" | "text",
): string {
  if (!identity) return "";
  if (format === "text") return textSignatureBlock(identity.textSignature);
  /*
   * `ihm-signature` and `data-ihm-sig` keep their upstream spelling, and every
   * other marker in the browser says `gilbert`. These two are written into the
   * body of a message this product **sent**, which Stalwart then stores and
   * hands back forever; the reply path looks for them to recognise its own
   * signature. Renaming them would make this version fail to recognise the
   * signature on every message already sent from this installation — a name
   * held by a document an installation has already written moves with every
   * reader and writer of it, and there is no reader left to move.
   */
  if (identity.htmlSignature)
    return `<div class="ihm-signature" data-ihm-sig="1"><br>${sanitizeEditorHtml(identity.htmlSignature)}</div>`;
  if (identity.textSignature) {
    const body = textToHtml(identity.textSignature, { quoteColors: false }).replace(
      /\n/g,
      "<br>",
    );
    return `<div class="ihm-signature" data-ihm-sig="1">${htmlSignatureBlock(body)}</div>`;
  }
  return "";
}
/**
 * Whether a draft field still holds exactly what the identity it was opened
 * with put there -- the test for "the reader has not touched this", which is
 * what decides whether switching identity may replace the field.
 *
 * Compared by address with `sameAddress`, because the two sides are a draft
 * that has been through the composer and a list the server answered, and the
 * question is about who is reached rather than about how a name was spelled.
 */
export function stillTheIdentitys(
  current: EmailAddress[],
  ident: Identity | undefined,
  field: "replyTo" | "bcc",
): boolean {
  const opened = ident?.[field] ?? [];
  return (
    current.length === opened.length &&
    current.every((x, i) => sameAddress(x.email, opened[i]?.email ?? ""))
  );
}
export function defaultIdentity(
  identities: Identity[],
  email?: Email | null,
): Identity | undefined {
  if (!identities.length) return undefined;
  if (email) {
    const candidates = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
    for (const c of candidates) {
      const m = identities.find((i) => sameAddress(i.email, c.email));
      if (m) return m;
    }
  }
  return useMail.getState().defaultIdentity() ?? identities[0];
}
/**
 * The identity's Bcc, written into a draft as recipients of its own.
 *
 * RFC 8621 leaves `Identity.bcc` for the client to apply, and this is where it
 * is applied: **once**, when the draft is created, rather than on the way out.
 * What the composer shows is then the whole truth about who the message
 * reaches, and the field is the reader's -- somebody who takes the address off
 * for one message has taken it off, which an addition at send time would
 * silently undo.
 *
 * So it is deliberately not mirrored at send time the way `replyTo` is (see
 * `buildEmailObject`), and a draft written before the address was set does not
 * gain it: a copy nobody can see leaving the composer is the one thing this
 * field must never be.
 *
 * `uniqueAddresses` drops what the draft was already addressed with -- a
 * `mailto:` naming the archive, a resend of a message that was copied there --
 * so nothing arrives twice, and it drops an address with nothing in it.
 */
export function identityBcc(
  ident: Identity | undefined,
  addressed: EmailAddress[] = [],
): EmailAddress[] {
  return uniqueAddresses([...addressed, ...(ident?.bcc ?? [])]);
}
/**
 * The body, the attachments and the headers a draft made from a stored message
 * carries.
 *
 * `openDraftEmail` and `composeAsNew` build a draft out of the same message and
 * need the same seven things from it: the two body parts, the cid map an inline
 * image resolves through, the attachment list, the rendered body, the format it
 * decided, and the receipt and priority headers the message asked for. The
 * identity and the recipients stay with the caller, because the two paths
 * differ there on purpose. Spelled once here so a change to the extraction
 * cannot silently change only one of them.
 */
export function bodyFromEmail(
  full: Email,
  accountId: Id,
): {
  html: string;
  text: string;
  format: "html" | "text";
  attachments: ComposeAttachment[];
  requestReceipt: boolean;
  priority: Priority;
} {
  const htmlPart = full.htmlBody?.[0];
  const textPart = full.textBody?.[0];
  const html = htmlPart?.partId ? (full.bodyValues?.[htmlPart.partId]?.value ?? "") : "";
  const text = textPart?.partId ? (full.bodyValues?.[textPart.partId]?.value ?? "") : "";
  const cidMap: Record<string, string> = {};
  const attachments: ComposeAttachment[] = [];
  for (const a of full.attachments ?? []) {
    const inline =
      Boolean(a.cid) && (a.disposition === "inline" || a.type.startsWith("image/"));
    if (inline && a.cid && a.blobId)
      cidMap[a.cid] = client.downloadUrl(
        accountId,
        a.blobId,
        a.name ?? "image",
        a.type,
        true,
      );
    attachments.push({
      id: uid("a"),
      name: a.name ?? "attachment",
      type: a.type,
      size: a.size,
      blobId: a.blobId,
      progress: 100,
      error: null,
      cid: a.cid ?? undefined,
      inline,
    });
  }
  return {
    html: html
      ? sanitizeEmailHtml(html, {
          cidMap,
          allowRemote: quoteAllowsRemote(full.from?.[0]),
        }).html
      : textToHtml(text).replace(/\n/g, "<br>"),
    text: text || (html ? htmlToText(html) : ""),
    format: html ? "html" : settings().composeFormat,
    attachments,
    requestReceipt: Boolean(
      full["header:Disposition-Notification-To:asAddresses"]?.length,
    ),
    priority: /^[12]/.test(full["header:X-Priority:asText"] ?? "")
      ? "high"
      : /^[45]/.test(full["header:X-Priority:asText"] ?? "")
        ? "low"
        : "normal",
  };
}
export function quoteTextOf(text: string, html: string): string {
  const base = text || (html ? htmlToText(html) : "");
  return quoteText(base);
}

/*
 * Whether the message being turned into a draft may keep its remote images.
 *
 * The reader answers this per message from the settings and the sender
 * (lib/remoteImages); hardcoding "yes" here would fetch the pixels of a
 * tracking-pixel mail the moment the draft rendered, no consent asked and no
 * proxy in between. Ask the same question, at quote time. The address book is consulted as of now: it may not have loaded yet,
 * and erring toward blocking is the safe direction.
 */
export function quoteAllowsRemote(from: EmailAddress | null | undefined): boolean {
  const s = settings();
  const contacts = useContacts.getState();
  return remoteImagesAllowed({
    policy: s.imagePolicy,
    trustedSenders: s.trustedImageSenders,
    senderEmail: from?.email,
    inContacts: Boolean(from && contacts.loaded && contacts.lookupByEmail(from.email)),
  });
}
export function isContentPatch(p: Partial<Draft>): boolean {
  return [
    "to",
    "cc",
    "bcc",
    "replyTo",
    "subject",
    "html",
    "text",
    "attachments",
    "identityId",
    "format",
    "priority",
    "requestReceipt",
  ].some((k) => k in p);
}
/*
 * Whether two drafts hold the same content, for deciding whether a save that
 * just finished is still the newest word. Compared field by field, strictly:
 * anything the user can change that a save persists counts, and anything that
 * merely describes the save in progress (dirty, saving, draftId, upload
 * progress) does not.
 */
function sameAddressList(a: EmailAddress[], b: EmailAddress[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        y !== undefined && x.email === y.email && (x.name ?? null) === (y.name ?? null)
      );
    })
  );
}

function sameAttachments(a: ComposeAttachment[], b: ComposeAttachment[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        y !== undefined &&
        x.id === y.id &&
        x.name === y.name &&
        x.type === y.type &&
        x.size === y.size &&
        x.blobId === y.blobId &&
        x.cid === y.cid &&
        x.inline === y.inline &&
        x.error === y.error
      );
    })
  );
}

export function sameDraftContent(a: Draft, b: Draft): boolean {
  return (
    a.subject === b.subject &&
    a.html === b.html &&
    a.text === b.text &&
    a.format === b.format &&
    a.identityId === b.identityId &&
    a.priority === b.priority &&
    a.requestReceipt === b.requestReceipt &&
    a.sendAt === b.sendAt &&
    a.inReplyTo?.join("\u0000") === b.inReplyTo?.join("\u0000") &&
    a.references?.join("\u0000") === b.references?.join("\u0000") &&
    a.relatedEmailId === b.relatedEmailId &&
    a.relatedKeyword === b.relatedKeyword &&
    sameAddressList(a.to, b.to) &&
    sameAddressList(a.cc, b.cc) &&
    sameAddressList(a.bcc, b.bcc) &&
    sameAddressList(a.replyTo, b.replyTo) &&
    sameAttachments(a.attachments, b.attachments)
  );
}
export function hasContent(d: Draft): boolean {
  const body =
    d.format === "html"
      ? htmlToText(d.html.replace(/<div class="ihm-quote">[\s\S]*$/, ""))
      : d.text;
  return body.replace(/--\s*[\s\S]*$/, "").trim().length > 0 || d.attachments.length > 0;
}
/** Composer fields for a `mailto:` URL, including cc/bcc and a quoted body. */
export function draftFromMailto(url: string): Partial<Draft> {
  const m = parseMailto(url);
  const body = m.body ? `<div>${escapeHtml(m.body).replace(/\n/g, "<br>")}</div>` : "";
  return {
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    showCc: m.cc.length > 0,
    showBcc: m.bcc.length > 0,
    subject: m.subject,
    ...(body ? { html: body, text: m.body } : {}),
  };
}
