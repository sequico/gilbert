import { ChevronDown } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface Anchor {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export function anchorFromEl(el: Element | null): Anchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

interface PopoverProps {
  anchor: Anchor | null;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  /** Prefer opening below (default) or above. */
  side?: "bottom" | "top" | "right";
  width?: number | string;
  style?: CSSProperties;
  closeOnClick?: boolean;
  role?: string;
  /** Accessible name — dialogs need one; menus take it from their trigger. */
  ariaLabel?: string;
  /**
   * The trigger element, when the popover belongs to one. Presses that start
   * on it never close the popover: the trigger's own toggle decides, so
   * clicking a menu's button while the menu is open closes it instead of
   * closing and reopening in the same gesture.
   */
  trigger?: Element | null;
}

/** Generic anchored popover rendered in a portal; closes on outside click / Escape. */
export function Popover({
  anchor,
  onClose,
  children,
  className,
  align = "start",
  side = "bottom",
  width,
  style,
  closeOnClick = true,
  role = "menu",
  trigger,
  ariaLabel,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const el = ref.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    const aw = anchor.w ?? 0;
    const ah = anchor.h ?? 0;
    let left = align === "end" ? anchor.x + aw - rect.width : anchor.x;
    let top = side === "top" ? anchor.y - rect.height - 4 : anchor.y + ah + 4;
    if (side === "right") {
      left = anchor.x + aw + 4;
      top = anchor.y;
    }
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (left < 8) left = 8;
    let maxHeight = Math.min(vh - 16, 560);
    if (top + rect.height > vh - 8) {
      // flip above if there is room, else clamp
      const above = anchor.y - rect.height - 4;
      if (above >= 8 && side !== "right") top = above;
      else {
        top = Math.max(8, vh - rect.height - 8);
        maxHeight = vh - top - 8;
      }
    }
    if (top < 8) top = 8;
    setPos({ left, top, maxHeight });
  }, [anchor, align, side]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Element | null;
      if (ref.current && !ref.current.contains(target as Node)) {
        // The trigger's own press is not an outside press: its toggle closes
        // the menu (see useMenu), and closing here would race it.
        if (trigger?.contains(target as Node)) return;
        // A press that starts a drag on a pane splitter is a layout gesture,
        // not a dismissal: dragging the handle between panes must not close
        // what is open (the chat panel sits beside one).
        if (target?.closest?.(".splitter")) return;
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onScroll = (e: Event) => {
      // A popover closing on the page scrolling under it is intended -- it is
      // positioned from viewport coordinates and would drift off its anchor.
      // Its own content scrolling is not the page moving, so it is ignored.
      const target = e.target;
      if (ref.current && target instanceof Node && ref.current.contains(target)) return;
      onClose();
    };
    // Defer so the opening click doesn't immediately close.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("touchstart", onDown, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onScroll);
      // A popover positioned from viewport coordinates drifts off its anchor
      // when the page scrolls under it: close on a scroll too.
      window.addEventListener("scroll", onScroll, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [anchor, trigger, onClose]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      className={`popover ${className ?? ""}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
        width,
        maxHeight: pos?.maxHeight,
        ...style,
      }}
      onClick={(e) => {
        if (closeOnClick && (e.target as HTMLElement).closest(".menu-item")) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItemProps {
  icon?: ReactNode;
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  kbd?: string;
  active?: boolean;
  checked?: boolean;
  /** Renders the item as a link. An external one gets a new tab. */
  href?: string;
  external?: boolean;
}

export function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  kbd,
  active,
  checked,
  href,
  external,
}: MenuItemProps) {
  const inner = (
    <>
      {checked !== undefined ? (
        <span style={{ width: 16, display: "inline-flex" }}>{checked ? "✓" : ""}</span>
      ) : (
        icon
      )}
      <span className="grow truncate">{label}</span>
      {kbd && <span className="menu-kbd">{kbd}</span>}
    </>
  );
  const className = `menu-item ${danger ? "danger" : ""} ${active ? "active" : ""}`;
  /*
   * A real anchor when there is somewhere to go, rather than a button that
   * calls window.open. The browser's own handling of a link comes with it --
   * middle-click, a modifier-click, "open in new tab", the address on hover,
   * copying it -- none of which a button offers however carefully it is
   * scripted, and all of which someone expects from a menu entry that leaves
   * the app.
   */
  if (href) {
    return (
      <a
        className={className}
        href={href}
        role="menuitem"
        onClick={onClick}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
    >
      {inner}
    </button>
  );
}

export function MenuSep() {
  return <div className="menu-sep" />;
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className="menu-title">{children}</div>;
}

/**
 * One value out of a short list, chosen from a menu.
 *
 * A native <select> paints its own list, which the page cannot reach or style,
 * and which shows nothing that is inside it -- so the control that picks the
 * account an identity page acts on could not mark the current address, nor
 * carry it next to the thing it belongs to. This is the same popover menu as
 * every other list in the product, with the closed control shaped like the
 * field it sits in: the tick column a menu entry already has marks the choice,
 * and Escape, outside-click and the trigger toggle are the ones menus already
 * have.
 */
export interface MenuSelectOption {
  /** Handed to `onPick`, and what the trigger shows once chosen. */
  value: string;
  /** How the option reads in the list; defaults to `value`. */
  label?: string;
  /** Stable key for the entry; defaults to `value`. */
  id?: string;
}

export interface MenuSelectProps {
  value: string;
  /** Shown in place of `value` while nothing is chosen. */
  placeholder: string;
  options: MenuSelectOption[];
  onPick: (value: string) => void;
  /** The control's accessible name. */
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
}

export function MenuSelect({
  value,
  placeholder,
  options,
  onPick,
  ariaLabel,
  id,
  disabled,
}: MenuSelectProps) {
  const menu = useMenu();
  return (
    <>
      <button
        id={id}
        type="button"
        className="btn btn-block menu-select"
        disabled={disabled}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        onClick={menu.open}
      >
        <span className="truncate">{value || placeholder}</span>
        <ChevronDown size={16} />
      </button>
      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        width={320}
        ariaLabel={ariaLabel}
      >
        {/*
         * The empty choice is a real entry rather than a missing one: clearing
         * the pick is how a page goes back to asking which address it is about,
         * and a list with no way back to that state would be a step backwards
         * from the control this replaces.
         */}
        <MenuItem
          label={placeholder}
          checked={value === ""}
          onClick={() => {
            menu.close();
            onPick("");
          }}
        />
        <MenuSep />
        {options.map((o) => (
          <MenuItem
            key={o.id ?? o.value}
            label={o.label ?? o.value}
            checked={o.value === value}
            onClick={() => {
              menu.close();
              onPick(o.value);
            }}
          />
        ))}
      </Popover>
    </>
  );
}

/** An open menu: where it is anchored and the element that opened it. */
interface MenuState {
  anchor: Anchor | null;
  /** The trigger element, or null for a coordinate-opened context menu. */
  trigger: Element | null;
}

/** Hook to manage a menu anchored to a trigger element. */
export function useMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  return {
    anchor: menu?.anchor ?? null,
    /** The trigger the open menu belongs to, when it was opened from one. */
    trigger: menu?.trigger ?? null,
    open: (e: { currentTarget: Element } | Element) => {
      const el = "currentTarget" in e ? e.currentTarget : e;
      // The trigger toggles: activating the element that opened the menu
      // again closes it. The popover lets its own trigger's press through (it
      // does not close on it), so this is the one place that decides.
      if (menu && menu.trigger === el) {
        setMenu(null);
        return;
      }
      setMenu({ anchor: anchorFromEl(el), trigger: el });
    },
    openAt: (x: number, y: number) =>
      setMenu({ anchor: { x, y, w: 0, h: 0 }, trigger: null }),
    close: () => setMenu(null),
    isOpen: menu !== null,
  };
}

/** Simple tooltip via title-like hover with delay. */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  return (
    <span
      style={{ display: "inline-flex" }}
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        timer.current = window.setTimeout(
          () => setPos({ x: r.left + r.width / 2, y: r.bottom + 6 }),
          500,
        );
      }}
      onMouseLeave={() => {
        if (timer.current) window.clearTimeout(timer.current);
        setPos(null);
      }}
      onMouseDown={() => {
        if (timer.current) window.clearTimeout(timer.current);
        setPos(null);
      }}
    >
      {children}
      {pos &&
        createPortal(
          <div
            className="tooltip"
            style={{
              left: Math.max(8, Math.min(pos.x, window.innerWidth - 8)),
              top: pos.y,
              transform: "translateX(-50%)",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}
