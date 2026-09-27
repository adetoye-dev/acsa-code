/**
 * WorkbenchNav.tsx — the workbench's sidebar.
 *
 * One element, two states. Collapsed it is an icon column; expanded it is the
 * same column with its labels open. Nothing is rendered twice: every row is one
 * button whose label is simply hidden while the sidebar is narrow, which is what
 * keeps the two states from drifting apart.
 *
 * The rows also have exactly one *layout*. They are indented so the icon sits on
 * the centre line of the collapsed column (x=28 in a 56px column), and expanding
 * only opens the width and fades the labels in — nothing re-flows per state. Two
 * layouts swapping while the width animated is what made opening and closing look
 * broken: the icons flew across the panel because the collapsed layout centred
 * itself in a box that was still wide.
 *
 * Behaviour:
 * - pointing at it (or tabbing into it) expands it in place — the layout makes
 *   room rather than a second surface appearing over the top;
 * - a short hover intent keeps a cursor merely crossing it from shoving the
 *   editor sideways;
 * - choosing something collapses it again unless it is pinned, and the pin is
 *   remembered;
 * - Escape closes it, and it spans the full height of the window because the
 *   brand lives here rather than in a bar above it.
 *
 * The screens themselves live in IdeLayout; this only says which one is wanted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  FolderTree,
  GitBranch,
  Network,
  Package,
  Pin,
  PinOff,
  Settings,
} from "lucide-react";
import { Icon } from "../ui/Icon";
import { IdeBrandLogo } from "../ui/BrandLogos";

/** Every destination the workbench can show. */
export type ScreenId = "editor" | "git" | "codeMap" | "monitor" | "aiManager" | "marketplace";

interface NavItem {
  id: ScreenId;
  label: string;
  shortcut?: string;
  icon: typeof Activity;
}

/**
 * The rows. One list, read by both states, so they cannot disagree about what
 * exists — and deliberately not grouped: the rows keep the same height and the
 * same rhythm whether the labels are showing or not, which is what makes the
 * sidebar feel like one column that opened rather than a different one.
 */
export const NAV_ITEMS: NavItem[] = [
  { id: "editor", label: "Editor", shortcut: "⌘⇧E", icon: FolderTree },
  { id: "git", label: "Repository", shortcut: "⌘⇧G", icon: GitBranch },
  { id: "codeMap", label: "Code map", icon: Network },
  { id: "aiManager", label: "Models", icon: Cpu },
  { id: "marketplace", label: "Marketplace", shortcut: "⌘⇧X", icon: Package },
  { id: "monitor", label: "Performance", icon: Activity },
];

export const NAV_COLLAPSED_WIDTH = 56;
export const NAV_EXPANDED_WIDTH = 240;
/**
 * The rail's icon size and stroke, and the padding that keeps the icon on the
 * column's centre line once the labels are out. Derived rather than typed twice,
 * so changing the size is one number instead of three that must agree.
 *
 * Collapsed needs no padding: `justify-center` inside a square centred in the
 * column puts any size on the centre line. Expanded does: the row is inset 6px
 * (`mx-1.5`), so the padding makes up the rest of `NAV_COLLAPSED_WIDTH / 2`.
 */
export const NAV_ICON_SIZE = 18;
export const NAV_ICON_STROKE = 1.5;
export const NAV_ICON_PAD_LEFT = NAV_COLLAPSED_WIDTH / 2 - 6 - NAV_ICON_SIZE / 2;
/**
 * The height of a row, and therefore also the width of the collapsed highlight
 * — one square either way. Its distance from `NAV_ICON_SIZE` is the gutter: the
 * smaller this is, the tighter the highlight hugs the glyph.
 */
export const NAV_ROW_HEIGHT = 36;
/**
 * The brand mark's box, and the padding that puts its *centre* on the column's
 * line rather than its edge.
 *
 * Derived for the same reason the icons' padding is derived: the mark is wider
 * than an icon, so padding copied from the rows would leave its centre 4px off
 * the line the icons sit on. That is not hypothetical — it is exactly what
 * happened when the mark went from 40px to 32px, where 40 had landed on the line
 * by arithmetic coincidence (2px inset + 6px padding + half of 40).
 *
 * The 2 is the button's own `mx-0.5`, the 6 in `NAV_ICON_PAD_LEFT` above is the
 * rows' `mx-1.5`.
 */
export const NAV_BRAND_SIZE = 32;
export const NAV_BRAND_PAD_LEFT = NAV_COLLAPSED_WIDTH / 2 - 2 - NAV_BRAND_SIZE / 2;
/** A cursor crossing the sidebar must not shove the editor across. */
export const NAV_HOVER_INTENT_MS = 140;

interface WorkbenchNavProps {
  screen: ScreenId;
  onSelectScreen: (screen: ScreenId) => void;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onOpenSettings: () => void;
}

export function WorkbenchNav({
  screen,
  onSelectScreen,
  pinned,
  onPinnedChange,
  onOpenSettings,
}: WorkbenchNavProps) {
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  /**
   * Whether the last thing the user did was type. A click focuses the row it
   * lands on, and that is not a request to keep the sidebar open — without this,
   * choosing something with the mouse reopened the sidebar the moment the pointer
   * left it. The browser's `:focus-visible` says the same thing, but this is the
   * same thing *and* testable.
   */
  const keyboardIntent = useRef(false);
  useEffect(() => {
    const onKey = () => { keyboardIntent.current = true; };
    const onPointer = () => { keyboardIntent.current = false; };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  const [focusWithin, setFocusWithin] = useState(false);
  /**
   * Set when a choice or Escape closes the sidebar while the pointer is still on
   * it. Without it the pointer's own presence would reopen it immediately, which
   * reads as the menu refusing to close.
   */
  const [dismissed, setDismissed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const expanded = pinned || ((hovered || focusWithin) && !dismissed);

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const onPointerEnter = useCallback(() => {
    setDismissed(false);
    // Tabbing or clicking is deliberate; a pointer arriving is not.
    if (pinned) return;
    cancelHoverTimer();
    hoverTimer.current = window.setTimeout(() => setHovered(true), NAV_HOVER_INTENT_MS);
  }, [pinned, cancelHoverTimer]);

  const onPointerLeave = useCallback(() => {
    cancelHoverTimer();
    setHovered(false);
    setDismissed(false);
  }, [cancelHoverTimer]);

  useEffect(() => cancelHoverTimer, [cancelHoverTimer]);

  const close = useCallback(() => {
    setDismissed(true);
    if (pinned) onPinnedChange(false);
  }, [pinned, onPinnedChange]);

  const activate = useCallback(
    (item: NavItem) => {
      onSelectScreen(item.id);
      if (!pinned) setDismissed(true);
    },
    [pinned, onSelectScreen]
  );

  /** Arrow keys walk the rows; Escape closes the sidebar. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      if (rows.length === 0) return;
      event.preventDefault();
      const current = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[current === -1 ? 0 : (current + step + rows.length) % rows.length]?.focus();
    },
    [close]
  );

  // A click anywhere else puts it away, the same as any other menu.
  useEffect(() => {
    if (!expanded || pinned) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setDismissed(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [expanded, pinned]);

  /**
   * Label visibility, in one place. The text stays in the DOM so the width can
   * animate, but it is hidden from the accessibility tree while the sidebar is
   * collapsed — the row's `aria-label` is what is read then.
   */
  const labelClass = `transition-opacity duration-100 ${
    expanded ? "opacity-100" : "pointer-events-none opacity-0"
  }`;

  return (
    /* One sidebar in the flow: collapsed it is an icon column, expanded it is the
       same column with room for its labels, and the layout makes room for it
       either way. There is no second surface to drift out of step.
       The wrapper is presentational and carries the hover/keyboard plumbing, so
       the landmark inside stays a landmark — the same shape as the resize
       handles, which are pointer-only by nature. */
    <div
      role="presentation"
      data-testid="nav-surface"
      className="flex h-full shrink-0"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onFocus={() => {
        if (keyboardIntent.current) setFocusWithin(true);
      }}
      onBlur={() => setFocusWithin(false)}
      onKeyDown={handleKeyDown}
    >
    <aside
      ref={rootRef}
      aria-label="Workbench"
      data-testid="workbench-nav"
      style={{ width: expanded ? NAV_EXPANDED_WIDTH : NAV_COLLAPSED_WIDTH }}
      className="relative z-raised flex h-full shrink-0 flex-col overflow-hidden border-r border-hairline bg-[var(--vscode-activitybar-bg)] transition-[width] duration-150 ease-out"
    >
        {/* ── Identity ─────────────────────────────────────────────────────
            The brand is the sidebar's, not a bar's: it is the icon alone when
            collapsed and the icon with the name when there is room. */}
        <div className="relative flex h-12 shrink-0 items-center">
          <button
            type="button"
            onClick={() => onPinnedChange(!pinned)}
            data-testid="nav-brand"
            aria-expanded={expanded}
            title={pinned ? "ACSA Code — release the sidebar (⌘B)" : "ACSA Code — keep the sidebar open (⌘B)"}
            style={{
              height: NAV_ROW_HEIGHT,
              ...(expanded
                ? { paddingLeft: NAV_BRAND_PAD_LEFT }
                : { width: NAV_BRAND_SIZE }),
            }}
            className={`flex shrink-0 items-center rounded-lg transition-colors hover:bg-white/5 ${
              expanded
                ? "mx-0.5 w-[calc(100%-0.25rem)] gap-3 pr-2.5"
                : "mx-auto justify-center"
            }`}
          >
            {/* The brand is still the largest mark in the rail — that is what makes
                it the identity rather than another row — but it is sized to the
                rows it sits above instead of above them: 32px, just under a
                highlight, and well over half again the icons' ink, because the Apex
                artwork carries ~23% internal padding (its ink spans 788 of a 1024
                box) while a lucide glyph only fills about three quarters of its own.
                At 40px it read as a header block rather than a member of the column.
                Its centre is held on the column's line by `NAV_BRAND_PAD_LEFT`
                above, so the rail is still one column. */}
            <IdeBrandLogo size={NAV_BRAND_SIZE} className="h-8 w-8 shrink-0" />
            <span
              aria-hidden={!expanded}
              className={`truncate text-sm font-semibold tracking-tight text-zinc-100 ${labelClass}`}
            >
              ACSA Code
            </span>
          </button>
          {expanded && (
          <button
            type="button"
            onClick={() => onPinnedChange(!pinned)}
            data-testid="nav-pin"
            aria-pressed={pinned}
            aria-hidden={!expanded}
            tabIndex={expanded ? 0 : -1}
            title={pinned ? "Release the sidebar" : "Keep the sidebar open"}
            aria-label={pinned ? "Release the sidebar" : "Keep the sidebar open"}
            className={`absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 ${labelClass}`}
          >
            <Icon icon={pinned ? PinOff : Pin} strokeWidth={2} className="h-[18px] w-[18px]" />
          </button>
          )}
        </div>

        {/* ── Screens ───────────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pb-2 pt-5">
          {NAV_ITEMS.map((item) => {
            const active = screen === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => activate(item)}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={`${item.label}${item.shortcut ? ` (${item.shortcut})` : ""}`}
                data-testid={`nav-item-${item.id}`}
                className={`flex shrink-0 items-center rounded-lg text-left transition-colors ${
                  expanded
                    ? "mx-1.5 w-[calc(100%-0.75rem)] gap-3 pr-2.5"
                    : "mx-auto justify-center"
                } ${active ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}
                style={{
                  height: NAV_ROW_HEIGHT,
                  ...(expanded ? { paddingLeft: NAV_ICON_PAD_LEFT } : { width: NAV_ROW_HEIGHT }),
                }}
              >
                {/* Size only: the row's own colour carries the state, and the
                    active screen takes the accent. `size` and `strokeWidth` come
                    from the rail's constants above, so the size lives in one
                    place. Passing `size` is deliberate rather than a class:
                    it is an explicit instruction, so it cannot be overridden. */}
                <Icon
                  icon={item.icon}
                  size={NAV_ICON_SIZE}
                  strokeWidth={NAV_ICON_STROKE}
                  className={`shrink-0 ${active ? "text-accent" : ""}`}
                />
                <span
                  aria-hidden={!expanded}
                  className={`truncate text-sm font-semibold ${labelClass} ${
                    expanded ? "min-w-0 flex-1" : "w-0 flex-none overflow-hidden"
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>

        <div className="shrink-0 pb-2">
          <Row
            expanded={expanded}
            labelClass={labelClass}
            icon={Settings}
            label="Settings"
            testId="nav-settings"
            onClick={() => {
              onOpenSettings();
              if (!pinned) setDismissed(true);
            }}
          />
        </div>
    </aside>
    </div>
  );
}

/** A row that is an icon when the sidebar is collapsed and a row when it is not. */
function Row({
  expanded,
  labelClass,
  icon,
  label,
  testId,
  onClick,
}: {
  expanded: boolean;
  labelClass: string;
  icon: typeof Settings;
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
      className={`flex shrink-0 items-center rounded-lg text-left text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 ${
        expanded ? "mx-1.5 w-[calc(100%-0.75rem)] gap-3 pr-2.5" : "mx-auto justify-center"
      }`}
      style={{
        height: NAV_ROW_HEIGHT,
        ...(expanded ? { paddingLeft: NAV_ICON_PAD_LEFT } : { width: NAV_ROW_HEIGHT }),
      }}
    >
      <Icon icon={icon} size={NAV_ICON_SIZE} strokeWidth={NAV_ICON_STROKE} className="shrink-0" />
      <span
        aria-hidden={!expanded}
        className={`truncate text-sm font-semibold ${labelClass} ${
          expanded ? "min-w-0 flex-1" : "w-0 flex-none overflow-hidden"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

export default WorkbenchNav;
