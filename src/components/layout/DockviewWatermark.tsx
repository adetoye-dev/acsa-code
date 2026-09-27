/**
 * DockviewWatermark.tsx — the empty editor surface.
 *
 * One panel, not two. It used to render a project card and then a separate list
 * of shortcuts underneath it, which read as two menus competing for the same
 * attention and split "what do I do next?" in half. Everything actionable now
 * lives in a single panel: the project's own commands first, when the project
 * has any, then the keys worth learning, with one divider between the two.
 *
 * What was pruned is the redundant, not the merely repeated. The terminal toggle
 * lost its row: it is a panel-visibility switch with a button in the titlebar
 * directly above this surface, and the project rows below already run their
 * commands in that same terminal. The command palette kept its row even though
 * the omnibar mentions it, because ⌘⇧P is otherwise the only way to reach command
 * mode — the omnibar reopens whatever mode was last used, so a pointer-only user
 * would have lost it.
 *
 * Layout: brand above, panel centred on the halfway line, and the halftone field
 * drawn up to that line from the bottom — so the panel's lower half sits on the
 * pattern and its upper half on plain background. See `.acsa-watermark-field` in
 * index.css.
 */
import React from "react";
import { Download, Hammer, Loader2, MessageSquare, Play, Search, Sparkles } from "lucide-react";
import { Icon } from "../ui/Icon";
import { IdeBrandLogo } from "../ui/BrandLogos";
import type { ProjectStatus } from "../../services/projectSetup";

export interface WatermarkSetup {
  status: ProjectStatus | null;
  busyCommand: string | null;
  onRun: (label: string, command: string) => void;
}

export interface DockviewWatermarkProps {
  onOpenFile?: () => void;
  onOpenCommands?: () => void;
  onToggleAi?: () => void;
  /** Project readiness, so the panel can offer whatever command comes next. */
  setup?: WatermarkSetup;
  [key: string]: any;
}

interface Row {
  id: string;
  label: string;
  icon: typeof Search;
  action: () => void;
  /** The command this runs, shown right-aligned. */
  command?: string;
  /** The shortcut that does the same thing, shown right-aligned. */
  kbd?: string;
  primary?: boolean;
  busy?: boolean;
}

const ActionRow: React.FC<Row & { disabled?: boolean }> = ({
  label,
  icon,
  action,
  command,
  kbd,
  primary,
  busy,
  disabled,
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={action}
    className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors disabled:cursor-default disabled:opacity-50 ${
      primary
        ? "bg-sky-600 text-white hover:bg-sky-500"
        : "text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100"
    }`}
  >
    <Icon
      icon={busy ? Loader2 : icon}
      className={`h-3.5 w-3.5 shrink-0 ${
        busy ? "animate-spin" : primary ? "opacity-90" : "text-zinc-500 group-hover:text-zinc-200"
      }`}
    />
    <span className="font-medium truncate">{busy ? `${label}…` : label}</span>
    {command && (
      <code className={`ml-auto shrink-0 font-mono text-3xs ${primary ? "opacity-70" : "opacity-50"}`}>
        {command}
      </code>
    )}
    {kbd && (
      <kbd className="ml-auto shrink-0 rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-3xs text-zinc-500 transition-colors group-hover:text-zinc-300">
        {kbd}
      </kbd>
    )}
  </button>
);

export const DockviewWatermark: React.FC<DockviewWatermarkProps> = ({
  onOpenFile,
  onOpenCommands,
  onToggleAi,
  setup,
}) => {
  const handleOpenFile = () => {
    if (onOpenFile) onOpenFile();
    else window.dispatchEvent(new CustomEvent("acsa:open-file-search"));
  };

  const handleOpenCommands = () => {
    if (onOpenCommands) onOpenCommands();
    else window.dispatchEvent(new CustomEvent("acsa:open-command-palette"));
  };

  const handleToggleAi = () => {
    if (onToggleAi) onToggleAi();
    else window.dispatchEvent(new CustomEvent("acsa:toggle-ai"));
  };

  const status = setup?.status ?? null;
  const busyCommand = setup?.busyCommand ?? null;
  const busy = busyCommand !== null;

  /* The project's commands, when it has any. A scaffolded project cannot run at
     all until its packages are downloaded, so that replaces run/build rather
     than sitting beside them. */
  const projectRows: Row[] = [];
  if (status?.hasPackageJson) {
    if (status.needsInstall) {
      const command = status.installCommand || "npm install";
      projectRows.push({
        id: "install",
        label: `Install dependencies (${status.manager})`,
        icon: Download,
        command,
        primary: true,
        busy: busyCommand === command,
        action: () => setup?.onRun("Install dependencies", command),
      });
    } else {
      if (status.devCommand) {
        projectRows.push({
          id: "dev",
          label: "Run dev server",
          icon: Play,
          command: status.devCommand,
          primary: true,
          busy: busyCommand === status.devCommand,
          action: () => setup?.onRun("Run dev server", status.devCommand),
        });
      }
      if (status.buildCommand) {
        projectRows.push({
          id: "build",
          label: "Build",
          icon: Hammer,
          command: status.buildCommand,
          busy: busyCommand === status.buildCommand,
          action: () => setup?.onRun("Build", status.buildCommand),
        });
      }
    }
  }

  const shortcutRows: Row[] = [
    { id: "search", label: "Search files", icon: Search, kbd: "⌘ P", action: handleOpenFile },
    {
      id: "commands",
      label: "Command palette",
      icon: Sparkles,
      kbd: "⌘ ⇧ P",
      action: handleOpenCommands,
    },
    {
      id: "assistant",
      label: "Ask the assistant",
      icon: MessageSquare,
      kbd: "⌘ L",
      action: handleToggleAi,
    },
  ];

  const heading = projectRows.length
    ? status?.needsInstall
      ? "This project needs its dependencies installed"
      : "This project is ready to run"
    : "Quick actions";
  const blurb = projectRows.length
    ? status?.needsInstall
      ? "It was just scaffolded, so its packages are not downloaded yet. Nothing will run until they are."
      : "Dependencies are installed. Start the dev server to see your project in the browser."
    : "Nothing is open yet. Pick a file, or ask the assistant to build something.";

  return (
    <div className="relative flex h-full w-full select-none items-center justify-center overflow-hidden bg-[var(--vscode-editor-bg)] px-4">
      <div className="acsa-watermark-field" aria-hidden="true" />

      {/* The panel is the only thing in flow, so it is what the parent centres:
          its midpoint lands on the halfway line, which is where the pattern
          stops. The brand is positioned off its top edge and never takes a
          click. */}
      <div className="relative z-10 flex flex-col items-center">
        <div className="pointer-events-none absolute bottom-full mb-7 flex flex-col items-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03] shadow-2xl">
            <IdeBrandLogo size={24} className="opacity-75" />
          </div>
          <div className="max-w-full text-center text-xs font-semibold uppercase tracking-wider text-zinc-400">
            ACSA Code
          </div>
          <div className="mt-1 max-w-full text-center font-mono text-2xs text-zinc-500">
            Local-first agentic engineering workbench
          </div>
        </div>

        <div
          data-testid="watermark-actions"
          className="w-80 max-w-full overflow-hidden rounded-xl border border-white/[0.08] bg-[var(--vscode-editor-bg)] shadow-2xl"
        >
          <div className="px-3.5 pb-2.5 pt-3">
            <div className="text-xs font-semibold text-zinc-200">{heading}</div>
            <p className="mt-1 text-2xs leading-relaxed text-zinc-500">{blurb}</p>
          </div>

          {projectRows.length > 0 && (
            <>
              <div className="flex flex-col gap-1 px-2">
                {projectRows.map((row) => (
                  <ActionRow key={row.id} {...row} disabled={busy && !row.busy} />
                ))}
              </div>
              <p className="px-3.5 pb-3 pt-2 text-3xs text-zinc-500">
                Runs in the terminal below so you can watch the output.
              </p>
              <div className="h-px bg-white/[0.06]" />
            </>
          )}

          <div className="flex flex-col gap-0.5 p-2">
            {shortcutRows.map((row) => (
              <ActionRow key={row.id} {...row} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DockviewWatermark;
