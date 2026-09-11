/**
 * A secret the agent's account has just minted, shown once.
 *
 * Two doors mint one: rotating the app password, and naming an address whose
 * deployment holds none. Both owe the reader the same three things — the
 * secret, the promise that this is the only time it is shown, and the count of
 * the credentials it did not revoke — so both read them from here. The promise
 * is the part that must not drift: an admin who reads "rotate" as "revoke"
 * leaves a leaked secret alive while believing they closed it.
 */
import type { AgentAppPasswordRotation } from "@gilbert/agent/views";
import { plural, t } from "@/lib/i18n";
import { CopyableSecret } from "@/views/settings/SecuritySettings";

export function MintedSecret({ rotation }: { rotation: AgentAppPasswordRotation }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <p>
        {t(
          "This is the deployment's secret, and it will not be shown again. Copy it now and put it where the worker reads it; until both sides agree, the worker cannot open its session.",
        )}
      </p>
      <CopyableSecret value={rotation.secret} />
      {rotation.alsoValid === null ? (
        <p className="hint">
          {t(
            "The number of other app passwords still valid could not be read, so it is unknown here: check Stalwart's administration to see which credentials the agent still holds.",
          )}
        </p>
      ) : rotation.alsoValid > 0 ? (
        <p className="hint">
          {plural(rotation.alsoValid, {
            one: "{n} other app password still works — revoke it in Stalwart's administration.",
            other:
              "{n} other app passwords still work — revoke them in Stalwart's administration.",
          })}
        </p>
      ) : null}
    </div>
  );
}
