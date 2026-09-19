import { t } from "@/lib/i18n";
import { type SharedContent, shareSummary } from "@/lib/shareTarget";
import { confirmDialog } from "@/ui/dialog";

/**
 * Ask before a share becomes a message.
 *
 * The share endpoint takes a plain form POST, so any page can send one, and
 * nothing here can tell that from a share the reader made themselves — the
 * cache key is the only thing that distinguishes them and it is not a
 * credential. Nothing would be sent without the reader pressing Send, but a
 * composer that appears already full of somebody else's text and files is
 * still worth one question first.
 *
 * `open` is handed the share only on a yes, so discarding drops it: it has
 * already been taken out of the cache by `collectShare`, and this is the
 * decision that gives it somewhere to go.
 */
export async function offerShare(
  share: SharedContent,
  open: (share: SharedContent) => unknown,
): Promise<boolean> {
  const yes = await confirmDialog({
    title: t("Start a new message with what was shared?"),
    message: <ShareSummary share={share} />,
    confirmLabel: t("Start a message"),
    cancelLabel: t("Discard"),
  });
  if (yes) open(share);
  return yes;
}

/**
 * What arrived, so the reader can tell whether it is theirs.
 *
 * `translate="no"` on the borrowed parts: this is the sender's own text and
 * filenames, and a browser that machine-translates a sentence somebody shared
 * would be showing the reader something other than what was shared.
 */
function ShareSummary({ share }: { share: SharedContent }) {
  const { title, preview, files } = shareSummary(share);
  return (
    <div>
      {(title || preview) && (
        <blockquote className="share-summary notranslate" translate="no">
          {title && <strong>{title}</strong>}
          {title && preview && <br />}
          {preview}
        </blockquote>
      )}
      {files.length > 0 && (
        <ul className="share-summary-files notranslate" translate="no">
          {files.slice(0, 5).map((name, i) => (
            <li key={`${name}-${i}`}>{name}</li>
          ))}
          {files.length > 5 && <li>…</li>}
        </ul>
      )}
      <p>
        {t(
          "Something was shared with Gilbert. Nothing is sent until you choose Send. If you did not just share this, discard it.",
        )}
      </p>
    </div>
  );
}
