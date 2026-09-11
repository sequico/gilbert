/**
 * The agent's app password (ADR 0003 v1 scope).
 *
 * It is the one bootstrap secret a worker holds: the deployment carries it — in
 * the environment, or in an agents file the installation re-reads as it changes
 * — the worker authenticates as the agent with it, and nothing
 * else is needed — no impersonation at boot, no operator credential. Rotating
 * it therefore lands on the deployment as well, so the copy says so instead of
 * letting an admin believe the product alone is done with it.
 *
 * The secret comes back once. It is held in this component's own state, shown
 * in a box that can be copied, and never asked for again.
 *
 * Rotating adds a credential; it revokes nothing. The app passwords the agent
 * already had keep working, because revoking them would cut off what a worker is
 * doing at that moment, so the surface says how many are still valid — that
 * number is the whole difference between rotating and revoking, and an admin who
 * read "rotate" as "revoke" would leave a leaked secret alive while believing
 * they had closed it. A count the server could not read back is stated as
 * unknown rather than shown as a zero, which would read as a revocation.
 */
import type { AgentAppPasswordRotation } from "@gilbert/agent/views";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { useAgents } from "@/store/agents";
import { confirmDialog } from "@/ui/dialog";
import { MintedSecret } from "./MintedSecret";

export function AppPasswordRotate() {
  const rotateAppPassword = useAgents((s) => s.rotateAppPassword);
  // The store's own line for this operation: a rotation the server refused says
  // why there, and the panel shows it.
  const problem = useAgents((s) => s.problems.password);
  const [rotated, setRotated] = useState<AgentAppPasswordRotation | null>(null);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    const ok = await confirmDialog({
      title: t("Rotate the agent's app password?"),
      message: t(
        "The worker signs in with this password and nothing else. The new secret works from now on, the app passwords already in use keep working — revoking them would cut off what an agent is doing — and the deployment has to be given the new secret: the environment at its next restart, an agents file as it changes.",
      ),
      confirmLabel: t("Rotate"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      // The store rejects with the server's reason when the rotation is
      // refused, and hands back the new secret with the count of what it left
      // working. The shown secret is never cleared on a failure: it cannot be
      // recovered, so the one an admin has not copied yet stays on screen.
      setRotated(await rotateAppPassword());
    } catch {
      // What went wrong is on `problems.password`, rendered below: one home for
      // the reason, and it outlives the dialog that raised it.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>{t("App password")}</h2>
      <p className="lead">
        {t(
          "The deployment holds this secret as the agent's own, not a person's, so an operator leaving cannot strand the agent. Rotating it here is half the job: the deployment has to be given the new secret — the environment at its next restart, an agents file as it changes.",
        )}
      </p>
      <button className="btn" disabled={busy} onClick={() => void rotate()}>
        <KeyRound size={16} /> {busy ? t("Rotating…") : t("Rotate app password")}
      </button>
      {problem && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {problem}
        </div>
      )}
      {rotated && <MintedSecret rotation={rotated} />}
    </section>
  );
}
