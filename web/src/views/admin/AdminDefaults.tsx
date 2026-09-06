import { t } from "@/lib/i18n";
import { policyDefaults } from "@/lib/settingsPolicy";

/**
 * Gilbert Defaults: the keys every account starts on, and — once the
 * administration backend lands — per-group overrides edited here.
 *
 * What is real today is the installation's defaults, read from the same
 * policy the client applies at sign-in (`policyDefaults`); the table below
 * shows them read-only. Group enumeration and the editable per-group rows
 * need the server half (requireAdmin + the policy documents in the admin
 * group's own JMAP Files, ADR 0001/0004) and arrive with it rather than
 * being painted with data that does not exist yet.
 */
export function AdminDefaults() {
  const defaults = policyDefaults();
  const entries = Object.entries(defaults);
  return (
    <div>
      <h1>{t("Gilbert Defaults")}</h1>
      <p className="lead">
        {t(
          "The keys every account starts on, unless an administrator overrides them for a group.",
        )}
      </p>
      <h2>{t("Defaults for all accounts")}</h2>
      {entries.length === 0 ? (
        <p className="hint">
          {t("No defaults are set — new accounts start on Gilbert's own defaults.")}
        </p>
      ) : (
        <table className="sessions-table">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <td>
                  <code>{key}</code>
                </td>
                <td>
                  <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>{t("Per-group overrides")}</h2>
      <p className="hint">
        {t(
          "Groups and their editable override rows arrive with the administration backend: the server endpoints and the policy documents kept in the admin group's Files (ADR 0001).",
        )}
      </p>
    </div>
  );
}
