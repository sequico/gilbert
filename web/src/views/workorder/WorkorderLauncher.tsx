/**
 * The workorder launcher (ADR 0028): the top-bar entry to the workorder
 * surface.
 *
 * Beside chat's launcher in the action cluster, but a different shape once it
 * is pressed: chat opens a popover, the workorder panel is a fixed large panel
 * (see `WorkorderPanel`). The button carries the running count, because a
 * running workorder is what needs a hand; a completed one is history and does
 * not nag from the corner.
 *
 * The store owns `panelOpen` rather than this button, so the surface's open
 * state is one thing the launcher and the panel read, and Escape or the close
 * button can put it away without the launcher's own state disagreeing.
 */
import { Factory } from "lucide-react";
import { t } from "@/lib/i18n";
import { useWorkorders } from "@/store/workorder";
import { WorkorderPanel } from "./WorkorderPanel";

export function WorkorderLauncher() {
  const panelOpen = useWorkorders((s) => s.panelOpen);
  const workorders = useWorkorders((s) => s.workorders);
  const openPanel = useWorkorders((s) => s.openPanel);
  const closePanel = useWorkorders((s) => s.closePanel);
  const show = useWorkorders((s) => s.show);

  const running = workorders.filter((w) => w.state === "running").length;

  const toggle = () => {
    if (panelOpen) {
      closePanel();
      return;
    }
    /*
     * Open on the list, never on what was open last: the launcher is a fresh
     * look at what is running, and the store's remembered uid is whatever the
     * last visit left behind.
     */
    show(null);
    openPanel();
  };

  return (
    <>
      <button
        type="button"
        /*
         * `.chat-launcher`/`.chat-badge` are the launcher pattern's own
         * positioning classes -- the corner badge hangs off a relative button.
         * Reused rather than spelled out inline, so the workorder launcher and
         * chat's cannot drift apart at the corner.
         */
        className="icon-btn chat-launcher"
        aria-label={t("Workorders")}
        title={t("Workorders")}
        aria-expanded={panelOpen}
        onClick={toggle}
      >
        <Factory size={21} />
        {running > 0 && <span className="chat-badge">{running}</span>}
      </button>
      {panelOpen && <WorkorderPanel />}
    </>
  );
}
