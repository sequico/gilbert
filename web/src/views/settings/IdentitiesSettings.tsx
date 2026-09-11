import { Eye, EyeOff, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList } from "@/lib/address";
import { t } from "@/lib/i18n";
import { isAlwaysVisible } from "@/lib/identityVisibility";
import { storeSignatureHtml, uploadSignatureImage } from "@/lib/signatureImages";
import { htmlToText } from "@/lib/text";
import { useMail } from "@/store/mail";
import { useSettings } from "@/store/settings";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { IdentityDialog } from "./IdentityDialog";

export function IdentitiesSettings() {
  const identities = useMail((s) => s.identities);
  const load = useMail((s) => s.loadIdentities);
  const accountId = useMail((s) => s.accountId);
  const setDefault = useMail((s) => s.setDefaultIdentity);
  const defaultId =
    useSettings((s) =>
      accountId ? s.settings.defaultIdentityByAccount[accountId] : undefined,
    ) ?? identities[0]?.id;
  const [editing, setEditing] = useState<Partial<Identity> | null>(null);
  const hidden = useSettings((s) => s.settings.hiddenIdentities);
  const updateSettings = useSettings((s) => s.update);
  const toggleHidden = (id: string) =>
    updateSettings({
      hiddenIdentities: hidden.includes(id)
        ? hidden.filter((x) => x !== id)
        : [...hidden, id],
    });
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>{t("Identities & signatures")}</h1>
      <p className="lead">
        {t(
          "Each identity is a sender address with its own name, Reply-To and signature. The default identity is preselected when you compose; set a Reply-To when replies should go somewhere other than the From address.",
        )}
      </p>
      {identities.map((i) => (
        <div key={i.id} className="card clickable" onClick={() => setEditing(i)}>
          <div className="card-head">
            <h3>
              {i.name ? `${i.name} <${i.email}>` : i.email}{" "}
              {i.id === defaultId && (
                <span
                  className="tag"
                  style={{
                    background: "var(--accent)",
                    color: "var(--accent-fg)",
                    marginLeft: 6,
                  }}
                >
                  {t("Default")}
                </span>
              )}
            </h3>
            {i.id !== defaultId && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  setDefault(i.id);
                  toast.success(
                    t("{email} is now your default identity", { email: i.email }),
                  );
                }}
              >
                <Star size={14} /> {t("Make default")}
              </button>
            )}
            {/*
              Hiding is presentation only -- the identity still exists and still
              receives, like an unsubscribed folder. The default cannot be
              hidden, because it is what a new draft starts on.
            */}
            <button
              className="btn btn-sm btn-ghost"
              disabled={isAlwaysVisible(i.id, [defaultId])}
              title={
                isAlwaysVisible(i.id, [defaultId])
                  ? t("The default identity is always offered when composing")
                  : hidden.includes(i.id)
                    ? t("Show this in the compose picker")
                    : t("Hide this from the compose picker")
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleHidden(i.id);
              }}
            >
              {hidden.includes(i.id) ? (
                <>
                  <Eye size={14} /> {t("Show when composing")}
                </>
              ) : (
                <>
                  <EyeOff size={14} /> {t("Hide when composing")}
                </>
              )}
            </button>
            {i.mayDelete && (
              <button
                className="icon-btn sm danger"
                aria-label={t("Delete identity")}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (
                    await confirmDialog({
                      title: t("Delete this identity?"),
                      confirmLabel: t("Delete"),
                      danger: true,
                    })
                  ) {
                    try {
                      await useMail.getState().destroyIdentity(i.id);
                    } catch (err) {
                      toast.error((err as Error).message);
                    }
                  }
                }}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          {hidden.includes(i.id) && (
            <div className="hint" style={{ marginTop: 4 }}>
              {t(
                "Not offered when composing. It still receives mail, and you can still send from it by showing it again.",
              )}
            </div>
          )}
          {(i.htmlSignature || i.textSignature) && (
            <div className="hint" style={{ marginTop: 4 }}>
              {htmlToText(i.htmlSignature || i.textSignature).slice(0, 120)}
            </div>
          )}
          {i.replyTo?.length ? (
            <div className="hint">
              {t("Reply-To: {addresses}", { addresses: formatAddressList(i.replyTo) })}
            </div>
          ) : null}
        </div>
      ))}
      <button
        className="btn"
        onClick={() =>
          setEditing({
            name: "",
            email: identities[0]?.email ?? "",
            textSignature: "",
            htmlSignature: "",
            replyTo: null,
            bcc: null,
          })
        }
      >
        <Plus size={16} /> {t("Add identity")}
      </button>
      <p className="hint mt-8">
        {t(
          "New identities must use an address this account is allowed to send from (aliases configured on the server).",
        )}
      </p>
      {hidden.length > 0 && (
        <p className="hint">
          {`${hidden.length} ${hidden.length === 1 ? "identity is" : "identities are"} hidden from the compose picker. Hiding every one of them would leave nothing to choose from, so in that case they are all offered again.`}
        </p>
      )}
      {editing && (
        <IdentityDialog
          identity={editing}
          onClose={() => setEditing(null)}
          save={(patch) => useMail.getState().saveIdentity(editing.id ?? null, patch)}
          assets={{
            uploadImage: uploadSignatureImage,
            storeHtml: storeSignatureHtml,
          }}
        />
      )}
    </div>
  );
}
