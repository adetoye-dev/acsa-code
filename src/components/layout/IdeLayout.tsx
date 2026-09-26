/**
 * IdeLayout.tsx — the workbench shell.
 *
 * One screen at a time, chosen from a single navigation surface:
 * 1. Titlebar: the project switcher and branch, the omnibar, the toggles that
 *    belong to the editor screen (file tree, terminal, chat), and the updater.
 * 2. Navigation: an icon rail with a panel that reveals on hover, collapses
 *    after a choice, and can be pinned with Cmd+B. See WorkbenchNav.tsx.
 * 3. Editor screen: the file tree paired with the dockview (Monaco tabs and the
 *    diff inspector) and the terminal/output panel beneath it.
 * 4. Pages: repository, code map, models & providers, marketplace, and host
 *    health — full width, with the terminal and the chat dock set aside on the
 *    way in and replaced on the way back.
 * 5. Status Bar: branch, index state, and the host's live readings.
 * 6. Command Palette & Quick Open: Cmd+Shift+P and Cmd+P.
 */

import { useState, useRef, useEffect, useCallback, useMemo, createContext, useContext, lazy, Suspense } from "react";
import {
  DockviewReact,
  DockviewReadyEvent,
  DockviewApi,
  IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview/dist/styles/dockview.css";
import { Activity, Save, Folder, Search, GitPullRequest, GitFork, Download, PanelBottom, PanelLeft, FolderPlus, Settings, PanelRight, Cpu, MessageSquare, Palette, Package, Bot, GitCompare, X, Network } from "lucide-react";
import { Icon } from "../ui/Icon";
import { FileIcon } from "../ui/FileIcon";

import { StatusBar, blockedLabel } from "./StatusBar";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { DockviewWatermark } from "./DockviewWatermark";
import { WORKBENCH_PANELS } from "./WorkbenchPanels";
import { WorkbenchProvider, type WorkbenchLive } from "./WorkbenchContext";
import { SurfaceFallback } from "../ui/SurfaceFallback";
import {
  fetchProjectStatus,
  runInProjectTerminal,
  type ProjectStatus,
} from "../../services/projectSetup";
import { ExplorerSidebar } from "../sidebar/ExplorerSidebar";
import { MarketplaceSidebar } from "../sidebar/MarketplaceSidebar";
import { GitDashboard } from "../dashboards/GitDashboard";
import { WorkbenchNav, NAV_ITEMS, type ScreenId } from "./WorkbenchNav";
import { UpdateButton } from "./UpdateButton";
import { VersionControlDropdown } from "./VersionControlDropdown";
import { CloneModal } from "../modals/CloneModal";
import { ProjectModal } from "../ProjectModal";
import { SettingsModal } from "../SettingsModal";
import { ErrorBoundary } from "../ErrorBoundary";
import { CommandPalette, CommandItem } from "../modals/CommandPalette";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { AiAssistantChat } from "../dashboards/AiAssistantChat";
import { getDefaultProvider } from "../../services/aiModelManager";
import {
  applyAccent,
  applyGlobalWorkbenchTheme,
  DEFAULT_ACCENT,
} from "../../services/themeManager";
import { systemMetricsService } from "../../services/systemMetricsService";
import { chatDraft } from "../../services/chatDraft";
import { openOllamaSetupWizard, EVENT_OPEN_AI_MANAGEMENT, EVENT_START_CODING_WITH_OLLAMA } from "../../services/ollamaSetup";
import type { UsePipelineReturn } from "../../hooks/usePipeline";
import { gitFetch } from "../../services/gitClient";

const SPECIAL_PANELS = ["dock_diff", "diff_"];

/** Under this width the chat dock steps aside so the editor keeps its room. */
const DOCK_YIELD_WIDTH = 1000;

/* ── Lazily-loaded heavy surfaces ─────────────────────────────────────────
   Monaco (~1.5 MB) and the terminal/graph stacks dominate the bundle but are
   not needed to paint the workbench. Splitting them keeps first paint cheap;
   each defers until the surface is actually opened. The dockview panels that
   pull in Monaco live in WorkbenchPanels.tsx and split it there. */
const BottomPanel = lazy(() =>
  import("../panels/BottomPanel").then((m) => ({ default: m.BottomPanel }))
);
const PerformanceDashboard = lazy(() =>
  import("../dashboards/PerformanceDashboard").then((m) => ({ default: m.PerformanceDashboard }))
);
const AiManagementDashboard = lazy(() =>
  import("../dashboards/AiManagementDashboard").then((m) => ({ default: m.AiManagementDashboard }))
);
const CodeMapDashboard = lazy(() =>
  import("../dashboards/CodeMapDashboard").then((m) => ({ default: m.CodeMapDashboard }))
);

/**
 * Tab-chrome state shared with dockview's tab headers. Dockview renders tab
 * headers outside the normal React parent chain, so we publish dirtiness and
 * the close-request handler through a context rather than panel params.
 */
interface TabChrome {
  /** Paths of tabs with unsaved in-memory edits. */
  dirty: ReadonlySet<string>;
  /** Close a tab, confirming first when it has unsaved edits. */
  requestClose: (close: () => void, title: string, isDirty: boolean) => void;
}

const TabChromeContext = createContext<TabChrome>({
  dirty: new Set(),
  requestClose: (close) => close(),
});

const DockviewCustomTab = (props: IDockviewPanelHeaderProps & { onPointerDown?: any; onPointerUp?: any; onPointerLeave?: any }) => {
  const { api, onPointerDown, onPointerUp, onPointerLeave } = props;
  const [title, setTitle] = useState(api.title);
  const tabChrome = useContext(TabChromeContext);

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title));
    return () => disposable.dispose();
  }, [api]);

  const filePath = (props.params as any)?.filePath || api.id;
  const isDirty = tabChrome.dirty.has(filePath) || tabChrome.dirty.has(api.id);
  const renderIcon = () => {
    if (api.id.startsWith("diff_") || api.id === "dock_diff") return <Icon icon={GitCompare} className="w-3.5 h-3.5 text-zinc-400 shrink-0 mr-1.5" />;
    return <FileIcon fileName={title || filePath} className="w-3.5 h-3.5 shrink-0 mr-1.5" />;
  };

  return (
    <div data-testid="dockview-dv-default-tab" className={`dv-default-tab group flex items-center h-full px-2 cursor-pointer select-none${isDirty ? " is-dirty" : ""}`} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerLeave={onPointerLeave}>
      {renderIcon()}
      <span className="dv-default-tab-content truncate text-xs font-medium">{title}</span>
      {isDirty && (
        <span
          className="acsa-tab-dirty ml-1 shrink-0 group-hover:opacity-0"
          title="Unsaved changes"
          aria-label="Unsaved changes"
          data-testid="tab-dirty-indicator"
        />
      )}
      <button
        type="button"
        className="dv-default-tab-action ml-1 p-0.5 rounded hover:bg-white/10"
        aria-label={isDirty ? `Close tab (unsaved changes in ${title})` : "Close tab"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          tabChrome.requestClose(() => api.close(), title || filePath, isDirty);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Icon icon={X} className="w-3 h-3 text-zinc-400 hover:text-zinc-200" />
      </button>
    </div>
  );
};

export function IdeLayout(pipeline: UsePipelineReturn) {
  const {
    activeProject,
    projectFiles,
    openTabs,
    activeTabPath,
    currentDiff,
    setCurrentDiff,
    applyPatchToTab,
    touchedPaths,
    isProjectModalOpen,
    setIsProjectModalOpen,
    isSettingsModalOpen,
    setIsSettingsModalOpen,
    aiSettings,
    setAiSettings,
    pickFolder,
    openFolder,
    openFile,
    closeTab,
    selectTab,
    updateTabContent,
    saveFile,
    createFileOrFolder,
    deleteFile,
    createProject,
    refreshProjectFiles,
    workspaceRevision,
    indexStatus,
    isIndexing,
    syncIndex,
    status,
    activityLog,
    runPipeline,
    cancelPipeline,
    steerPipeline,
    undoLastTurn,
    clearLog,
    isTauriAvailable,
    streamingAnswer,
    streamingThought,
    failureDetail,
    noFileChanges,
    waitingForUser,
    pendingApproval,
    pendingQuestion,
    respondToQuestion,
    turnElapsedMs,
    turnLimitMinutes,
    turnChanges,
    openDiff,
    reviewDiff,
    clearReviewDiff,
    respondToApproval,
    agentSteps,
  } = pipeline;

  // One screen at a time, chosen from the nav: the editor (its file tree, the
  // dockview and the terminal) or a full-width page beside it.
  const [screen, setScreen] = useState<ScreenId>("editor");
  const [navPinned, setNavPinned] = useState<boolean>(() => {
    try {
      return localStorage.getItem("acsa_nav_pinned") === "1";
    } catch {
      return false;
    }
  });
  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("acsa_explorer_width");
      if (saved) {
        const num = parseInt(saved, 10);
        if (!isNaN(num) && num >= 180 && num <= 520) return num;
      }
    } catch {}
    return 260;
  });
  const [isResizingExplorer, setIsResizingExplorer] = useState(false);
  const explorerWidthRef = useRef(explorerWidth);
  explorerWidthRef.current = explorerWidth;

  useEffect(() => {
    try {
      localStorage.setItem("acsa_nav_pinned", navPinned ? "1" : "0");
    } catch {}
  }, [navPinned]);
  const startResizingExplorer = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingExplorer(true);

    const startX = e.clientX;
    const startWidth = explorerWidthRef.current;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      // Bound by the window as well as a fixed ceiling: 500px is fine on a
      // desktop and most of a small window.
      const ceiling = Math.max(180, Math.min(520, Math.round(window.innerWidth * 0.4)));
      const newWidth = Math.max(180, Math.min(ceiling, startWidth + delta));
      setExplorerWidth(newWidth);
      explorerWidthRef.current = newWidth;
    };

    const handleMouseUp = () => {
      setIsResizingExplorer(false);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      try {
        localStorage.setItem("acsa_explorer_width", explorerWidthRef.current.toString());
      } catch {}
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, []);

  // Closed on launch: the terminal is a tool you reach for, not the default view
  // of half the canvas. The titlebar toggle and ⌘J are how you get it.
  const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(false);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  /** What the editor's dock looked like before a page took the canvas. */
  const dockBeforePageRef = useRef<{ right: boolean; bottom: boolean } | null>(null);

  /**
   * Below this the editor is being squeezed rather than shared: 56 of sidebar,
   * the file tree, the dock and the editor all want room, and the editor is the
   * one being worked in. So the dock gives way — once, when the window crosses
   * the line. It never reopens itself: a window that keeps reopening a panel you
   * closed is worse than one that leaves it closed.
   */
  useEffect(() => {
    let wasNarrow = window.innerWidth < DOCK_YIELD_WIDTH;
    if (wasNarrow) setIsRightPanelOpen(false);
    const onResize = () => {
      const narrow = window.innerWidth < DOCK_YIELD_WIDTH;
      if (narrow && !wasNarrow) setIsRightPanelOpen(false);
      wasNarrow = narrow;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Full-canvas chat surface ("Open in Center Stage"). Rendered as an overlay
  // over the editor grid so it has no dockview tab chrome of its own.
  const [isCenterChatOpen, setIsCenterChatOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isCloneModalOpen, setIsCloneModalOpen] = useState(false);
  const [gitBranch, setGitBranch] = useState("main");
  const [paletteMode, setPaletteMode] = useState<"command" | "file">("command");
  const [themeId, setThemeId] = useState<string>(
    () => (typeof window !== "undefined" ? localStorage.getItem("acsa_ide_theme") || "github-dark" : "github-dark")
  );
  // Orthogonal to the theme: one theme ships, but the accent is the brand
  // decision, and seeing it in the real workbench beats reading hex codes.
  const [accentId, setAccentId] = useState<string>(
    () =>
      (typeof window !== "undefined" ? localStorage.getItem("acsa_ide_accent") : null) ||
      DEFAULT_ACCENT,
  );
  // Must name a section that exists in SETTINGS_TREE. It said "agents", which
  // matches nothing, so opening Settings landed on an empty pane — the whole
  // dialog looked broken until you happened to click a nav item.
  const [settingsModalTab, setSettingsModalTab] = useState<string>("agent");
  const [targetEditorLine, setTargetEditorLine] = useState<{
    path: string;
    line: number;
    column?: number;
    ts: number;
  } | null>(null);
  const [selectedCode, setSelectedCode] = useState("");
  const dockviewApiRef = useRef<DockviewApi | null>(null);

  /** Something asked for a file: the editor screen is where files are looked at. */
  const revealEditorForFile = useCallback(() => {
    setScreen("editor");
  }, []);

  const handleOpenFileAtLocation = useCallback(
    async (filePath: string, lineNumber?: number, column?: number) => {
      // Looking at a file means the editor screen: put the chat and any page
      // away so the file is actually visible.
      setIsCenterChatOpen(false);
      revealEditorForFile();
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      await openFile({
        name: fileName,
        path: filePath,
        is_dir: false,
        size_bytes: 0,
      });
      if (lineNumber && lineNumber > 0) {
        setTargetEditorLine({
          path: filePath,
          line: lineNumber,
          column,
          ts: Date.now(),
        });
      }
    },
    [openFile, revealEditorForFile]
  );

  // A file was chosen somewhere in the chrome: show it on the editor screen
  // rather than loading it behind a page or the full-canvas chat.
  const openFileInEditor = useCallback(
    (file: Parameters<typeof openFile>[0]) => {
      setIsCenterChatOpen(false);
      revealEditorForFile();
      return openFile(file);
    },
    [openFile, revealEditorForFile]
  );

  const openThemeEditor = useCallback(() => {
    setSettingsModalTab("appearance");
    setIsSettingsModalOpen(true);
  }, [setIsSettingsModalOpen]);

  const openSettings = useCallback(() => {
    setSettingsModalTab("agent");
    setIsSettingsModalOpen(true);
  }, [setIsSettingsModalOpen]);

  // Apply theme to entire workbench DOM
  useEffect(() => {
    applyGlobalWorkbenchTheme(themeId);
    try {
      localStorage.setItem("acsa_ide_theme", themeId);
    } catch {
      // Ignore localStorage write failures
    }
  }, [themeId]);

  // Applied the same way the theme is: effect, persisted, so a relaunch keeps it.
  useEffect(() => {
    applyAccent(accentId);
    try {
      localStorage.setItem("acsa_ide_accent", accentId);
    } catch {
      // Ignore localStorage write failures
    }
  }, [accentId]);

  const refreshBranch = useCallback(async () => {
    try {
      const res = await gitFetch("/api/git/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: activeProject.path }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.branch) {
          setGitBranch(data.branch);
        }
      }
    } catch {}
  }, [activeProject.path]);

  useEffect(() => {
    refreshBranch();
  }, [refreshBranch]);

  const handleOpenFolder = async () => {
    const picked = await pickFolder();
    if (picked) {
      await openFolder(picked);
    }
  };

  /**
   * Show a screen.
   *
   * A page wants the canvas, so the terminal and the chat dock step aside — and
   * are put back when the editor is chosen again, which is what keeps the nav
   * from being a one-way door.
   */
  const openScreen = useCallback(
    (next: ScreenId) => {
      if (next === screen) return;
      if (next === "editor") {
        const dock = dockBeforePageRef.current;
        if (dock) {
          setIsRightPanelOpen(dock.right);
          setIsBottomPanelOpen(dock.bottom);
          dockBeforePageRef.current = null;
        }
      } else if (screen === "editor") {
        dockBeforePageRef.current = { right: isRightPanelOpen, bottom: isBottomPanelOpen };
        setIsCenterChatOpen(false);
        setIsRightPanelOpen(false);
        setIsBottomPanelOpen(false);
      }
      setScreen(next);
    },
    [screen, isRightPanelOpen, isBottomPanelOpen]
  );

  const openAiManagerTab = () => openScreen("aiManager");
  const openMarketplaceTab = () => openScreen("marketplace");

  const openAiChatTab = () => {
    // Mutual exclusivity: close right panel when opening center stage tab
    setIsRightPanelOpen(false);
    // When opening full chat mode, also close the terminal/bottom panel section
    setIsBottomPanelOpen(false);
    setIsCenterChatOpen(true);
  };

  // ── Listen for Programmatic Open AI Manager Requests ──────────────────────
  useEffect(() => {
    const handleOpenAiManager = () => {
      openAiManagerTab();
    };
    window.addEventListener(EVENT_OPEN_AI_MANAGEMENT, handleOpenAiManager);
    return () => window.removeEventListener(EVENT_OPEN_AI_MANAGEMENT, handleOpenAiManager);
    // Subscribed once, on purpose: this is a global event bus. `openAiManagerTab`
    // only calls stable state setters, so there is nothing to re-subscribe for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Listen for Programmatic Start Coding with Ollama Requests ─────────────
  useEffect(() => {
    const handleStartCoding = () => {
      setIsCenterChatOpen(false);
      setIsRightPanelOpen(true);
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("acsa:focus-ai-chat-input"));
      }, 80);
    };
    window.addEventListener(EVENT_START_CODING_WITH_OLLAMA, handleStartCoding);
    return () => window.removeEventListener(EVENT_START_CODING_WITH_OLLAMA, handleStartCoding);
  }, []);

  // ── Listen for Watermark / Global Quick Action Requests ───────────────────
  useEffect(() => {
    const handleOpenFileSearch = () => {
      setPaletteMode("file");
      setIsCommandPaletteOpen(true);
    };
    const handleOpenCommandPalette = () => {
      setPaletteMode("command");
      setIsCommandPaletteOpen(true);
    };
    const handleToggleTerminal = () => setIsBottomPanelOpen((prev) => !prev);
    const handleToggleAi = () => {
      // Any "AI Assistant" affordance targets the docked assistant; leaving the
      // full-canvas overlay first keeps the two surfaces from fighting.
      setIsCenterChatOpen(false);
      setIsRightPanelOpen((prev) => !prev);
    };

    window.addEventListener("acsa:open-file-search", handleOpenFileSearch);
    window.addEventListener("acsa:open-command-palette", handleOpenCommandPalette);
    window.addEventListener("acsa:toggle-terminal", handleToggleTerminal);
    window.addEventListener("acsa:toggle-ai", handleToggleAi);

    return () => {
      window.removeEventListener("acsa:open-file-search", handleOpenFileSearch);
      window.removeEventListener("acsa:open-command-palette", handleOpenCommandPalette);
      window.removeEventListener("acsa:toggle-terminal", handleToggleTerminal);
      window.removeEventListener("acsa:toggle-ai", handleToggleAi);
    };
  }, []);

  // ── Global Keyboard Shortcuts Engine ──────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;

      // Cmd+Shift+P: Command Palette
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteMode("command");
        setIsCommandPaletteOpen((prev) => !prev);
        return;
      }

      // Cmd+Shift+E: the editor screen
      if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        revealEditorForFile();
        return;
      }

      // Cmd+Shift+G: the repository page
      if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        openScreen("git");
        return;
      }

      // Cmd+Shift+X: the marketplace page
      if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === "x") {
        e.preventDefault();
        openScreen("marketplace");
        return;
      }

      // Cmd+P: Quick Open File
      if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteMode("file");
        setIsCommandPaletteOpen(true);
        return;
      }

      // Cmd+B: pin or unpin the navigation panel
      if (isCmdOrCtrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setNavPinned((prev) => !prev);
        return;
      }

      // Cmd+J or Ctrl+`: Toggle Bottom Panel. The terminal lives on the editor
      // screen, so asking for it from a page means going there.
      if ((isCmdOrCtrl && e.key.toLowerCase() === "j") || (e.ctrlKey && e.key === "`")) {
        e.preventDefault();
        if (screen !== "editor") {
          setScreen("editor");
          setIsBottomPanelOpen(true);
        } else {
          setIsBottomPanelOpen((prev) => !prev);
        }
        return;
      }

      // Cmd+L / Ctrl+L: send the current editor selection to Chat/Ask
      if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        // The chat dock is part of the editor screen; from a page, come back.
        if (screen !== "editor") setScreen("editor");
        if (isCenterChatOpen) {
          // Full-canvas chat is a focused mode: Cmd+L returns to the side dock.
          setIsCenterChatOpen(false);
          setIsRightPanelOpen(true);
        } else {
          setIsRightPanelOpen((prev) => !prev);
        }
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("acsa:ai-workflow", { detail: "chat" })), 0);
        return;
      }

      // Cmd+I / Ctrl+I or Shift+Cmd+I: prepare an Agent edit from current selection
      if (isCmdOrCtrl && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setIsRightPanelOpen(true);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("acsa:ai-workflow", { detail: "agent" })), 0);
        return;
      }

      // Alt+Cmd+P / Ctrl+Alt+P: prepare an Architectural Plan / Brainstorm
      if (isCmdOrCtrl && e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setIsRightPanelOpen(true);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("acsa:ai-workflow", { detail: "plan" })), 0);
        return;
      }

      // Cmd+S: Save active file
      if (isCmdOrCtrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTabPath) {
          saveFile(activeTabPath);
        }
        return;
      }

      // Cmd+,: Open Settings & Appearance
      if (isCmdOrCtrl && e.key === ",") {
        e.preventDefault();
        setIsSettingsModalOpen(true);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeTabPath,
    saveFile,
    isCenterChatOpen,
    setIsSettingsModalOpen,
    screen,
    openScreen,
    revealEditorForFile,
  ]);

  // Escape closes the full-canvas chat, or leaves a page for the editor. It goes
  // through `openScreen` like every other way home, so the dock that stepped
  // aside comes back with it. The nav stops its own Escape from reaching here
  // (see WorkbenchNav).
  useEffect(() => {
    if (!isCenterChatOpen && screen === "editor") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isCenterChatOpen) setIsCenterChatOpen(false);
      else openScreen("editor");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCenterChatOpen, screen, openScreen]);

  // ── Commands Dictionary for Command Palette ───────────────────────────────
  const commands: CommandItem[] = [
    {
      id: "view.toggleNav",
      title: "View: Toggle the Navigation Panel",
      category: "View",
      shortcut: "⌘B",
      icon: PanelLeft,
      action: () => setNavPinned((prev) => !prev),
    },
    {
      id: "view.toggleBottomPanel",
      title: "Toggle Bottom Panel (Terminal / Output)",
      category: "View",
      shortcut: "⌘J",
      icon: PanelBottom,
      action: () => setIsBottomPanelOpen((prev) => !prev),
    },
    {
      id: "view.toggleRightSideBar",
      title: "Toggle Secondary Side Bar (Right Tool Window)",
      category: "View",
      icon: PanelRight,
      action: () => setIsRightPanelOpen((prev) => !prev),
    },
    {
      id: "ai.toggleChat",
      title: "AI Assistant: Toggle Chat Panel (Open/Close)",
      category: "AI",
      shortcut: "⌘L",
      icon: MessageSquare,
      action: () => {
        setScreen("editor");
        setIsRightPanelOpen((prev) => !prev);
      },
    },
    {
      id: "preferences.settings",
      title: "Preferences: Open Settings",
      category: "Preferences",
      shortcut: "⌘,",
      icon: Settings,
      action: openSettings,
    },
    {
      id: "preferences.theme",
      title: "Preferences: Color Theme (Theme Editor)",
      category: "Preferences",
      shortcut: "⌘K ⌘T",
      icon: Palette,
      action: openThemeEditor,
    },
    {
      id: "file.save",
      title: "Save Document",
      category: "File",
      shortcut: "⌘S",
      icon: Save,
      action: () => {
        if (activeTabPath) saveFile(activeTabPath);
      },
    },
    {
      id: "file.openFolder",
      title: "Open Folder...",
      category: "File",
      icon: Folder,
      action: handleOpenFolder,
    },
    {
      id: "file.newProject",
      title: "New Project Scaffold...",
      category: "File",
      icon: FolderPlus,
      action: () => setIsProjectModalOpen(true),
    },
    {
      id: "theme.githubDark",
      title: "Color Theme: GitHub Dark Default",
      category: "Preferences",
      icon: Palette,
      action: () => setThemeId("github-dark"),
    },
    {
      id: "agent.run",
      title: "Agent: Execute & Verify Task",
      category: "Agent",
      icon: Bot,
      // "Whatever is in the composer": the chat owns that text now, so it is read
      // from its store rather than plumbed through the pipeline as state.
      action: () => runPipeline(chatDraft.get()),
    },
    {
      id: "view.explorer",
      title: "View: Show the Editor",
      category: "View",
      shortcut: "⇧⌘E",
      icon: Folder,
      action: revealEditorForFile,
    },
    {
      id: "view.repository",
      title: "Source Control: Open the Repository Page",
      category: "Source Control",
      shortcut: "⇧⌘G",
      icon: GitPullRequest,
      action: () => openScreen("git"),
    },
    {
      id: "view.marketplace",
      title: "Marketplace: Skills, Tools & MCP Servers",
      category: "View",
      shortcut: "⇧⌘X",
      icon: Package,
      action: () => openScreen("marketplace"),
    },
    {
      id: "git.clone",
      title: "Git: Clone Repository...",
      category: "Git",
      icon: GitFork,
      action: () => setIsCloneModalOpen(true),
    },
    {
      id: "view.openMonitor",
      title: "Host Health: Open Performance & Maintenance Dashboard",
      category: "View",
      icon: Activity,
      action: () => openScreen("monitor"),
    },
    {
      id: "view.openAiManager",
      title: "AI: Open Model Management & Providers Dashboard",
      category: "AI",
      icon: Cpu,
      action: () => openScreen("aiManager"),
    },
    {
      id: "view.openCodeMap",
      title: "Code Map: Search Symbols & Inspect Dependency Hubs",
      category: "View",
      icon: Network,
      action: () => openScreen("codeMap"),
    },
    {
      id: "ai.setupOllama",
      title: "AI: Setup Local AI Engine (Ollama Setup Wizard)",
      category: "AI",
      icon: Cpu,
      action: openOllamaSetupWizard,
    },
    {
      id: "ai.pullModel",
      title: "AI: Pull / Download Local AI Model...",
      category: "AI",
      icon: Download,
      action: openAiManagerTab,
    },
    {
      id: "view.openAiChat",
      title: "AI: Open AI Assistant Chat",
      category: "AI",
      icon: MessageSquare,
      action: openAiChatTab,
    },
    {
      id: "view.extensions",
      title: "Show Marketplace: Skills, Tools & MCP Servers",
      category: "View",
      icon: Package,
      action: openMarketplaceTab,
    },
  ];

  // ── Full-Canvas Chat Props ────────────────────────────────────────────────
  // Rendered as an overlay above the editor grid (see the center-stage render
  // below), so it is a normal React child and always receives fresh props.
  /**
   * The agent is stopped waiting on an answer, and the chat panel is not on
   * screen to show it. The status bar says *that* something is waiting; this is
   * what says where to answer.
   */
  const agentNeedsYou = Boolean(waitingForUser) && !isRightPanelOpen && !isCenterChatOpen;

  const centerChatProps = {
    status,
    activityLog,
    projectRoot: activeProject.path,
    branch: gitBranch,
    onRunPipeline: (
      request: string,
      override?: { provider: string; model: string; apiKey?: string; baseUrl?: string },
      activePath?: string,
      code?: string,
      history?: Array<{ role: string; content: string }>,
      images?: string[]
    ) => {
      if (override) {
        setAiSettings({
          ...aiSettings,
          provider: override.provider as any,
          model: override.model,
          apiKey: override.apiKey !== undefined ? override.apiKey : aiSettings.apiKey,
          baseUrl: override.baseUrl !== undefined ? override.baseUrl : aiSettings.baseUrl,
        });
      }
      runPipeline(
        request,
        override,
        activePath || activeTabPath || undefined,
        code || selectedCode || undefined,
        history,
        images
      );
    },
    onCancelPipeline: cancelPipeline,
    onSteerPipeline: steerPipeline,
    onUndoLastTurn: undoLastTurn,
    isWide: true,
    activeAiSettings: aiSettings,
    selectedContext: activeTabPath ? { path: activeTabPath, code: selectedCode } : null,
    indexStatus,
    isIndexing,
    onSyncIndex: syncIndex,
    streamingAnswer,
    streamingThought,
    agentSteps,
    failureDetail,
    pendingApproval,
    respondToApproval,
    turnElapsedMs,
    turnLimitMinutes,
    onClose: () => setIsCenterChatOpen(false),
    onPopOutWide: () => {
      // Leave full canvas and dock the assistant back to the side tool window.
      setIsCenterChatOpen(false);
      setIsRightPanelOpen(true);
    },
  };

  // The empty-state panel flickered on every keystroke in the chat composer.
  // Cause: `watermarkComponent` was an inline arrow, and dockview treats it as a
  // component *type* — so each render produced a new type, React unmounted the
  // old one and mounted a new one, and the panel rebuilt itself. The prompt text
  // lives above this component (it is a prop of the assistant, which lives in
  // this layout), so every character typed re-rendered the whole workbench.
  //
  // These handlers are setState calls and nothing else, so their identities are
  // stable for the life of the layout; the memo then only changes when the setup
  // card's own data does, which is when the panel should change.
  const openFilePalette = useCallback(() => {
    setPaletteMode("file");
    setIsCommandPaletteOpen(true);
  }, []);
  const openCommandPalette = useCallback(() => {
    setPaletteMode("command");
    setIsCommandPaletteOpen(true);
  }, []);
  const toggleAiFromWatermark = useCallback(() => {
    setIsCenterChatOpen(false);
    setIsRightPanelOpen((prev) => !prev);
  }, []);

  /** The nav row for the screen being shown, for the page header. */
  const activeNavItem = NAV_ITEMS.find((item) => item.id === screen);

  // The live state that dockview panel components read.
  //
  // Dockview keeps the component function it was given when a panel is created,
  // so a panel can only ever see current workbench state through context — see
  // WorkbenchContext.tsx. Memoised on its contents so an unrelated re-render
  // (typing in the chat composer, say) does not re-render every open panel.
  const live: WorkbenchLive = useMemo(
    () => ({
      openTabs,
      updateTabContent,
      saveFile,
      aiSettings,
      themeId,
      targetEditorLine,
      onSelectionChange: setSelectedCode,
      projectRoot: activeProject.path,
      isTauriAvailable,
      currentDiff,
      setCurrentDiff,
      applyPatchToTab,
      refreshProjectFiles,
      refreshBranch,
    }),
    [
      openTabs,
      updateTabContent,
      saveFile,
      aiSettings,
      themeId,
      targetEditorLine,
      setSelectedCode,
      activeProject.path,
      isTauriAvailable,
      currentDiff,
      setCurrentDiff,
      applyPatchToTab,
      refreshProjectFiles,
      refreshBranch,
    ]
  );

  // `components` used to be rebuilt here on every render, with an inline arrow
  // per panel type. Dockview treats each new arrow as a new component *type*, so
  // every render re-registered the factory — which re-runs updateOptions and a
  // full layout pass on each keystroke. WORKBENCH_PANELS is a module constant.

  // ── Initialize Default Dockview Layout ────────────────────────────────────
  const onReady = useCallback((event: DockviewReadyEvent) => {
    dockviewApiRef.current = event.api;

    // Add initial editor panel if tabs exist
    if (openTabs.length > 0) {
      const first = openTabs[0];
      event.api.addPanel({
        id: first.path,
        component: first.path.match(/\.(png|jpg|jpeg|svg|gif|webp|ico)$/i) ? "assetPreview" : "editor",
        title: first.name,
        params: { filePath: first.path, isTauri: isTauriAvailable, projectRoot: activeProject.path },
      });
    }

    // Listen to panel active and close events
    event.api.onDidActivePanelChange((e) => {
      const panelId = (e as any)?.panel?.id || (e as any)?.id;
      if (panelId && !SPECIAL_PANELS.some((p) => panelId.startsWith(p))) {
        selectTab(panelId);
      }
    });

    event.api.onDidRemovePanel((panel) => {
      if (panel && panel.id && !SPECIAL_PANELS.some((p) => panel.id.startsWith(p))) {
        closeTab(panel.id);
      }
    });
  }, [
    openTabs,
    selectTab,
    closeTab,
    activeProject.path,
    isTauriAvailable,
  ]);

  /**
   * The tabs as of the last committed render.
   *
   * The sync effect below is keyed off the *set* of tabs rather than off
   * `openTabs` itself. A keystroke rewrites the active tab's content, so
   * `openTabs` is a brand-new array on every keystroke — and rewriting a tab's
   * content is not a reason to touch the panels at all.
   *
   * Keying it off the array was not merely wasteful. The sweep ends by calling
   * `setActive()` on the active panel, and dockview's activation path detaches
   * and re-attaches that panel's DOM node. Detaching the node blurs whatever is
   * focused inside it, so the editor lost focus after every keystroke and the
   * rest of the burst went to the document body: typing in a file worked exactly
   * one character per click.
   */
  const openTabsRef = useRef(openTabs);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  /** Identity of the open *set*: what this effect actually cares about. */
  const openTabSetKey = useMemo(
    () => openTabs.map((t) => `${t.path}\u0000${t.name}`).join("\u0001"),
    [openTabs]
  );

  // Synchronize open tabs with Dockview panels
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api) return;
    const tabs = openTabsRef.current;

    // Close any editor panel whose tab is no longer in openTabs
    const editorPanels = api.panels.filter((p) => ["editor", "assetPreview", "diff"].includes((p as any).component));
    for (const panel of editorPanels) {
      if (!tabs.some((t) => t.path === panel.id)) {
        panel.api.close();
      }
    }

    // Add panels for newly opened tabs
    for (const tab of tabs) {
      const existing = api.getPanel(tab.path);
      if (!existing) {
        api.addPanel({
          id: tab.path,
          component: tab.path.match(/\.(png|jpg|jpeg|svg|gif|webp|ico)$/i) ? "assetPreview" : "editor",
          title: tab.name,
          params: { filePath: tab.path, isTauri: isTauriAvailable, projectRoot: activeProject.path },
        });
      }
    }

    // Only when the wanted panel is not already the active one: activating a
    // panel that is already active is what blurred the editor.
    if (activeTabPath) {
      const panel = api.getPanel(activeTabPath);
      if (panel && !panel.api.isActive) {
        panel.api.setActive();
      }
    }
  }, [openTabSetKey, activeTabPath, activeProject.path, isTauriAvailable]);

  // Isolate project state: close all previous project tabs & diffs when switching project
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api) return;

    for (const panel of api.panels) {
      if (
        panel.id.startsWith("diff_") ||
        panel.id === "dock_diff" ||
        ["editor", "assetPreview"].includes((panel as any).component) ||
        (panel as any).component === "diff"
      ) {
        panel.api.close();
      }
    }
    setCurrentDiff("");
  }, [activeProject.path, setCurrentDiff]);

  // The change card's "Review". The two sides come from the engine — HEAD versus
  // the working tree — so the existing viewer shows a real side-by-side instead
  // of the file's content against an empty left pane.
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api || !reviewDiff) return;

    const panelId = "dock_review";
    const existing = api.getPanel(panelId);
    if (existing) api.removePanel(existing);
    api.addPanel({
      id: panelId,
      component: "diff",
      title: reviewDiff.filePath.split(/[\\/]/).pop() || "Diff",
      params: {
        filePath: reviewDiff.filePath,
        originalContent: reviewDiff.originalContent,
        modifiedContent: reviewDiff.modifiedContent,
        isGit: true,
      },
    });
    clearReviewDiff();
  }, [reviewDiff, clearReviewDiff]);

  // Open Diff tab when agent generates a diff
  useEffect(() => {
    const api = dockviewApiRef.current;
    if (!api || !currentDiff) return;

    const diffPanel = api.getPanel("dock_diff");
    if (!diffPanel) {
      api.addPanel({
        id: "dock_diff",
        component: "diff",
        title: "Micro-Diff Inspector",
      });
    } else {
      diffPanel.api.setActive();
    }
  }, [currentDiff]);

  // Publish tab dirtiness + the guarded close handler to the dockview headers.
  const dirtyTabPaths = useMemo(
    () => new Set(openTabs.filter((t) => t.isDirty).map((t) => t.path)),
    [openTabs]
  );
  const [pendingTabClose, setPendingTabClose] = useState<{ title: string } | null>(null);
  const pendingTabCloseFnRef = useRef<null | (() => void)>(null);
  const requestCloseTab = useCallback((close: () => void, title: string, isDirty: boolean) => {
    if (!isDirty) {
      close();
      return;
    }
    pendingTabCloseFnRef.current = close;
    setPendingTabClose({ title });
  }, []);
  const tabChrome = useMemo(
    () => ({ dirty: dirtyTabPaths, requestClose: requestCloseTab }),
    [dirtyTabPaths, requestCloseTab]
  );

  // ── Project readiness (fresh scaffold → dependencies not installed) ───────
  const [projectStatus, setProjectStatus] = useState<ProjectStatus | null>(null);
  const [setupBusyCommand, setSetupBusyCommand] = useState<string | null>(null);

  const refreshProjectStatus = useCallback(async () => {
    const status = await fetchProjectStatus(activeProject.path);
    setProjectStatus(status);
    return status;
  }, [activeProject.path]);

  useEffect(() => {
    void refreshProjectStatus();
  }, [refreshProjectStatus]);

  const runSetupCommand = useCallback(
    async (_label: string, command: string) => {
      setSetupBusyCommand(command);
      setIsBottomPanelOpen(true);
      await runInProjectTerminal(activeProject.path, command);
      // Installing/building is long-running, so poll until the project stops
      // needing setup (or give up) and let the card re-render on its own.
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const status = await refreshProjectStatus();
        if (!status || !status.needsInstall) break;
      }
      setSetupBusyCommand(null);
    },
    [activeProject.path, refreshProjectStatus]
  );

  // Stable identity, so the empty-state panel is not rebuilt on every render.
  // `watermarkComponent` was an inline arrow, and dockview treats it as a
  // component *type*: a new identity per render meant React unmounted the old
  // one and mounted a new one. The prompt text lives above this layout, so every
  // keystroke in the chat composer re-rendered the workbench and the panel
  // flickered. The handlers below are setState calls, so their identities do not
  // change; this memo only changes when the empty state's own data does.
  const watermarkComponent = useMemo(
    () => () => (
      <DockviewWatermark
        onOpenFile={openFilePalette}
        onOpenCommands={openCommandPalette}
        onToggleAi={toggleAiFromWatermark}
        setup={{ status: projectStatus, busyCommand: setupBusyCommand, onRun: runSetupCommand }}
      />
    ),
    [
      openFilePalette,
      openCommandPalette,
      toggleAiFromWatermark,
      projectStatus,
      setupBusyCommand,
      runSetupCommand,
    ],
  );

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--vscode-sidebar-bg)] text-[var(--vscode-editor-fg)] select-none">
      {/* The sidebar owns the window's left edge and its whole height — the
          brand lives in it, so there is no bar above it. */}
      <div className="flex flex-1 min-h-0">
        <WorkbenchNav
          screen={screen}
          onSelectScreen={openScreen}
          pinned={navPinned}
          onPinnedChange={setNavPinned}
          onOpenSettings={openSettings}
        />

        {/* Everything else: the titlebar, then the canvas. */}
        <div className="flex flex-1 min-w-0 flex-col min-h-0">
        {/* ── Top IDE Titlebar (Clean, Uncluttered, JetBrains / VS Code Modern UI) ── */}
        <header className="flex items-center justify-between px-3 h-10 border-b border-[var(--vscode-border)] bg-[var(--vscode-titlebar-bg)] shrink-0 text-xs font-sans">
          {/* Left: Project Selector */}
          <div className="flex items-center gap-2.5">
            {/* Modern IDE Project Switcher Pill & Dropdown */}
            <ProjectSwitcher
              activeProject={activeProject}
              onOpenFolder={handleOpenFolder}
              onNewProject={() => setIsProjectModalOpen(true)}
              onCloneRepo={() => setIsCloneModalOpen(true)}
              onSelectRecentProject={openFolder}
            />

            {/* Real Git Version Control Dropdown */}
            <VersionControlDropdown
              projectCwd={activeProject.path}
              onBranchChanged={() => {
                refreshBranch();
                refreshProjectFiles();
              }}
            />
          </div>

          {/* Center: Command Palette / Omnibar Trigger */}
          <button
            type="button"
            aria-label="Search files or run a command"
            onClick={() => setIsCommandPaletteOpen(true)}
            className="flex-1 max-w-xl mx-4 h-7 bg-zinc-900/80 hover:bg-zinc-900 border border-zinc-800/80 hover:border-zinc-700/80 rounded-lg px-2.5 flex items-center justify-between cursor-pointer transition-colors shadow-sm group"
          >
            <div className="flex items-center gap-2 text-xs text-zinc-400 group-hover:text-zinc-300">
              <Icon icon={Search} className="w-3.5 h-3.5" />
              <span className="truncate">
                {activeProject ? `${activeProject.name} — Search files (Cmd+P)` : "Search files (Cmd+P)"}
              </span>
            </div>
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-3xs font-mono text-zinc-400 bg-zinc-800/70 border border-zinc-700/50 rounded">
              ⌘P
            </kbd>
          </button>

          {/* Right: Layout Toggles, AI Chat Button & Settings */}
          <div className="flex items-center gap-2">
            {/* The terminal belongs to the editor screen, so its toggle only
                appears there. On a page, the nav and Escape are the way back.
                The file tree has no toggle: it is part of that screen. */}
            {screen === "editor" && (
              <>
                <button
                  type="button"
                  onClick={() => setIsBottomPanelOpen((prev) => !prev)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    isBottomPanelOpen
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
                  }`}
                  title="Toggle Bottom Panel (Cmd+J / Ctrl+`)"
                >
                  <Icon icon={PanelBottom} className="w-3.5 h-3.5" />
                </button>
              </>
            )}

            {/* AI Chat Button: toggles the docked assistant, or leaves full-canvas chat */}
            <button
              type="button"
              onClick={() => {
                if (isCenterChatOpen) {
                  setIsCenterChatOpen(false);
                  setIsRightPanelOpen(true);
                } else {
                  setIsRightPanelOpen((prev) => !prev);
                }
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                // A blocked turn outranks the open/closed styling: this is the one
                // control that says *where* to answer, and the status bar only says
                // *that* something is waiting.
                agentNeedsYou
                  ? "bg-amber-950/50 text-amber-200 border border-amber-500/70 shadow-sm"
                  : isRightPanelOpen || isCenterChatOpen
                  ? "bg-zinc-800 text-zinc-100 border border-zinc-700/60 shadow-sm"
                  : "text-zinc-300 hover:text-white hover:bg-zinc-800/80 border border-transparent"
              }`}
              title={
                agentNeedsYou
                  ? `${blockedLabel(waitingForUser)} — open Chat (Cmd+L)`
                  : "Toggle AI Chat Panel (Cmd+L)"
              }
              aria-label={agentNeedsYou ? `${blockedLabel(waitingForUser)} — open Chat` : undefined}
            >
              <Icon
                icon={MessageSquare}
                className={`w-3.5 h-3.5 ${agentNeedsYou ? "text-amber-300" : "text-zinc-300"}`}
              />
              <span>Chat</span>
              {/* Static, not animated: the colour change already says "look here",
                  and motion that a reduced-motion preference cannot switch off is
                  a worse trade than a dot that does not move. */}
              {agentNeedsYou && (
                <span data-testid="chat-needs-you" className="h-2 w-2 rounded-full bg-amber-400" />
              )}
            </button>

            {/* Appears only when there is a newer release, and installs only on a
                click. See services/appUpdater.ts for the policy. */}
            <UpdateButton />
          </div>
        </header>

      {/* ── The canvas: the editor screen, or a page, with the chat dock ──── */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
          {screen === "editor" ? (
            <div className="flex flex-1 min-h-0">
              {/* File tree, paired with the editor rather than parked beside the
                  whole workbench. It is part of this screen, not a panel that can
                  be dismissed, so it is not conditional. */}
              <aside
                  style={{ width: `${explorerWidth}px` }}
                  className="relative max-w-[42%] h-full shrink-0 border-r border-[var(--vscode-border)] bg-[var(--vscode-sidebar-bg)] flex flex-col overflow-hidden"
                >
                  <ExplorerSidebar
                    projectName={activeProject.name}
                    projectPath={activeProject.path}
                    files={projectFiles}
                    activeFilePath={activeTabPath}
                    onSelectFile={openFileInEditor}
                    onCreateFile={createFileOrFolder}
                    onDeleteFile={deleteFile}
                    onRefresh={refreshProjectFiles}
                    onOpenFolder={handleOpenFolder}
                    touchedPaths={touchedPaths}
                  />
                  {/* Pointer-only, like the nav rail: there is no keyboard
                      equivalent, and the pane is usable at its default width. */}
                  <div
                    role="presentation"
                    onMouseDown={startResizingExplorer}
                    className={`absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-zinc-600/40 transition-colors z-dock select-none ${
                      isResizingExplorer ? "bg-zinc-500" : ""
                    }`}
                    title="Drag to resize the file tree"
                  />
              </aside>

              {/* Dockview Editors & Diff Surface, with the terminal beneath */}
              <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-[var(--vscode-editor-bg)]">
                <div className="flex-1 w-full overflow-hidden relative">
            <TabChromeContext.Provider value={tabChrome}>
            {/* Panels read current state through this: dockview froze the
                component it was handed at panel creation, so a closure would
                never see a file change. See WorkbenchContext.tsx. */}
            <WorkbenchProvider value={live}>
            <DockviewReact
              components={WORKBENCH_PANELS}
              defaultTabComponent={DockviewCustomTab}
              watermarkComponent={watermarkComponent}
              onReady={onReady}
              className="dockview-theme-dark h-full w-full"
            />
            </WorkbenchProvider>
            </TabChromeContext.Provider>

                  {/* Full-Canvas AI Assistant — a true overlay with no dockview
                      tab chrome. Only one assistant surface is ever mounted:
                      opening this closes the side dock and vice versa. */}
            {isCenterChatOpen && (
              <div className="absolute inset-0 z-overlay bg-[#141416]">
                <AiAssistantChat {...centerChatProps} />
              </div>
            )}
                </div>

                {/* Dedicated Bottom Panel (Terminal / Output / Problems). The
                    terminal belongs to the editor screen; a page takes the whole
                    canvas, and `openScreen` puts this back on the way home. */}
                <Suspense fallback={null}>
                  <BottomPanel
                    isOpen={isBottomPanelOpen}
                    onClose={() => setIsBottomPanelOpen(false)}
                    activeProjectCwd={activeProject.path}
                    activityLog={activityLog}
                    onClearLog={clearLog}
                    status={status}
                    terminalFontSize={aiSettings?.terminalFontSize ?? 13}
                  />
                </Suspense>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 min-h-0 flex-col">
              {/* A page header, so a full-width surface still says where it is
                  and how to leave. Escape does the same. */}
              <div className="flex items-center justify-between px-3.5 py-2 border-b border-[var(--vscode-border)] bg-[#18181b] shrink-0">
                <div className="flex items-center gap-2">
                  {activeNavItem && (
                    <Icon icon={activeNavItem.icon} className="w-4 h-4 text-zinc-300" />
                  )}
                  <span className="text-body font-semibold text-zinc-100 tracking-tight">
                    {activeNavItem?.label ?? "Page"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => openScreen("editor")}
                  title="Back to the editor (Esc)"
                  aria-label="Back to the editor"
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  <Icon icon={X} className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <Suspense fallback={<SurfaceFallback label={activeNavItem?.label ?? "the page"} />}>
                  {screen === "git" && (
                    <GitDashboard
                      projectCwd={activeProject.path}
                      workspaceRevision={workspaceRevision}
                      onWorkspaceChanged={() => {
                        refreshBranch();
                        refreshProjectFiles();
                      }}
                    />
                  )}
                  {screen === "monitor" && (
                    <PerformanceDashboard
                      projectRoot={activeProject.path}
                      onRefreshMetrics={() => {
                        refreshBranch();
                        systemMetricsService.fetchMetrics();
                      }}
                    />
                  )}
                  {screen === "aiManager" && (
                    <AiManagementDashboard
                      onModelSettingsChanged={() => {
                        const def = getDefaultProvider();
                        setAiSettings({
                          ...aiSettings,
                          provider: def.id as any,
                          model: def.selectedModel,
                          apiKey: def.apiKey,
                          baseUrl: def.baseUrl,
                        });
                      }}
                    />
                  )}
                  {screen === "marketplace" && (
                    // A centred column rather than the full width: this was a
                    // sidebar, and stretched across a wide monitor its rows read
                    // as a spreadsheet.
                    <div className="h-full w-full max-w-[clamp(40rem,86vw,90rem)] mx-auto">
                      <MarketplaceSidebar projectRoot={activeProject.path} />
                    </div>
                  )}
                  {screen === "codeMap" && (
                    <CodeMapDashboard
                      projectRoot={activeProject.path}
                      projectName={activeProject.name}
                      aiSettings={aiSettings}
                      onOpenFile={(path, line) => handleOpenFileAtLocation(path, line)}
                    />
                  )}
                </Suspense>
              </div>
            </div>
          )}
        </div>

        {/* ── Right Secondary Tool Window (IntelliJ-Style AI Assistant Dock) ── */}
        {isRightPanelOpen && (
          <aside className="w-[clamp(300px,30vw,520px)] max-w-[48%] border-l border-[var(--vscode-border)] bg-workbench flex flex-col h-full shrink-0 overflow-hidden z-raised shadow-2xl">
            <AiAssistantChat
              status={status}
              activityLog={activityLog}
              projectRoot={activeProject.path}
              branch={gitBranch}
              onRunPipeline={(request, override, activePath, code, history, images) => {
                if (override) {
                  setAiSettings({
                    ...aiSettings,
                    provider: override.provider as any,
                    model: override.model,
                    apiKey: override.apiKey !== undefined ? override.apiKey : aiSettings.apiKey,
                    baseUrl: override.baseUrl !== undefined ? override.baseUrl : aiSettings.baseUrl,
                  });
                }
                runPipeline(request, override, activePath || activeTabPath || undefined, code || selectedCode || undefined, history, images);
              }}
              onCancelPipeline={cancelPipeline}
              onSteerPipeline={steerPipeline}
              onUndoLastTurn={undoLastTurn}
              onClose={() => setIsRightPanelOpen(false)}
              onPopOutWide={openAiChatTab}
              isWide={false}
              activeAiSettings={aiSettings}
              selectedContext={activeTabPath ? { path: activeTabPath, code: selectedCode } : null}
              indexStatus={indexStatus}
              isIndexing={isIndexing}
              onSyncIndex={syncIndex}
              streamingAnswer={streamingAnswer}
              streamingThought={streamingThought}
              agentSteps={agentSteps}
              failureDetail={failureDetail}
              noFileChanges={noFileChanges}
              waitingForUser={waitingForUser}
              pendingApproval={pendingApproval}
              respondToApproval={respondToApproval}
              turnElapsedMs={turnElapsedMs}
              turnLimitMinutes={turnLimitMinutes}
              pendingQuestion={pendingQuestion}
              respondToQuestion={respondToQuestion}
              turnChanges={turnChanges}
              onReviewFile={openDiff}
            />
          </aside>
        )}
          </div>
        </div>
      </div>

      <StatusBar
        gitBranch={gitBranch}
        indexStatus={indexStatus}
        isIndexing={isIndexing}
        onSyncIndex={syncIndex}
        agentBlockedOn={waitingForUser}
      />

      {/* ── Modals ────────────────────────────────────────────────────────── */}
      <CloneModal
        isOpen={isCloneModalOpen}
        onClose={() => setIsCloneModalOpen(false)}
        onPickFolder={pickFolder}
        onCloneSuccess={async (clonedPath) => {
          setIsCloneModalOpen(false);
          await openFolder(clonedPath);
          refreshBranch();
        }}
      />

      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        onCreateProject={createProject}
        onPickFolder={pickFolder}
      />

      <ErrorBoundary
        fallbackTitle="Preferences & Settings Panel"
        onReset={() => setIsSettingsModalOpen(false)}
      >
        {isSettingsModalOpen && (
          <SettingsModal
            isOpen={isSettingsModalOpen}
            onClose={() => setIsSettingsModalOpen(false)}
            settings={aiSettings}
            onSave={setAiSettings}
            themeId={themeId}
            onApplyTheme={setThemeId}
            accentId={accentId}
            onApplyAccent={setAccentId}
            initialTab={settingsModalTab}
            projectName={activeProject?.name || "Practice"}
            onOpenMarketplace={openMarketplaceTab}
          />
        )}
      </ErrorBoundary>

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        commands={commands}
        files={projectFiles}
        onOpenFile={openFileInEditor}
        initialMode={paletteMode}
      />

      {/* Closing a tab with unsaved edits asks first — a styled modal rather
          than window.confirm so it never blocks the renderer. */}
      <ConfirmDialog
        isOpen={pendingTabClose !== null}
        title="Close unsaved file?"
        message={
          <>
            <span className="font-medium text-zinc-300">{pendingTabClose?.title}</span> has changes that
            aren't saved to disk. Closing it will discard those changes.
          </>
        }
        confirmText="Discard & close"
        cancelText="Keep editing"
        onConfirm={() => {
          const fn = pendingTabCloseFnRef.current;
          pendingTabCloseFnRef.current = null;
          setPendingTabClose(null);
          fn?.();
        }}
        onCancel={() => {
          pendingTabCloseFnRef.current = null;
          setPendingTabClose(null);
        }}
      />
    </div>
  );
}

export default IdeLayout;
