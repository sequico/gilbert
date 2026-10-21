import type { EmailAddress } from "@/jmap/types";
import { sameAddress, uniqueAddresses } from "@/lib/address";
import { sanitizeEditorHtml } from "@/lib/html";
import { fillPlaceholders, type PlaceholderContext } from "@/lib/templatePlaceholders";
import { htmlToText } from "@/lib/text";
import { useMail } from "../../mail";
import { identityBcc, signatureBlock, stillTheIdentitys } from "../draft";
import type { ComposeGet, ComposeSet, ComposeState, Draft } from "../types";

/**
 * The two things that change a draft's own words without the reader typing
 * them: the identity it is sent as, and a template dropped into it.
 *
 * A slice of the compose store: the state is assembled in `../index`, and this
 * function does its work through `get` -- a draft is changed through `update`,
 * so no `set` is needed here.
 */
export function identitySlice(
  _set: ComposeSet,
  get: ComposeGet,
): Pick<ComposeState, "setIdentity" | "insertTemplate"> {
  return {
    setIdentity(key, identityId) {
      const d = get().drafts.find((x) => x.key === key);
      if (!d) return;
      const ident = useMail.getState().identities.find((i) => i.id === identityId);
      const newSig = signatureBlock(ident, "html");
      let html = d.html;
      if (d.signatureHtml && html.includes(d.signatureHtml))
        html = html.replace(d.signatureHtml, newSig);
      else if (!d.signatureHtml && newSig) {
        // insert before quote if any, else append
        const idx = html.indexOf('<div class="ihm-quote">');
        html = idx >= 0 ? html.slice(0, idx) + newSig + html.slice(idx) : html + newSig;
      }
      // Plain text: replace trailing signature block
      const oldSigText = signatureBlock(
        useMail.getState().identities.find((i) => i.id === d.identityId),
        "text",
      );
      let text = d.text;
      if (oldSigText && text.includes(oldSigText))
        text = text.replace(oldSigText, signatureBlock(ident, "text"));
      const oldIdent = useMail.getState().identities.find((i) => i.id === d.identityId);
      /*
       * The two addresses an identity carries and a draft shows are swapped with
       * it, and only while the draft still holds what the previous identity put
       * there: an address the reader added, or one they took off, is theirs and
       * stays. Same rule for both, so the pair cannot drift apart.
       */
      const carried = {
        ...(stillTheIdentitys(d.replyTo, oldIdent, "replyTo")
          ? {
              replyTo: ident?.replyTo ?? [],
              showReplyTo: d.showReplyTo || Boolean(ident?.replyTo?.length),
            }
          : {}),
        ...(stillTheIdentitys(d.bcc, oldIdent, "bcc")
          ? {
              bcc: identityBcc(ident),
              showBcc: d.showBcc || Boolean(ident?.bcc?.length),
            }
          : {}),
      };
      get().update(key, { identityId, html, text, signatureHtml: newSig, ...carried });
    },
    insertTemplate(key, { html, subject, to = [], cc = [], bcc = [] }) {
      const d = get().drafts.find((x) => x.key === key);
      if (!d) return;
      // The template's recipients join the ones already there. An address that
      // is already on the message, in any field, stays where it is rather than
      // appearing twice.
      const present = [...d.to, ...d.cc, ...d.bcc];
      const added = (list: EmailAddress[]) => {
        const fresh = uniqueAddresses(list).filter(
          (a) => !present.some((p) => sameAddress(p.email, a.email)),
        );
        present.push(...fresh);
        return fresh;
      };
      const recipients = {
        to: [...d.to, ...added(to)],
        cc: [...d.cc, ...added(cc)],
        bcc: [...d.bcc, ...added(bcc)],
      };
      // Placeholders are filled against the draft as it stands right now, which
      // is why this happens on insert rather than on send: what the template is
      // filled with is visible and editable afterwards, instead of changing
      // under the message between writing it and sending it. The template's own
      // recipients join what the placeholders read, after the draft's -- the
      // message's own first To still wins -- which is what lets a message with
      // no To yet address the person the template is for.
      const ident = d.identityId
        ? useMail.getState().identities.find((i) => i.id === d.identityId)
        : undefined;
      const ctx: PlaceholderContext = {
        to: recipients.to,
        from: ident ? { name: ident.name, email: ident.email } : null,
        subject: d.subject,
      };
      // The body is filled once as HTML and the plain-text side derived from the
      // result, so the two cannot disagree about what a placeholder came to.
      const filled = fillPlaceholders(html, ctx, { html: true });
      const patch: Partial<Draft> = {
        html: `<div>${sanitizeEditorHtml(filled)}</div>${d.html}`,
        text: `${htmlToText(filled)}\n${d.text}`,
      };
      if (subject && !d.subject)
        patch.subject = fillPlaceholders(subject, ctx, { html: false });
      if (recipients.to.length !== d.to.length) patch.to = recipients.to;
      if (recipients.cc.length !== d.cc.length)
        Object.assign(patch, { cc: recipients.cc, showCc: true });
      if (recipients.bcc.length !== d.bcc.length)
        Object.assign(patch, { bcc: recipients.bcc, showBcc: true });
      get().update(key, patch);
    },
  };
}
