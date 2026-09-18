import { RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import {
  type AdminDirectoryGroup,
  type AdminDirectoryUser,
  type AdminGroupDirectory,
  type AdminUserDirectory,
  fetchAdminGroups,
  fetchAdminUserDirectory,
} from "@/lib/identities";
import { MenuSelect } from "@/ui/popover";

/**
 * The directory an administration picker offers, and the pieces that offer it.
 *
 * Three surfaces ask the server for a directory before they can be used:
 * `UserIdentities.tsx` and `GroupIdentities.tsx` (which accounts, or which
 * groups, an identity belongs to) and `GroupLabels.tsx` (whose catalogue is
 * being edited). Each carried the same read, the same four pieces of state
 * around it, the same Retry box when the read failed, the same "the server
 * would not list" warning, and the same picker — a `MenuSelect` of the names
 * where the directory could be read at all, and a free-text field where it
 * could not, which is the one way in when enumeration is refused.
 *
 * The sentences stay with the surface: what it says when the listing is
 * refused is about accounts or about group mailboxes, and neither is the
 * other's to write.
 */

/** What every directory read adds to the server's own answer. */
export interface DirectoryRead {
  /** True until the first read settles, one way or the other. */
  loading: boolean;
  /** Non-null when the read itself failed, which is not the same as a refusal. */
  loadError: string | null;
  /** Read it again: the Retry box, and the refresh after a write. */
  reload: () => void;
}

/**
 * One read of the account directory, and its reload.
 *
 * Read on mount and kept until asked again: the directory is a fact about the
 * server's accounts, and nothing in these surfaces changes it — they change
 * identities and labels inside accounts it lists.
 */
export function useUserDirectory(): AdminUserDirectory & DirectoryRead {
  const [listing, setListing] = useState<AdminUserDirectory>({
    users: [],
    enumeration: true,
    enumerationMessage: null,
    impersonation: "unknown",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    void fetchAdminUserDirectory()
      .then(setListing)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);
  return { ...listing, loading, loadError, reload };
}

/** The same, for the group mailboxes a picker may offer. */
export function useGroupDirectory(): AdminGroupDirectory & DirectoryRead {
  const [listing, setListing] = useState<AdminGroupDirectory>({
    groups: [],
    enumeration: true,
    enumerationMessage: null,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    void fetchAdminGroups()
      .then(setListing)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(reload, [reload]);
  return { ...listing, loading, loadError, reload };
}

/** A directory read that failed, with the retry that makes it worth reading again. */
export function DirectoryLoadError({
  loadError,
  reload,
}: {
  loadError: string;
  reload: () => void;
}) {
  return (
    <div className="error-box">
      {loadError}
      <p>
        <button className="btn" onClick={reload}>
          {t("Retry")}
        </button>
      </p>
    </div>
  );
}

/**
 * The server would not list the directory at all.
 *
 * A refusal, not a failure: the session lacks the Stalwart privilege that
 * enumerating needs, and the surface carries on by typing a name — which is why
 * this is a warning rather than an error, and why the message the server gave is
 * shown in its own words beside it.
 */
export function DirectoryNotListed({
  message,
  children,
}: {
  message: string | null;
  /** What this surface tells the reader to do instead. */
  children: ReactNode;
}) {
  return (
    <div className="warn-box" style={{ marginBottom: 12 }}>
      {children}
      {message && (
        <p className="hint" style={{ marginTop: 6 }}>
          <code>{message}</code>
        </p>
      )}
    </div>
  );
}

/**
 * The picker itself: a list of names where the directory could be read, and a
 * text field where it could not.
 *
 * Both are needed rather than one: a refused enumeration is exactly the case
 * where the reader has to type the account by hand, and a directory that was
 * listed is the case where a name is easier to pick than to spell.
 */
export function DirectoryPicker({
  id,
  label,
  value,
  entries,
  enumerable,
  placeholder,
  typedPlaceholder,
  typedLabel,
  disabled,
  onChoose,
}: {
  id: string;
  label: string;
  value: string;
  /** The listed names, ignored when `enumerable` is false. */
  entries: Array<AdminDirectoryUser | AdminDirectoryGroup>;
  enumerable: boolean;
  placeholder: string;
  typedPlaceholder: string;
  typedLabel: string;
  disabled?: boolean;
  onChoose: (name: string) => void;
}) {
  return (
    <div className="field" style={{ maxWidth: "28rem" }}>
      <label htmlFor={id}>{label}</label>
      {enumerable ? (
        <MenuSelect
          id={id}
          value={value}
          placeholder={placeholder}
          ariaLabel={label}
          options={entries.map((e) => ({ id: e.id, value: e.name }))}
          disabled={disabled}
          onPick={onChoose}
        />
      ) : (
        <input
          id={id}
          className="input"
          defaultValue={value}
          placeholder={typedPlaceholder}
          aria-label={typedLabel}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") onChoose(e.currentTarget.value);
          }}
        />
      )}
    </div>
  );
}

/** The button that reads the chosen account's identities again. */
export function ReloadIdentitiesButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button className="btn" disabled={disabled} onClick={onClick}>
      <RotateCw size={16} /> {t("Reload identities")}
    </button>
  );
}
