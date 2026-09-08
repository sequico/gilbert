import { Component, type ErrorInfo, type ReactNode } from "react";
import { recoverFromCrash } from "@/lib/crashRecovery";

interface Props {
  children: ReactNode;
}

interface State {
  failed: Error | null;
}

/**
 * The last line between an uncaught error and a blank page nobody reloads.
 *
 * Nothing below this boundary catches an error on its own, and an error no
 * boundary catches unmounts the whole tree — a white page with the console as
 * the only witness. That is the right outcome for a genuine bug, but it is
 * also the shape of a view whose chunk failed to load: after a deploy the
 * chunk is gone, and at the same build a chunk fetch can die with a
 * connection that stopped while the tab sat idle. Both are repaired by a
 * reload — new bundle, new connections, fresh state — and the session
 * survives it, since it lives in the sealed cookie and the server's session
 * file rather than in the tab.
 *
 * So a caught error is handed to `recoverFromCrash`, which writes it down
 * where the reload cannot erase it and reloads once, guarded so a genuine
 * bug cannot loop. Nothing is rendered while that happens: the tree is
 * already gone, and a designed error screen would be a second UI to
 * translate and maintain for the one case in a thousand.
 */
export class CrashBoundary extends Component<Props, State> {
  state: State = { failed: null };

  static getDerivedStateFromError(error: Error): Partial<State> | null {
    return { failed: error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recoverFromCrash(error, info.componentStack ?? undefined);
  }

  render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
