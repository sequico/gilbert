import { LogOut } from "lucide-react";
import { withBase } from "@/lib/basePath";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import { PasswordForm } from "@/views/settings/SecuritySettings";

/**
 * The forced-password-change wall (ADR 0001).
 *
 * The server answers 403 `password_change_required` on every data route while
 * the account's directive stands, so this screen is the only usable one for
 * the session: no mail, no settings, no way around. Its two exits are a
 * successful change — the server clears the directive, the client refreshes
 * the session and the app continues — or signing out. The wall is a client
 * courtesy; the door is the server.
 */
export function ForcedPasswordChange() {
  const session = useSession((s) => s.session);
  const refresh = useSession((s) => s.refresh);
  const logout = useSession((s) => s.logout);
  const appName = session?.gilbert?.appName || DEFAULT_APP_NAME;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo">
          <img src={withBase("/img/logo.png")} alt="" width={120} height={143} />
          {/* A product name, not a word: not translated, and not guessed at
              from the page it is on. */}
          <h1 className="notranslate" translate="no">
            {appName}
          </h1>
        </div>
        <h2 style={{ marginTop: 0, marginBottom: 8 }}>{t("Change your password")}</h2>
        <p className="sub" style={{ marginBottom: 16 }}>
          {t(
            "Your administrator requires you to choose a new password before you can continue. Signing out is the only other way out of this screen.",
          )}
        </p>
        <PasswordForm
          otpEnabled={false}
          onChanged={() => {
            // The change cleared the directive server-side; a refreshed
            // session carries mustChangePassword: false and the app mounts.
            void refresh();
          }}
        />
        <p className="foot">
          <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
            <LogOut size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {t("Sign out")}
          </button>
        </p>
      </div>
    </div>
  );
}
