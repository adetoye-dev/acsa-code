/**
 * SettingsModal.tsx — Authentic IntelliJ IDEA Settings & Preferences Window
 *
 * Implements the IntelliJ IDE settings panel architecture:
 * - Frosted glass window header with project title and settings icon
 * - Two-column layout with searchable hierarchical category tree
 * - Tools > AI Assistant > Agents (Claude, Codex, Copilot, Junie, Agoragentic, Amp, Auggie CLI)
 * - Tools > AI Assistant > Providers & API keys (with real connection ping testing)
 * - Tools > AI Assistant > Model Context Protocol (MCP) servers
 * - Editor > Font (JetBrains Mono default, size, line spacing, ligatures, live preview)
 * - Editor > Code Style (tab size, spaces, format on save)
 * - Appearance & Behavior > Appearance (theme picker with live preview swatches)
 * - Tools > Terminal & Version Control > Git
 * - Standard IntelliJ footer with [?] Help, [Cancel], [Apply], [OK]
 */

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Settings, X, ChevronDown, RefreshCw, AlertCircle, Search, ChevronRight, EyeOff, ArrowRight, Check, Pin, CheckCircle2, HelpCircle, ArrowLeft, Eye } from "lucide-react";
import { PRESET_ACCENTS, PRESET_THEMES } from "../services/themeManager";
import { ProviderLogo } from "./ui/BrandLogos";
import { AboutPane } from "./settings/AboutPane";
import { DataPane } from "./settings/DataPane";
import { useDialogA11y } from "../hooks/useDialogA11y";
import { aiFetch } from "../services/aiClient";
import {
  AGENT_APPROVAL_MODES,
  AGENT_TRANSPORTS,
  DEFAULT_AGENT_APPROVAL_MODE,
  DEFAULT_AGENT_TRANSPORT,
  isAgentApprovalMode,
  isAgentTransport,
  type AgentApprovalMode,
  type AgentTransport,
} from "../services/agentApproval";
import { DEFAULT_TURN_LIMIT_MINUTES, TURN_LIMIT_CHOICES } from "../services/agentTurnLimit";

export interface AISettings {
  /**
   * Provider id. This used to be a stale union of four ids, which hid the fact
   * that cloud providers (deepseek, anthropic, …) were valid here — accepting
   * any provider id keeps the type honest.
   */
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  fontSize?: number;
  lineHeight?: number;
  enableLigatures?: boolean;
  tabSize?: number;
  insertSpaces?: boolean;
  wordWrap?: boolean;
  terminalFontSize?: number;
  /** How much the agent may do unattended. See AGENT_APPROVAL_MODES. */
  approvalMode?: AgentApprovalMode;
  /** Which agent runtime to drive. See AGENT_TRANSPORTS. */
  agentTransport?: AgentTransport;
  /**
   * Wall-clock ceiling on one agent turn, in minutes. Zero means no limit.
   * See `agentTurnLimit.ts` — this is what stops a turn that quietly triples its
   * own length, and it is not applied while the agent is waiting on the user.
   */
  turnLimitMinutes?: number;
}

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AISettings;
  onSave: (newSettings: AISettings) => void;
  themeId?: string;
  onApplyTheme?: (themeId: string) => void;
  accentId?: string;
  onApplyAccent?: (accentId: string) => void;
  initialTab?: string;
  projectName?: string;
  /** Open the real Marketplace panel (Skills, MCP servers, tooling). */
  onOpenMarketplace?: () => void;
}

interface TreeNode {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  hasExternalBadge?: boolean;
  children?: TreeNode[];
}

/**
 * Only sections that render real, wired controls.
 *
 * This used to mirror a JetBrains nav almost one-for-one, and most of those
 * entries opened an empty pane ("Keymap", "Languages & Frameworks", "Database",
 * "Diagrams", …) while "Agents", "Plugins" and "MCP" rendered hardcoded fake
 * lists — an installer whose buttons only toggled local state, and servers that
 * did not exist. A settings tree that lies is worse than a short one: anything
 * not listed here either has no implementation yet or lives in the Marketplace.
 */
const SETTINGS_TREE: TreeNode[] = [
  {
    id: "appearance-group",
    label: "Appearance & Behavior",
    children: [{ id: "appearance", label: "Appearance" }],
  },
  {
    id: "editor-group",
    label: "Editor",
    children: [
      { id: "editor-font", label: "Font" },
      { id: "editor-code-style", label: "Code Style" },
    ],
  },
  { id: "terminal", label: "Terminal" },
  {
    id: "ai-assistant-group",
    label: "AI Assistant",
    children: [
      { id: "agent", label: "Agent" },
      { id: "providers", label: "Providers & API keys" },
    ],
  },
  { id: "marketplace", label: "Marketplace" },
  { id: "data", label: "Data & backups" },
  { id: "about", label: "About" },
];

/** Every id the tree actually offers, so a caller cannot land on an empty pane. */
const SETTINGS_SECTION_IDS: ReadonlySet<string> = (() => {
  const ids = new Set<string>();
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      ids.add(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(SETTINGS_TREE);
  return ids;
})();

function resolveInitialSection(tab?: string): string {
  if (tab === "appearance") return "appearance";
  if (tab === "ai") return "providers";
  // An unknown id renders nothing at all, which reads as "the dialog is broken"
  // rather than "that page moved" — the caller said "agents", which never existed.
  if (tab && SETTINGS_SECTION_IDS.has(tab)) return tab;
  return "agent";
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  themeId = "github-dark",
  onApplyTheme,
  accentId = "violet",
  onApplyAccent,
  initialTab = "providers",
  projectName = "Practice",
  onOpenMarketplace,
}: SettingsModalProps) {
  // Safe settings fallback to avoid undefined access crashes
  const currentSettings = settings || {
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    apiKey: "",
    baseUrl: "http://127.0.0.1:11434",
  };

  // Navigation & Category Selection
  const [selectedSection, setSelectedSection] = useState<string>(() =>
    resolveInitialSection(initialTab)
  );
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({
    "appearance-group": true,
    "editor-group": true,
    "tools-group": true,
    "ai-assistant-group": true,
  });
  const [navSearch, setNavSearch] = useState("");
  const [history, setHistory] = useState<string[]>(() => [
    resolveInitialSection(initialTab),
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // AI Settings State
  const [provider, setProvider] = useState<AISettings["provider"]>(
    currentSettings.provider === "deterministic" ? "ollama" : (currentSettings.provider || "ollama")
  );
  const [model, setModel] = useState(currentSettings.model || "");
  const [apiKey, setApiKey] = useState(currentSettings.apiKey || "");
  const [baseUrl, setBaseUrl] = useState(currentSettings.baseUrl || "");
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  // Editor Settings State
  const [fontSize, setFontSize] = useState<number>(13);
  const [lineHeight, setLineHeight] = useState<number>(1.5);
  const [enableLigatures, setEnableLigatures] = useState(true);
  const [tabSize, setTabSize] = useState<number>(2);
  const [insertSpaces, setInsertSpaces] = useState(true);
  const [wordWrap, setWordWrap] = useState(false);

  // Terminal state
  const [terminalFontSize, setTerminalFontSize] = useState(13);

  // Agent state: which runtime, and how much it may do without asking.
  const [approvalMode, setApprovalMode] = useState<AgentApprovalMode>(DEFAULT_AGENT_APPROVAL_MODE);
  const [agentTransport, setAgentTransport] = useState<AgentTransport>(DEFAULT_AGENT_TRANSPORT);
  const [turnLimitMinutes, setTurnLimitMinutes] = useState<number>(DEFAULT_TURN_LIMIT_MINUTES);

  // Tree filter logic (unconditional hook)
  const filteredTree = useMemo(() => {
    if (!navSearch?.trim()) return SETTINGS_TREE;
    const query = navSearch.toLowerCase();

    const matchNode = (node: TreeNode): TreeNode | null => {
      const matchLabel = (node.label || "").toLowerCase().includes(query);
      if (node.children) {
        const filteredChildren = node.children
          .map(matchNode)
          .filter(Boolean) as TreeNode[];
        if (filteredChildren.length > 0) {
          return { ...node, children: filteredChildren };
        }
      }
      return matchLabel ? node : null;
    };

    return (SETTINGS_TREE || []).map(matchNode).filter(Boolean) as TreeNode[];
  }, [navSearch]);

  // Sync with initial props
  useEffect(() => {
    if (!isOpen) return;

    const target = resolveInitialSection(initialTab);
    setSelectedSection(target);
    setHistory([target]);
    setHistoryIndex(0);

    const safeSettings = settings || {
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      apiKey: "",
      baseUrl: "http://127.0.0.1:11434",
    };
    setProvider(safeSettings.provider === "deterministic" ? "ollama" : (safeSettings.provider || "ollama"));
    setModel(safeSettings.model || "");
    setApiKey(safeSettings.apiKey || "");
    setBaseUrl(safeSettings.baseUrl || "");
    setFontSize(safeSettings.fontSize ?? 13);
    setLineHeight(safeSettings.lineHeight ?? 1.5);
    setEnableLigatures(safeSettings.enableLigatures ?? true);
    setTabSize(safeSettings.tabSize ?? 2);
    setInsertSpaces(safeSettings.insertSpaces ?? true);
    setWordWrap(safeSettings.wordWrap ?? false);
    setTerminalFontSize(safeSettings.terminalFontSize ?? 13);
    setApprovalMode(
      isAgentApprovalMode(safeSettings.approvalMode)
        ? safeSettings.approvalMode
        : DEFAULT_AGENT_APPROVAL_MODE,
    );
    setAgentTransport(
      isAgentTransport(safeSettings.agentTransport)
        ? safeSettings.agentTransport
        : DEFAULT_AGENT_TRANSPORT,
    );
    setTurnLimitMinutes(
      typeof safeSettings.turnLimitMinutes === "number" && safeSettings.turnLimitMinutes >= 0
        ? safeSettings.turnLimitMinutes
        : DEFAULT_TURN_LIMIT_MINUTES,
    );
    setTestStatus("idle");
    setTestMessage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialTab]);

  /**
   * Escape closes the dialog, and focus starts inside it.
   *
   * Neither was true. The backdrop click was the only way out that did not
   * require aiming at a specific button, and a dialog that opens with focus
   * still on the page behind it is unusable from the keyboard even when every
   * control inside is reachable. (A comment claimed Escape was handled; it was
   * not.)
   */
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Escape, focus-in and — what this was missing — the Tab trap, which is shared
  // with every other dialog rather than re-derived here.
  useDialogA11y(dialogRef, () => onClose?.(), isOpen);

  const navigateTo = (sectionId: string) => {
    setSelectedSection(sectionId);
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(sectionId);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setSelectedSection(history[historyIndex - 1]);
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setSelectedSection(history[historyIndex + 1]);
    }
  };

  const toggleNode = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  };

  const handleTestConnection = async () => {
    setTestStatus("testing");
    setTestMessage("");

    try {
      // Proxied through the bridge so the request is made with the stored
      // credential and the key never has to be held in the browser.
      const res = await aiFetch("/api/ai/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          baseUrl: baseUrl || undefined,
          apiKey: apiKey || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success !== false) {
        const count = Array.isArray(data?.models) ? data.models.length : 0;
        setTestStatus("success");
        setTestMessage(
          count > 0
            ? `Connection verified — ${count} model${count === 1 ? "" : "s"} available.`
            : "Connection verified!"
        );
      } else {
        setTestStatus("error");
        setTestMessage(data?.error || `Request failed (HTTP ${res.status})`);
      }
    } catch (err: any) {
      setTestStatus("error");
      setTestMessage(`Connection failed: ${err.message || String(err)}`);
    }
  };

  const handleApply = () => {
    if (onSave) {
      onSave({
        provider: provider || "ollama",
        model: model || "",
        apiKey: apiKey || "",
        baseUrl: baseUrl || "",
        fontSize,
        lineHeight,
        enableLigatures,
        tabSize,
        insertSpaces,
        wordWrap,
        terminalFontSize,
        approvalMode,
        agentTransport,
        turnLimitMinutes,
      });
    }
  };

  const handleOk = () => {
    if (onSave) {
      onSave({
        provider: provider || "ollama",
        model: model || "",
        apiKey: apiKey || "",
        baseUrl: baseUrl || "",
        fontSize,
        lineHeight,
        enableLigatures,
        tabSize,
        insertSpaces,
        wordWrap,
        terminalFontSize,
        approvalMode,
        agentTransport,
        turnLimitMinutes,
      });
    }
    if (onClose) {
      onClose();
    }
  };

  // Breadcrumb path computation
  /**
   * Derive the breadcrumb from the tree so it cannot drift from the nav (it used
   * to be a parallel switch that still named sections which no longer existed).
   */
  const getBreadcrumb = (): string[] => {
    const walk = (nodes: TreeNode[], trail: string[]): string[] | null => {
      for (const node of nodes) {
        if (node.id === selectedSection) return [...trail, node.label];
        if (node.children) {
          const found = walk(node.children, [...trail, node.label]);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(SETTINGS_TREE, []) ?? ["Settings"];
  };

  const breadcrumb = getBreadcrumb() || ["Settings", "General"];

  if (!isOpen) return null;

  return (
    <div
      // Click-outside-to-close is a mouse convenience; Escape is the keyboard
      // route. Marked presentational so it is not announced as one huge
      // interactive region.
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/70 backdrop-blur-md p-4 select-none animate-in fade-in duration-150 font-sans cursor-default"
    >
      {/* Outer Window Frame with Apple Obsidian Glass & Specular Hairlines */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-[960px] h-[640px] max-w-[96vw] max-h-[92vh] rounded-modal bg-workbench backdrop-blur-2xl border border-hairline shadow-[0_32px_80px_rgba(0,0,0,0.8),inset_0_1px_0_0_rgba(255,255,255,0.1)] overflow-hidden flex flex-col text-zinc-300 relative"
      >
        {/* ── Settings Header Bar ─────────────────────────────────────────── */}
        <div className="h-11 bg-white/[0.03] backdrop-blur-xl border-b border-white/[0.08] px-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-zinc-300 shadow-sm">
              <Settings className="w-3.5 h-3.5" />
            </div>
            <div className="flex items-center gap-1.5 text-body">
              <span className="font-semibold text-zinc-100">Settings</span>
              {projectName && (
                <>
                  <span className="text-zinc-500">/</span>
                  <span className="text-xs font-mono text-zinc-400">{projectName}</span>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-lg hover:bg-white/[0.08] transition cursor-pointer border border-transparent hover:border-white/[0.08]"
            title="Close Settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Main Two-Column Stage ────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0 overflow-hidden font-sans">
          {/* Left Column: Navigation Category Tree */}
          <aside className="w-[clamp(180px,24%,260px)] bg-black/25 backdrop-blur-xl border-r border-white/[0.08] flex flex-col shrink-0">
            {/* Search Settings Input */}
            <div className="p-2.5 border-b border-white/[0.06]">
              <div className="relative flex items-center">
                <Search className="w-3.5 h-3.5 absolute left-2.5 text-zinc-400" />
                <input
                  type="text"
                  value={navSearch}
                  onChange={(e) => setNavSearch(e.target.value)}
                  placeholder="Search settings..."
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-body text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/30 font-sans transition"
                />
                {navSearch && (
                  <button
                    type="button"
                    onClick={() => setNavSearch("")}
                    className="absolute right-2 text-zinc-400 hover:text-zinc-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Tree Navigation List */}
            <div className="flex-1 overflow-y-auto py-2 text-xs">
              {filteredTree.map((node) => (
                <TreeItem
                  key={node.id}
                  node={node}
                  selectedSection={selectedSection}
                  expandedNodes={expandedNodes}
                  onToggleNode={toggleNode}
                  onSelectSection={navigateTo}
                  level={0}
                />
              ))}
            </div>
          </aside>

          {/* Right Column: Configuration Stage */}
          <main className="flex-1 min-w-0 bg-transparent flex flex-col h-full overflow-hidden">
            {/* Stage Top Breadcrumbs Header */}
            <div className="h-10 px-5 border-b border-white/[0.06] flex items-center justify-between shrink-0 bg-white/[0.02]">
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 font-sans">
                {breadcrumb.map((crumb, idx) => (
                  <React.Fragment key={crumb}>
                    {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
                    <span
                      className={
                        idx === breadcrumb.length - 1
                          ? "text-zinc-100 font-semibold"
                          : "text-zinc-400"
                      }
                    >
                      {crumb}
                    </span>
                  </React.Fragment>
                ))}
              </div>

              {/* Top Navigation History / Pin Controls */}
              <div className="flex items-center gap-1 text-zinc-400">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={historyIndex <= 0}
                  className="p-1 hover:text-zinc-100 disabled:opacity-30 disabled:hover:text-zinc-500 rounded transition"
                  title="Back"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleForward}
                  disabled={historyIndex >= history.length - 1}
                  className="p-1 hover:text-zinc-100 disabled:opacity-30 disabled:hover:text-zinc-500 rounded transition"
                  title="Forward"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
                <div className="h-3 w-[1px] bg-white/[0.08] mx-1" />
                <button
                  type="button"
                  className="p-1 hover:text-zinc-100 rounded transition"
                  title="Pin"
                >
                  <Pin className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Stage Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-5 text-body text-zinc-200 font-sans">
              {selectedSection === "providers" && (
                <div className="space-y-5 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      LLM Provider & Engine Configuration
                    </h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Configure local or cloud inference engines for code generation, diff synthesis, and chat.
                    </p>
                  </div>

                  {/* Provider Selection Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {/* Local Ollama */}
                    <button
                      type="button"
                      aria-pressed={provider === "ollama"}
                      onClick={() => setProvider("ollama")}
                      className={`p-3 rounded-card border cursor-pointer transition ${
                        provider === "ollama"
                          ? "bg-surface-selected border-accent text-zinc-100 ring-1 ring-accent shadow-sm"
                          : "bg-surface border-hairline hover:border-zinc-700 hover:bg-surface-hover"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <ProviderLogo providerId="ollama" className="w-4 h-4" />
                        <span className="font-semibold text-xs text-zinc-100">
                          Local Ollama
                        </span>
                        <span className="text-4xs font-mono px-1 py-0.2 rounded bg-amber-400/20 text-amber-300 font-bold">
                          Default
                        </span>
                      </div>
                      <p className="text-3xs text-zinc-400 leading-tight">
                        Connects to local daemon (Qwen 2.5 Coder, Llama 3.2, DeepSeek).
                      </p>
                    </button>

                    {/* Cloud OpenAI / Anthropic */}
                    <button
                      type="button"
                      aria-pressed={provider === "openai"}
                      onClick={() => setProvider("openai")}
                      className={`p-3 rounded-card border cursor-pointer transition ${
                        provider === "openai"
                          ? "bg-surface-selected border-accent text-zinc-100 ring-1 ring-accent shadow-sm"
                          : "bg-surface border-hairline hover:border-zinc-700 hover:bg-surface-hover"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <ProviderLogo providerId="openai" className="w-4 h-4" />
                        <span className="font-semibold text-xs text-zinc-100">
                          Cloud APIs
                        </span>
                      </div>
                      <p className="text-3xs text-zinc-400 leading-tight">
                        GPT-4o, Claude 3.7 Sonnet, Google Gemini, DeepSeek Cloud.
                      </p>
                    </button>
                  </div>

                  {/* Provider Settings Details */}
                  <div className="space-y-3.5 pt-2 border-t border-hairline">
                    <div className="space-y-1">
                      <label htmlFor="settings-model" className="text-xs font-semibold text-zinc-200">                        Model Identifier</label>
                      <input
                        id="settings-model"
                        type="text"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={
                          provider === "ollama"
                            ? "e.g. qwen2.5-coder:7b"
                            : provider === "local"
                            ? "e.g. qwen2.5-coder-7b-instruct.gguf"
                            : "e.g. gpt-4o, claude-3-7-sonnet"
                        }
                        className="w-full bg-workbench/60 border border-hairline rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="settings-base-url" className="text-xs font-semibold text-zinc-200">                        Base URL</label>
                      <input
                        id="settings-base-url"
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={
                          provider === "ollama"
                            ? "http://127.0.0.1:11434"
                            : provider === "local"
                            ? "http://127.0.0.1:8080"
                            : "https://api.openai.com/v1"
                        }
                        className="w-full bg-workbench/60 border border-hairline rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
                      />
                    </div>

                    {provider === "openai" && (
                      <div className="space-y-1">
                        <label htmlFor="settings-api-key" className="text-xs font-semibold text-zinc-200">                        API Key</label>
                        <div className="relative flex items-center">
                          <input
                            id="settings-api-key"
                            type={showApiKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="sk-..."
                            className="w-full bg-workbench/60 border border-hairline rounded-lg px-3 py-1.5 pr-8 text-xs text-zinc-100 font-mono focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey(!showApiKey)}
                            className="absolute right-2.5 text-zinc-400 hover:text-zinc-200"
                          >
                            {showApiKey ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Test Connection Button */}
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={testStatus === "testing"}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface hover:bg-surface-hover text-zinc-200 text-xs font-medium transition border border-hairline shadow-elevation-1"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${
                            testStatus === "testing" ? "animate-spin text-purple-400" : ""
                          }`}
                        />
                        <span>Test Connection</span>
                      </button>

                      {testStatus === "success" && (
                        <span className="flex items-center gap-1 text-emerald-400 text-xs">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{testMessage}</span>
                        </span>
                      )}

                      {testStatus === "error" && (
                        <span className="flex items-center gap-1 text-rose-400 text-xs">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{testMessage}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {selectedSection === "appearance" && (
                <div className="space-y-5 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      UI Theme & Workbench Appearance
                    </h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Select your preferred IDE theme. Changes take effect across editor, sidebars, tabs, and status bar immediately.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {Object.values(PRESET_THEMES).map((theme) => {
                      const isCurrent = themeId === theme.id;
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          aria-pressed={isCurrent}
                          onClick={() => onApplyTheme && onApplyTheme(theme.id)}
                          className={`p-3 rounded-card border cursor-pointer transition flex flex-col justify-between ${
                            isCurrent
                              ? "bg-purple-950/40 border-purple-500/50 ring-1 ring-purple-500/40 shadow-sm"
                              : "bg-surface border-hairline hover:border-zinc-700 hover:bg-surface-hover"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-xs text-zinc-100">
                              {theme.name}
                            </span>
                            {isCurrent && (
                              <span className="w-4 h-4 rounded-full bg-purple-600 flex items-center justify-center text-white">
                                <Check className="w-2.5 h-2.5 stroke-[3]" />
                              </span>
                            )}
                          </div>

                          {/* Theme Swatches */}
                          <div className="flex items-center gap-1.5 p-2 rounded-md bg-workbench border border-hairline">
                            <span
                              className="w-4 h-4 rounded border border-white/10"
                              style={{ backgroundColor: theme.colors.background }}
                              title={`Editor: ${theme.colors.background}`}
                            />
                            <span
                              className="w-4 h-4 rounded border border-white/10"
                              style={{ backgroundColor: theme.colors.sidebarBg }}
                              title={`Sidebar: ${theme.colors.sidebarBg}`}
                            />
                            <span
                              className="w-4 h-4 rounded border border-white/10"
                              style={{ backgroundColor: theme.colors.accent }}
                              title={`Accent: ${theme.colors.accent}`}
                            />
                            <span
                              className="w-4 h-4 rounded border border-white/10"
                              style={{ backgroundColor: theme.colors.statusBarBg }}
                              title={`Status Bar: ${theme.colors.statusBarBg}`}
                            />
                            <span className="text-3xs font-mono text-zinc-400 ml-auto capitalize">
                              {theme.type}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Accent, which is a separate decision from the theme: one
                      theme ships, and the accent is the brand. Showing the
                      candidates here in the real workbench is the point — a
                      taste call needs looking at, not a list of hex codes. */}
                  <div className="pt-1">
                    <h3 className="text-sm font-semibold text-zinc-100">Accent</h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      The mark's two ends, and a point between them. Applied live; kept for the next launch.
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    {Object.values(PRESET_ACCENTS).map((accent) => {
                      const isCurrent = accentId === accent.id;
                      return (
                        <button
                          key={accent.id}
                          type="button"
                          aria-pressed={isCurrent}
                          onClick={() => onApplyAccent && onApplyAccent(accent.id)}
                          className={`p-3 rounded-card border cursor-pointer transition text-left ${
                            isCurrent
                              ? "bg-purple-950/40 border-purple-500/50 ring-1 ring-purple-500/40 shadow-sm"
                              : "bg-surface border-hairline hover:border-zinc-700 hover:bg-surface-hover"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-xs text-zinc-100">{accent.name}</span>
                            {isCurrent && (
                              <span className="w-4 h-4 rounded-full bg-purple-600 flex items-center justify-center text-white">
                                <Check className="w-2.5 h-2.5 stroke-[3]" />
                              </span>
                            )}
                          </div>
                          <div
                            className="h-5 rounded border border-white/10 mb-2"
                            style={{
                              background: `linear-gradient(90deg, ${accent.ramp["400"]}, ${accent.ramp["600"]})`,
                            }}
                          />
                          <p className="text-3xs text-zinc-400 leading-relaxed">{accent.blurb}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── SECTION: EDITOR > FONT ───────────────────────────────────── */}
              {selectedSection === "editor-font" && (
                <div className="space-y-5 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Editor Typography & Font
                    </h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Configure typography for code editors and diff viewers. JetBrains Mono is the bundled default across all surfaces.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label htmlFor="settings-font-family" className="text-xs font-semibold text-zinc-200">                        Font Family</label>
                      <select
                        id="settings-font-family"
                        value="JetBrains Mono"
                        disabled
                        className="w-full rounded-lg bg-workbench/60 border border-hairline px-3 py-1.5 text-xs text-zinc-200 font-mono cursor-not-allowed opacity-90"
                      >
                        <option value="JetBrains Mono">JetBrains Mono (Bundled Default)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="settings-font-size" className="text-xs font-semibold text-zinc-200">                        Font Size: {fontSize}px</label>
                      <input
                        id="settings-font-size"
                        type="range"
                        min={11}
                        max={20}
                        value={fontSize}
                        onChange={(e) => setFontSize(Number(e.target.value))}
                        className="w-full accent-purple-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-zinc-200">
                        Line Spacing: {lineHeight}
                      </label>
                      <input
                        type="range"
                        min={1.2}
                        max={2.0}
                        step={0.1}
                        value={lineHeight}
                        onChange={(e) => setLineHeight(Number(e.target.value))}
                        className="w-full accent-purple-500"
                      />
                    </div>

                    <div className="flex items-center pt-5">
                      <label className="flex items-center gap-2 cursor-pointer text-zinc-200">
                        <input
                          type="checkbox"
                          checked={enableLigatures}
                          onChange={(e) => setEnableLigatures(e.target.checked)}
                          className="rounded border-hairline text-purple-400 focus:ring-0"
                        />
                        <span>Enable font ligatures (==, !=, =&gt;)</span>
                      </label>
                    </div>
                  </div>

                  {/* Live JetBrains Mono Code Preview Box */}
                  <div className="space-y-1.5 pt-2">
                    <p className="text-xs font-medium text-zinc-400">
                      Live Font Preview
                    </p>
                    <div
                      className="rounded-panel bg-workbench/80 border border-hairline p-4 font-mono text-zinc-100 overflow-x-auto shadow-elevation-1"
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: `${fontSize}px`,
                        lineHeight: lineHeight,
                        fontVariantLigatures: enableLigatures ? "normal" : "none",
                      }}
                    >
                      <div className="text-zinc-500">// JetBrains Mono font sample with ligatures:</div>
                      <div>
                        <span className="text-purple-400">export function</span>{" "}
                        <span className="text-purple-300 font-semibold">evaluateMetric</span>(
                        <span className="text-amber-300">items</span>: Item[]):{" "}
                        <span className="text-teal-400">boolean</span> &#123;
                      </div>
                      <div className="pl-4">
                        <span className="text-purple-400">const</span> isClean = items.length !=={" "}
                        <span className="text-amber-300">0</span> &amp;&amp; items[0].score &gt;={" "}
                        <span className="text-amber-300">95</span>;
                      </div>
                      <div className="pl-4">
                        <span className="text-purple-400">return</span> isClean ==={" "}
                        <span className="text-emerald-400">true</span> ? items.every(i =&gt; i.valid) :{" "}
                        <span className="text-red-400">false</span>;
                      </div>
                      <div>&#125;</div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── SECTION: EDITOR > CODE STYLE ─────────────────────────────── */}
              {selectedSection === "editor-code-style" && (
                <div className="space-y-4 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Editor Indentation & Code Style
                    </h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Configure tab size, spaces vs tabs, and auto-formatting behavior.
                    </p>
                  </div>

                  <div className="space-y-3 bg-surface border border-hairline rounded-panel p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-200">Tab Size</span>
                      <select
                        value={tabSize}
                        onChange={(e) => setTabSize(Number(e.target.value))}
                        className="bg-workbench/80 border border-hairline rounded-md px-2.5 py-1 text-xs text-zinc-200"
                      >
                        <option value={2}>2 spaces</option>
                        <option value={4}>4 spaces</option>
                        <option value={8}>8 spaces</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between border-t border-hairline pt-3">
                      <span className="text-zinc-200">Insert Spaces</span>
                      <input
                        type="checkbox"
                        checked={insertSpaces}
                        onChange={(e) => setInsertSpaces(e.target.checked)}
                        className="rounded border-hairline text-purple-400 focus:ring-0"
                      />
                    </div>


                    <div className="flex items-center justify-between border-t border-hairline pt-3">
                      <span className="text-zinc-200">Word Wrap in Editor</span>
                      <input
                        type="checkbox"
                        checked={wordWrap}
                        onChange={(e) => setWordWrap(e.target.checked)}
                        className="rounded border-hairline text-purple-400 focus:ring-0"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ── SECTION: AGENT ───────────────────────────────────────────── */}
              {selectedSection === "agent" && (
                <div className="space-y-4 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">Agent</h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Decide up front what the agent may do on its own. This is the
                      approval step — pick one mode and runs stop interrupting you.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-zinc-200">Engine</p>
                    {(Object.keys(AGENT_TRANSPORTS) as AgentTransport[]).map((id) => {
                      const option = AGENT_TRANSPORTS[id];
                      const selected = agentTransport === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setAgentTransport(id)}
                          className={`w-full text-left rounded-panel border p-3 transition-colors cursor-pointer ${
                            selected
                              ? "border-purple-500/60 bg-purple-950/30"
                              : "border-hairline bg-surface hover:bg-workbench"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-3 h-3 rounded-full border ${
                                selected ? "border-purple-400 bg-purple-500" : "border-zinc-600"
                              }`}
                            />
                            <span className="text-xs font-medium text-zinc-100">{option.label}</span>
                            {id === DEFAULT_AGENT_TRANSPORT && (
                              <span className="text-3xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                                Stable
                              </span>
                            )}
                          </div>
                          <p className="text-2xs text-zinc-400 mt-1.5 ml-5 leading-relaxed">
                            {option.description}
                          </p>
                        </button>
                      );
                    })}

                    <p className="text-xs font-semibold text-zinc-200 pt-2">Approvals</p>
                    {(Object.keys(AGENT_APPROVAL_MODES) as AgentApprovalMode[]).map((mode) => {
                      const option = AGENT_APPROVAL_MODES[mode];
                      const selected = approvalMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setApprovalMode(mode)}
                          className={`w-full text-left rounded-panel border p-3 transition-colors cursor-pointer ${
                            selected
                              ? "border-purple-500/60 bg-purple-950/30"
                              : "border-hairline bg-surface hover:bg-workbench"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-3 h-3 rounded-full border ${
                                selected
                                  ? "border-purple-400 bg-purple-500"
                                  : "border-zinc-600 bg-transparent"
                              }`}
                            />
                            <span className="text-xs font-medium text-zinc-100">
                              {option.label}
                            </span>
                            {mode === DEFAULT_AGENT_APPROVAL_MODE && (
                              <span className="text-3xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                                Recommended
                              </span>
                            )}
                            {mode === "ask-me" && agentTransport !== "app-server" && (
                              <span className="text-3xs px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/60">
                                Needs app-server · falls back
                              </span>
                            )}
                          </div>
                          <p className="text-2xs text-zinc-400 mt-1.5 ml-5 leading-relaxed">
                            {option.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>

                  <p className="text-2xs text-zinc-500 leading-relaxed">
                    These map onto the agent runtime&apos;s own sandbox and approval
                    settings. &ldquo;Read only&rdquo; and &ldquo;Approve for me&rdquo;
                    both keep the agent inside your project folder and the system
                    temporary directory that builds need.
                  </p>

                  <div className="pt-3 border-t border-hairline space-y-1">
                    <label htmlFor="agent-turn-limit" className="text-xs font-semibold text-zinc-200">
                      Turn time limit
                    </label>
                    <p className="text-2xs text-zinc-400 leading-relaxed pb-1">
                      How long one turn may work before the app stops it. Time spent
                      waiting for your answer does not count, and a stopped turn says so
                      instead of just disappearing. Measured: a small change where the
                      agent spent most of six minutes building its own test harness.
                    </p>
                    <select
                      id="agent-turn-limit"
                      value={turnLimitMinutes}
                      onChange={(e) => setTurnLimitMinutes(Number(e.target.value))}
                      className="bg-workbench/80 border border-hairline rounded-md px-2.5 py-1 text-xs text-zinc-200 cursor-pointer"
                    >
                      {TURN_LIMIT_CHOICES.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes === 0 ? "No limit" : `${minutes} minutes`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* ── SECTION: TERMINAL ────────────────────────────────────────── */}
              {selectedSection === "terminal" && (
                <div className="space-y-4 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Integrated Terminal Settings
                    </h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Text size for the integrated terminal.
                    </p>
                  </div>

                  <div className="space-y-3 bg-surface border border-hairline rounded-panel p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-200">Terminal Font Size</span>
                      <select
                        value={terminalFontSize}
                        onChange={(e) => setTerminalFontSize(Number(e.target.value))}
                        className="bg-workbench/80 border border-hairline rounded-md px-2.5 py-1 text-xs text-zinc-200"
                      >
                        <option value={12}>12px</option>
                        <option value={13}>13px</option>
                        <option value={14}>14px</option>
                        <option value={15}>15px</option>
                        <option value={16}>16px</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {selectedSection === "about" && <AboutPane />}

              {selectedSection === "data" && <DataPane />}

              {selectedSection === "marketplace" && (
                <div className="space-y-4 max-w-2xl">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">Marketplace</h3>
                    <p className="text-2xs text-zinc-400 mt-0.5">
                      Skills, MCP servers and tooling the agent can use.
                    </p>
                  </div>

                  <div className="bg-surface border border-hairline rounded-panel p-4 space-y-3">
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      Plugins, skills and MCP servers are managed in the Marketplace panel, where each
                      entry shows its source repository, licence, and exactly what an install writes to
                      disk before you commit to it.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenMarketplace?.();
                      }}
                      className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition cursor-pointer"
                    >
                      Open the Marketplace
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

            </div>

            {/* ── Dialog Action Footer Bar ──────────────────────────────────── */}
            <div className="h-12 bg-white/[0.03] backdrop-blur-xl border-t border-white/[0.08] px-5 flex items-center justify-between shrink-0">
              {/* Left Help Button */}
              <button
                type="button"
                className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition shadow-sm"
                title="Help"
              >
                <HelpCircle className="w-4 h-4" />
              </button>

              {/* Right Action Buttons */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 text-body font-medium border border-white/[0.08] transition cursor-pointer font-sans shadow-sm"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={handleApply}
                  className="px-4 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 text-body font-medium border border-white/[0.08] transition cursor-pointer font-sans shadow-sm"
                >
                  Apply
                </button>

                <button
                  type="button"
                  onClick={handleOk}
                  className="px-5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-body font-semibold shadow-sm transition cursor-pointer font-sans"
                >
                  OK
                </button>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

interface TreeItemProps {
  node: TreeNode;
  selectedSection: string;
  expandedNodes: Record<string, boolean>;
  onToggleNode: (id: string, e: React.MouseEvent) => void;
  onSelectSection: (id: string) => void;
  level: number;
}

function TreeItem({
  node,
  selectedSection,
  expandedNodes,
  onToggleNode,
  onSelectSection,
  level,
}: TreeItemProps) {
  if (!node) return null;
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const isExpanded = Boolean(expandedNodes?.[node.id]);
  const isSelected = selectedSection === node.id;

  const handleClick = (e: React.MouseEvent) => {
    if (hasChildren) {
      onToggleNode(node.id, e);
    } else {
      onSelectSection(node.id);
    }
  };

  return (
    <div className="px-1.5 py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-current={isSelected ? "true" : undefined}
        onKeyDown={(e) => {
          // Native buttons fire on Enter and Space; these rows are divs because
          // they contain their own disclosure button.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (hasChildren) onToggleNode(node.id, e as unknown as React.MouseEvent);
            else onSelectSection(node.id);
          }
        }}
        onClick={handleClick}
        style={{ paddingLeft: `${6 + level * 14}px` }}
        className={`px-2 py-1.5 rounded-lg flex items-center justify-between cursor-pointer transition-colors group ${
          isSelected
            ? "bg-purple-950/40 border border-purple-500/40 text-purple-200 font-medium shadow-sm"
            : "hover:bg-white/[0.06] text-zinc-300 hover:text-zinc-100"
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 font-sans">
          {hasChildren ? (
            <button
              type="button"
              aria-label={isExpanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
              onClick={(e) => onToggleNode(node.id, e)}
              className="w-3.5 h-3.5 flex items-center justify-center text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>
          ) : (
            <span className="w-3.5 h-3.5" />
          )}

          <span className="truncate text-body">{node.label}</span>
        </div>

        {node.hasExternalBadge && (
          <span className="w-2.5 h-2.5 rounded-sm border border-hairline text-zinc-400 group-hover:text-zinc-200 flex items-center justify-center text-[8px] opacity-70">
            ▫
          </span>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              selectedSection={selectedSection}
              expandedNodes={expandedNodes}
              onToggleNode={onToggleNode}
              onSelectSection={onSelectSection}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default SettingsModal;
