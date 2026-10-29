/**
 * What Outbound is looking at (ADR 0040).
 *
 * The section's tree and its panes share one reading of the group: the selection,
 * the campaigns the tree lists and the findings the queue reports all come from
 * here, because two reads of the same list are two answers that can disagree. The
 * load is the store's own act, so a pane that changes a campaign asks the store to
 * read again rather than keeping a copy of it.
 */

import type { CampaignDoc } from "@gilbert/shared/outbound";
import { create } from "zustand";
import { type CampaignFinding, listCampaigns } from "@/lib/outbound";

interface OutboundState {
  /** The group the reader chose, or "" for the first one they are in. */
  group: string;
  /** The campaign the queue is narrowed to, or "" for every running one. */
  campaign: string;
  /** The group's campaigns as last read, closed ones included. */
  campaigns: CampaignDoc[];
  /** The campaigns past their window with work still open. */
  findings: CampaignFinding[];
  selectGroup: (group: string) => void;
  filterCampaign: (campaign: string) => void;
  /** Read the group's campaigns again. A failed read leaves the last one standing. */
  load: (group: string) => Promise<void>;
}

/**
 * The read in flight, so the tree and the pane asking at the same moment cost one
 * request rather than two: both call `load` with the same group on mount.
 */
let reading: { group: string; promise: Promise<void> } | null = null;

export const useOutbound = create<OutboundState>((set) => ({
  group: "",
  campaign: "",
  campaigns: [],
  findings: [],
  // A campaign belongs to one group, so moving group drops the filter with it and
  // the list of the group being left is not left on screen.
  selectGroup: (group) => set({ group, campaign: "", campaigns: [], findings: [] }),
  filterCampaign: (campaign) => set({ campaign }),
  load: async (group) => {
    if (reading?.group === group) return reading.promise;
    const promise = listCampaigns(group).then((answer) => {
      const running = new Set(
        answer.campaigns
          .filter((entry) => entry.state === "running")
          .map((entry) => entry.uid),
      );
      // A campaign that closed leaves the tree, and a filter still naming it would
      // leave the queue asking for a list nobody works any more.
      set((now) => ({
        campaigns: answer.campaigns,
        findings: answer.findings,
        campaign: now.campaign !== "" && !running.has(now.campaign) ? "" : now.campaign,
      }));
    });
    reading = { group, promise };
    try {
      await promise;
    } finally {
      if (reading?.group === group) reading = null;
    }
  },
}));

/**
 * The group on screen: the one chosen, or the first the reader is in.
 *
 * Both the tree and the pane ask this, so a group the reader has been removed from
 * falls back to one they are still in, once, in one place.
 */
export function activeGroupName(
  groups: ReadonlyArray<{ name: string }>,
  chosen: string,
): string {
  return groups.some((group) => group.name === chosen) ? chosen : (groups[0]?.name ?? "");
}
