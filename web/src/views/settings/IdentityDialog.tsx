/**
 * The identity form, and the one definition of it.
 *
 * A person's own settings and the administration's identity surfaces edit the
 * same object — display name, address, Reply-To and a rich signature — so they
 * open the same dialog: an identity means the same thing wherever it is written
 * (ADR 0007 §1). What differs is where a signature's **assets** live. Pictures
 * and an over-sized signature's full HTML belong to the account's own Files,
 * which a person writing their own identity has and an administrator writing
 * somebody else's does not. So the caller says where those go, and a caller with
 * none gets an editor that still writes everything the server will take: name,
 * address, Reply-To and a signature within the limit.
 */

import { useRef, useState } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList, parseAddressList } from "@/lib/address";
import { sanitizeEditorHtml } from "@/lib/html";
import { t } from "@/lib/i18n";
import {
  buildMarkerSignature,
  byteLength,
  compactHtml,
  SIGNATURE_LIMIT,
  signatureTooLong,
} from "@/lib/signatureHtml";
import { externalizeDataImages, needsAssets } from "@/lib/signatureImages";
import { htmlToText } from "@/lib/text";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { RichEditor, type RichEditorHandle } from "../compose/RichEditor";

export interface IdentityAssets {
  /** Upload a pasted/dropped picture for a signature; a same-origin URL back. */
  uploadImage?(file: File): Promise<string>;
  /** Store the full HTML of an over-sized signature; the blob id back. */
  storeHtml?(html: string): Promise<string>;
}

/*
 * Why a surface without `assets` cannot write this signature. The signature's
 * own storage is the account's Files, and this surface is writing an account
 * that is not its own — so the fix is to take the asset out, or to set the
 * signature where the account's Files can be written.
 */
const PICTURE_NEEDS_FILES =
  "A picture in a signature is stored in the account's own Files, which this surface cannot write. Remove the picture, or set the signature in the account's own settings.";
const OVER_SIZED_NEEDS_FILES =
  "This signature is larger than the server's {limit}-byte limit, and keeping the full version needs the account's own Files, which this surface cannot write. Shorten it, or set the signature in the account's own settings.";

/**
 * What an identity's fields open at. One expression, because the dialog both
 * seeds the fields from it and measures "unchanged" against it -- two copies
 * would be two answers to one question, and the day they disagreed the button
 * would quietly use the wrong one.
 */
function draftOf(identity: Partial<Identity>) {
  return {
    name: identity.name ?? "",
    email: identity.email ?? "",
    replyTo: formatAddressList(identity.replyTo),
    html:
      identity.htmlSignature ||
      (identity.textSignature ? identity.textSignature.replace(/\n/g, "<br>") : ""),
  };
}

export function IdentityDialog({
  identity,
  onClose,
  save,
  assets,
}: {
  identity: Partial<Identity>;
  onClose: () => void;
  /** Save the built patch. Throws (its message is shown) or returns. */
  save: (patch: Partial<Identity>) => Promise<void>;
  /** Where signature assets are stored; absent means this surface has none. */
  assets?: IdentityAssets;
}) {
  const opened = draftOf(identity);
  const [name, setName] = useState(opened.name);
  const [email, setEmail] = useState(opened.email);
  const [replyTo, setReplyTo] = useState(opened.replyTo);
  const [html, setHtml] = useState(opened.html);

  /*
   * An identity that exists has something to be measured against, and saving it
   * unchanged writes back what is already there. One being created has nothing
   * to measure -- the surface that opened the dialog fills the address in --
   * so the question there is only whether there is an address to create.
   */
  const edited =
    name !== opened.name ||
    email !== opened.email ||
    replyTo !== opened.replyTo ||
    html !== opened.html;
  const saveable = identity.id ? edited : email.trim() !== "";
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<RichEditorHandle>(null);
  const compact = compactHtml(sanitizeEditorHtml(html));
  // The server's limit is on encoded bytes, so that is what to count and show.
  const sigLen = byteLength(compact);
  const tooLong = signatureTooLong(compact, htmlToText(compact));
  /*
   * What this caller can store, and what it therefore offers. The two assets are
   * separate doors: a surface that writes somebody else's identity can keep an
   * over-sized signature in **their** Files (the impersonated account, or the
   * group the agent is granted on) without being able to upload a picture,
   * because the picture would have to be rendered back through the writer's own
   * session, which does not hold that account.
   */
  const canStorePictures = typeof assets?.uploadImage === "function";
  const canStoreHtml = typeof assets?.storeHtml === "function";
  // A picture the signature carries itself needs Files; where there are none it
  // cannot be saved at all, so what the editor holds is said where it is held.
  const embeddedPicture = !canStorePictures && needsAssets(compact);

  /**
   * A surface without `assets` cannot store a picture. The picture stays out of
   * the signature and the reason is shown, rather than a `data:` URL landing in
   * an identity that the server would then refuse for its size.
   */
  const refusePicture = async (): Promise<string> => {
    setProblem(t(PICTURE_NEEDS_FILES));
    throw new Error(t(PICTURE_NEEDS_FILES));
  };

  const submit = async () => {
    if (embeddedPicture) {
      setProblem(t(PICTURE_NEEDS_FILES));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      // 1) pasted pictures → stored files, 2) strip cruft, 3) fall back to a stored full copy.
      const clean = sanitizeEditorHtml(html);
      const externalized = canStorePictures
        ? await externalizeDataImages(clean, assets?.uploadImage)
        : clean;
      const output = compactHtml(externalized);
      let htmlSignature = output;
      let textSignature = htmlToText(output);
      if (signatureTooLong(output, textSignature)) {
        const storeHtml = assets?.storeHtml;
        if (!storeHtml) {
          setProblem(t(OVER_SIZED_NEEDS_FILES, { limit: SIGNATURE_LIMIT }));
          return;
        }
        ({ htmlSignature, textSignature } = buildMarkerSignature(
          await storeHtml(output),
          output,
        ));
      }
      const patch: Partial<Identity> = {
        name,
        replyTo: replyTo.trim() ? parseAddressList(replyTo) : null,
        htmlSignature,
        textSignature,
      };
      if (!identity.id) patch.email = email.trim();
      await save(patch);
      toast.success(t("Identity saved"));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={identity.id ? t("Edit identity") : t("New identity")}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !saveable}
            onClick={() => void submit()}
          >
            {busy ? t("Saving…") : t("Save")}
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label>{t("Display name")}</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>{t("Email address")}</label>
          <input
            className="input"
            type="email"
            value={email}
            disabled={Boolean(identity.id)}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>{t("Reply-To (optional)")}</label>
        <input
          className="input"
          value={replyTo}
          onChange={(e) => setReplyTo(e.target.value)}
          placeholder={t("replies@example.com")}
        />
        <span className="hint">
          {t(
            "Replies to mail sent from this identity go here instead of the From address.",
          )}
        </span>
      </div>
      <div className="field">
        <label>{t("Signature")}</label>
        <div
          style={{
            border: `1px solid ${tooLong ? "var(--danger)" : "var(--border-strong)"}`,
            borderRadius: 8,
            minHeight: 180,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <RichEditor
            ref={ref}
            html={html}
            onChange={(next) => {
              setHtml(next);
              setProblem(null);
            }}
            placeholder={t("Your signature…")}
            showToolbar
            imageUpload={canStorePictures ? assets?.uploadImage : refusePicture}
          />
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="hint">
            {canStorePictures
              ? t(
                  "Images are stored in your Files (folder “gilbert”) and embedded when you send.",
                )
              : canStoreHtml
                ? t(
                    "Pictures belong to the account’s own Files and this surface cannot write them; an over-sized signature is kept there, and this form stores the marker that points at it.",
                  )
                : t(
                    "Pictures and over-sized signatures live in the account's own Files, which this surface cannot write.",
                  )}
          </span>
          <span
            className="hint nowrap"
            style={tooLong ? { color: "var(--warn)", fontWeight: 600 } : undefined}
          >
            {sigLen.toLocaleString()} / {SIGNATURE_LIMIT.toLocaleString()}
          </span>
        </div>
        {canStorePictures && tooLong && (
          <div className="warn-box mt-8">
            {t(
              "This signature is larger than the server's {limit}-byte limit. Gilbert will keep the full version in your Files and store a short text fallback on the server — other mail clients will see the plain-text version.",
              { limit: SIGNATURE_LIMIT },
            )}
          </div>
        )}
        {!canStorePictures &&
          (problem || embeddedPicture || (tooLong && !canStoreHtml)) && (
            <div className="warn-box mt-8">
              {problem ??
                (embeddedPicture
                  ? t(PICTURE_NEEDS_FILES)
                  : t(OVER_SIZED_NEEDS_FILES, { limit: SIGNATURE_LIMIT }))}
            </div>
          )}
      </div>
    </Dialog>
  );
}
