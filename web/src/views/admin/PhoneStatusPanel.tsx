import { Activity, RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { probeBridgeMedia } from "@/lib/phone/sip";
import { fetchPhoneStatus, type PhoneStatus } from "@/lib/phoneAdmin";
import { usePhone } from "@/store/phone";

/** What the media check is doing, or last said. */
type MediaCheck = "idle" | "running" | "reachable" | "unreachable";

/**
 * The phone's bridge, monitored (ADR 0023): whether the service answers, the
 * Janus the deployment installed, the media range it opens, and a live check
 * that this browser can reach that range. It exists so an administrator sees
 * what is out of place without reading a log on the host.
 */
export function PhoneStatusPanel() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [media, setMedia] = useState<MediaCheck>("idle");
  // The line as this tab sees it — the answer to "why is there no phone".
  const line = usePhone((s) => s.state);
  const offered = usePhone((s) => s.ready);
  const lineError = usePhone((s) => s.error);

  async function load() {
    setLoading(true);
    try {
      setStatus(await fetchPhoneStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function testMedia() {
    setMedia("running");
    setMedia((await probeBridgeMedia()) ? "reachable" : "unreachable");
  }

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
        <Row
          label={t("Phone line")}
          value={
            offered
              ? line
              : t("Not offered — no SIP account for this identity, or the media path above")
          }
          tone={line === "unavailable" ? "bad" : undefined}
        />
      </div>

      {lineError && (
        <div className="error-box" style={{ marginTop: 12 }}>
          {lineError}
        </div>
      )}

      <p style={{ marginTop: 12 }}>
        <button className="btn" disabled={loading} onClick={() => void load()}>
          <RotateCw size={15} /> {t("Re-check")}
        </button>{" "}
        <button
          className="btn btn-ghost"
          disabled={media === "running"}
          onClick={() => void testMedia()}
        >
          <Activity size={15} /> {t("Test media path")}
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
