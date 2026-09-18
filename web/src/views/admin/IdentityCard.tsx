import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList } from "@/lib/address";
import { t } from "@/lib/i18n";
import { htmlToText } from "@/lib/text";

/**
 * One identity, as the two identity tabs draw it.
 *
 * `views/admin/UserIdentities.tsx` and `views/admin/GroupIdentities.tsx` list
 * identities of different accounts for different reasons, and the card is the
 * same: who it sends as, its Reply-To, the first line of its signature, and an
 * Edit that opens the form. What differs is what each head offers *beside* Edit
 * — the personal tab makes one the default and deletes one; a group's tab
 * offers neither, because a group's identities come from its roster — so those
 * arrive as slots rather than as behaviour here.
 */
export function identityLabel(identity: Identity): string {
  const name = (identity.name || "").trim();
  return name ? `${name} <${identity.email}>` : identity.email;
}

export function IdentityCard({
  identity,
  onEdit,
  head,
  trailing,
}: {
  identity: Identity;
  /** Open this identity's form. */
  onEdit: () => void;
  /** This surface's buttons, between the name and Edit. */
  head?: ReactNode;
  /** And the ones it wants last, where a destructive button belongs. */
  trailing?: ReactNode;
}) {
  return (
    <div className="card clickable" onClick={onEdit}>
      <div className="card-head">
        <h3>{identityLabel(identity)}</h3>
        {head}
        <button
          className="btn btn-sm btn-ghost"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Pencil size={14} /> {t("Edit")}
        </button>
        {trailing}
      </div>
      {identity.replyTo?.length ? (
        <div className="hint">
          {t("Reply-To: {addresses}", { addresses: formatAddressList(identity.replyTo) })}
        </div>
      ) : null}
      {(identity.htmlSignature || identity.textSignature) && (
        <div className="hint" style={{ marginTop: 4 }}>
          {htmlToText(identity.htmlSignature || identity.textSignature).slice(0, 120)}
        </div>
      )}
    </div>
  );
}
