import { RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { probeBridgeMedia } from "@/lib/phone/sip";
import type { PhoneStatus } from "@/lib/phoneAdmin";

/** What the media check is doing, or last said. */
type MediaCheck = "idle" | "running" | "reachable" | "unreachable";

/**
 * The phone's bridge, monitored (ADR 0023): whether the service answers, the
 * Janus the deployment installed, the media range it opens, and a live check
 * that this browser can reach it — for so an administrator sees what is out of
 * place without reading a log on the host.
 *
 * The whole check is automatic: it runs when the tab is opened, and Re-check
 * runs all of it again. There is no separate button per row to remember.
 */
export function PhoneStatusPanel({
  active,
  status,
  refreshStatus,
}: {
  active: boolean;
  /** The bridge's server-side state, read once by the surface that owns it. */
  status: PhoneStatus | null;
  /** Re-read that state; the panel never reads it on its own. */
  refreshStatus: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [media, setMedia] = useState<MediaCheck>("idle");

  const check = useCallback(async () => {
    setChecking(true);
    setMedia("running");
    await refreshStatus();
    setMedia((await probeBridgeMedia()) ? "reachable" : "unreachable");
    setChecking(false);
  }, [refreshStatus]);

  // Opening the tab checks everything, every time it is opened.
  useEffect(() => {
    if (active) void check();
  }, [active, check]);

  const bridge = !status
    ? t("Unknown — the status could not be read")
    : status.available
      ? t("Running")
      : `${t("Not running")} — ${status.reason ?? t("no reason given")}`;
  const mediaText =
    media === "running"
      ? t("Checking…")
      : media === "reachable"
        ? t("Reachable")
        : media === "unreachable"
          ? t("Not reachable — open the media range inbound")
          : t("Not checked");

  return (
    <div>
      <p className="hint" style={{ marginBottom: 12 }}>
        {t(
          "The phone's bridge is a second process beside the application. This is what it looks like from the server and from this browser; a check that fails names the thing to fix.",
        )}
      </p>

      <div className="card">
        <Row
          label={t("Bridge service")}
          value={bridge}
          tone={status ? (status.available ? "ok" : "bad") : undefined}
        />
        <Row label={t("Janus version")} value={status?.version ?? t("not installed")} />
        <Row label={t("Media range (UDP, inbound)")} value={status?.mediaPorts ?? "—"} />
        <Row
          label={t("Media path from this browser")}
          value={mediaText}
          tone={
            media === "unreachable" ? "bad" : media === "reachable" ? "ok" : undefined
          }
        />
      </div>

      <p style={{ marginTop: 12 }}>
        <button className="btn" disabled={checking} onClick={() => void check()}>
          <RotateCw size={15} /> {checking ? t("Checking…") : t("Re-check")}
        </button>
      </p>

      <p className="hint">
        {t(
          "The bridge runs beside the application and starts with it — the container's entrypoint, or gilbert-janus.service on a host. GILBERT_BRIDGE=0 turns it off. Its API is loopback-only and the leg to the SIP provider is outbound, so the media range above is the only port to open inbound.",
        )}
      </p>
    </div>
  );
}

/** One labelled fact, tinted when it is the thing to look at. */
function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "ok" | "bad";
}) {
  const colour =
    tone === "ok" ? "var(--success)" : tone === "bad" ? "var(--danger)" : undefined;
  return (
    <div className="row" style={{ alignItems: "baseline", gap: 12, padding: "4px 0" }}>
      <span className="hint" style={{ minWidth: 220 }}>
        {label}
      </span>
      <span className="grow" style={colour ? { color: colour } : undefined}>
        {value}
      </span>
    </div>
  );
}
