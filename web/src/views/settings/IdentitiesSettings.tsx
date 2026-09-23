import { Eye, EyeOff, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Identity } from "@/jmap/types";
import { formatAddressList } from "@/lib/address";
import { t } from "@/lib/i18n";
import { isAlwaysVisible } from "@/lib/identityVisibility";
import {
  groupMailboxAccounts,
  type MailAccountInfo,
  ownIdentityAccountId,
} from "@/lib/mailAccounts";
import { storeSignatureHtml, uploadSignatureImage } from "@/lib/signatureImages";
import { htmlToText } from "@/lib/text";
import { useMail } from "@/store/mail";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { IdentityDialog } from "./IdentityDialog";

/**
 * What the reader's own list is while it is still on its way, as one object.
 *
 * A selector that builds `[]` on every call hands the store a new reference on
 * every read, which is a re-render per store write for a list that has not
 * changed. The cache entry is missing only until its first read lands.
 */
const EMPTY: Identity[] = [];

/**
 * The person's own identities, and the group mailboxes they are a member of.
 *
 * ADR 0007: a person's own list is the account that sends for them, not the
 * mailbox the client happens to have on screen -- an identity is a claim about
 * who is sending, and it does not move because the reader opened a group's
 * mail or a share. The administration edits that same account, so the two
 * surfaces read one list of the same objects -- and the list is the server's,
 * so it is read when this section opens rather than taken from the session's
 * copy of it.
 *
 * Under it, one read-only block per group mailbox: a group's account holds one
 * identity per member, all carrying the group's address and each carrying that
 * member's own name and signature, and the administration sets them. A member
 * reads them here and does not write them. A locked account is offered none of
 * this: the section is gone from the settings navigation entirely.
 */
export function IdentitiesSettings() {
  const session = useSession((s) => s.session);
  const ownAccountId = ownIdentityAccountId(session);
  const mailAccounts = useMail((s) => s.mailAccounts);
  const identities =
    useMail((s) => (ownAccountId ? s.identitiesByAccount[ownAccountId] : undefined)) ??
    EMPTY;
  const loadFor = useMail((s) => s.loadIdentitiesFor);
  const setDefault = useMail((s) => s.setDefaultIdentity);
  const defaultId =
    useSettings((s) =>
      ownAccountId ? s.settings.defaultIdentityByAccount[ownAccountId] : undefined,
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
  /*
   * Read it whenever the section opens, the way each group block below does,
   * and whenever the account behind it changes. What the session holds is a
   * head start rather than the answer: an identity the administration removed
   * (ADR 0007) leaves neither the account nor the entry anywhere, so a list
   * read at sign-in would go on showing it for the rest of the session.
   */
  useEffect(() => {
    if (ownAccountId) void loadFor(ownAccountId).catch(() => undefined);
  }, [ownAccountId, loadFor]);

  return (
    <div>
      <h1>{t("Identities & signatures")}</h1>
      <p className="lead">
        {t(
          "Each identity is a sender address with its own name, Reply-To, Bcc and signature. The default identity is preselected when you compose; set a Reply-To when replies should go somewhere other than the From address, and a Bcc when every message sent from this address should be copied somewhere.",
        )}
      </p>
      <h2>{t("Your identities")}</h2>
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
          {i.bcc?.length ? (
            <div className="hint">
              {t("Bcc: {addresses}", { addresses: formatAddressList(i.bcc) })}
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
      {groupMailboxAccounts(mailAccounts).map((account) => (
        <GroupIdentities key={account.accountId} account={account} />
      ))}
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

/**
 * One group mailbox the reader is a member of, read-only.
 *
 * A group's identities belong to its members, one each, and the administration
 * writes them and **assigns** each to a member (ADR 0007) -- so there is nothing
 * here to edit, delete or make default, and no hiding either: the compose picker
 * in that mailbox offers the identity assigned to the reader, which is not a
 * choice this page makes. What the member gets is the list, and which of them is
 * theirs is said in as many words, so a member can see that they send as
 * themselves rather than as the group.
 */
function GroupIdentities({ account }: { account: MailAccountInfo }) {
  const identities = useMail((s) => s.identitiesByAccount[account.accountId]) ?? EMPTY;
  const assignment = useMail((s) => s.assignmentByAccount[account.accountId]);
  const loadFor = useMail((s) => s.loadIdentitiesFor);
  const loadAssignment = useMail((s) => s.loadAssignmentFor);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    /*
     * The store caches both per account, so a second mount costs nothing; a
     * failure is said quietly in place, because the group's block is not this
     * page's reason for being and a toast would push the reader out of their own
     * list.
     */
    loadFor(account.accountId).catch((err) => {
      if (live) setError((err as Error).message);
    });
    // Read again as the section opens, not only when the store has nothing:
    // the administration assigns from another session, and this page is where a
    // member finds out which identity is theirs.
    loadAssignment(account.accountId, { force: true }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [account.accountId, loadFor, loadAssignment]);
  return (
    <section>
      <h2>{account.name}</h2>
      <p className="hint">
        {t(
          "This group's mailbox holds one identity per member, all with the group's address. The administration assigns them, so they are read-only here.",
        )}
      </p>
      {/*
       * Which of them is the reader's is the one thing this page can answer
       * (ADR 0007), and it is worth saying: it is the identity their mail leaves
       * the group as, and with none assigned they send as the group itself.
       */}
      {assignment &&
        (assignment.assignedId ? (
          <p className="hint">
            {t("You send as the one assigned to you, marked below.")}
          </p>
        ) : (
          <p className="hint">
            {t(
              "No identity of this group is assigned to you yet, so mail you send from this mailbox goes out as the group itself.",
            )}
          </p>
        ))}
      {error && (
        <p className="hint">
          {t("Could not read this group's identities: {error}", { error })}
        </p>
      )}
      {identities.map((i) => {
        const mine = assignment?.assignedId === i.id;
        return (
          <div key={i.id} className="card">
            <div className="card-head">
              <h3>{i.name ? `${i.name} <${i.email}>` : i.email}</h3>
              {mine && (
                <span className="tag" style={{ background: "var(--accent)" }}>
                  {t("Yours")}
                </span>
              )}
            </div>
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
            {i.bcc?.length ? (
              <div className="hint">
                {t("Bcc: {addresses}", { addresses: formatAddressList(i.bcc) })}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
