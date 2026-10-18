import { create } from "zustand";
import { toast } from "@/ui/toast";
import { useSession } from "../session";
import { autosaveTimers } from "./saves";
import { attachmentsSlice } from "./slices/attachments";
import { draftsSlice } from "./slices/drafts";
import { identitySlice } from "./slices/identity";
import { sendingSlice } from "./slices/sending";
import type { ComposeState } from "./types";

export const useCompose = create<ComposeState>((set, get) => ({
  drafts: [],
  activeKey: null,
  pendingSends: {},

  ...draftsSlice(set, get),
  ...attachmentsSlice(set, get),
  ...sendingSlice(set, get),
  ...identitySlice(set, get),
}));

export { BODY_PROPS, FULL_PROPS } from "../mail";
export { draftFromMailto } from "./draft";
export { buildEmailObject, buildSubmission, sendOutcomeUnknown } from "./outgoing";
export type { AttachableFile, Draft, Priority, ReplyMode } from "./types";
export {
  DEFAULT_REPLY_MODE,
  REPLY,
  REPLY_ALL,
  REPLY_KEYS,
  UNDO_SEND_SECONDS,
} from "./types";

/*
 * Nothing written in one session is left open for the next.
 *
 * The other stores let go of their data when the session ends, by subscribing
 * to the sign-in state as this does. This one kept its composers, so on a
 * shared machine the next person to sign in -- without a reload, after an idle
 * sign-out, say -- found the last one's draft open and could send it.
 *
 * A draft that was saved is still in Drafts on the server, so closing it here
 * loses nothing. A send still inside its undo window was sent on the way out
 * if the sign-out was a deliberate one (see `flushPendingSends`, called from
 * `session.logout`); if the session had already ended there is nothing left to
 * send it with, so its timer is stopped rather than left to fire under whoever
 * signs in next.
 */
useSession.subscribe((s) => {
  if (s.status !== "anonymous") return;
  const { drafts, pendingSends } = useCompose.getState();
  if (!drafts.length && !Object.keys(pendingSends).length) return;
  for (const t of autosaveTimers.values()) window.clearTimeout(t);
  autosaveTimers.clear();
  for (const p of Object.values(pendingSends)) {
    window.clearTimeout(p.timer);
    toast.dismiss(p.toastId);
  }
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
});
