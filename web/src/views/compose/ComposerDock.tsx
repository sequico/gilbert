import { Suspense, useEffect } from "react";
import { useCompose } from "@/store/compose";
import { useIsMobile } from "@/ui/misc";
import { LazyComposer, warmComposer } from "../lazyPieces";

export function ComposerDock() {
  const drafts = useCompose((s) => s.drafts);
  const activeKey = useCompose((s) => s.activeKey);
  const isMobile = useIsMobile();
  // The dock mounts with the shell, and Compose is offered on every screen
  // (the drawer's button falls back to mail's action where no module owns the
  // section), so the composer chunk is asked for as soon as the browser is
  // idle — once, whatever happens afterwards.
  useEffect(() => {
    warmComposer();
  }, []);
  if (!drafts.length) return null;
  // On mobile only the active composer is shown (full screen); others are minimized bars.
  const visible = isMobile
    ? drafts.filter((d) => d.key === activeKey || d.minimized)
    : drafts;
  // On desktop a full-screen composer stands alone: the rest are hidden until it is restored.
  const hasMaximized = !isMobile && drafts.some((d) => d.maximized && !d.minimized);
  return (
    <div className={`composer-dock${hasMaximized ? " has-maximized" : ""}`}>
      <Suspense fallback={null}>
        {visible.map((d) => (
          <LazyComposer
            key={d.key}
            draft={isMobile && d.key !== activeKey ? { ...d, minimized: true } : d}
          />
        ))}
      </Suspense>
    </div>
  );
}
