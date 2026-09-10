/**
 * The agent's app password (ADR 0003 v1 scope).
 *
 * It is the one bootstrap secret a worker holds: the deployment carries it in
 * the environment, the worker authenticates as the agent with it, and nothing
 * else is needed — no impersonation at boot, no operator credential. Rotating
 * it therefore lands on the deployment as well, so the copy says so instead of
 * letting an admin believe the product alone is done with it.
 *
 * The secret comes back once. It is held in this component's own state, shown
 * in a box that can be copied, and never asked for again.
 */
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { confirmDialog } from "@/ui/dialog";
import { CopyableSecret } from "@/views/settings/SecuritySettings";

export function AppPasswordRotate() {
  const rotateAppPassword = useAgents((s) => s.rotateAppPassword);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rotate = async () => {
    const ok = await confirmDialog({
      title: t("Rotate the agent's app password?"),
      message: t(
        "The worker signs in with this password and nothing else. The current one stops working at once, and the deployment has to carry the new one before the next restart.",
      ),
      confirmLabel: t("Rotate"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      // The store rejects with the server's reason when the rotation is
      // refused, and hands back the new secret only when it is not.
      setSecret(await rotateAppPassword());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>{t("App password")}</h2>
      <p className="lead">
        {t(
          "The deployment holds this secret as the agent's own, not a person's, so an operator leaving cannot strand the agent. Rotating it here is half the job: the environment has to agree with the new secret at the next restart.",
        )}
      </p>
      <button className="btn" disabled={busy} onClick={() => void rotate()}>
        <KeyRound size={16} /> {busy ? t("Rotating…") : t("Rotate app password")}
      </button>
      {error && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      {secret && (
        <div className="card" style={{ marginTop: 12 }}>
          <p>
            {t(
              "This is the deployment's secret, and it will not be shown again. Copy it now and put it where the worker reads it; until both sides agree, the worker cannot open its session.",
            )}
          </p>
          <CopyableSecret value={secret} />
        </div>
      )}
    </section>
  );
}
