/**
 * AiAssistantChat.tsx — the chat panel and the agent surface.
 *
 * Two workflows share one composer:
 * 1. 💬 Ask (default) — conversational streaming with code blocks, copy, and
 *    workspace context (git state, recent changes).
 * 2. ⚡ Agent — an autonomous task run, executed by the Codex runtime and
 *    streamed into the transcript step by step.
 */

import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { Icon } from "../ui/Icon";
import { RotateCcw, Trash2, Copy, GitCommit, Maximize2, Minimize2, RefreshCw, Square, User, Check, ChevronDown, ChevronRight, Code, Code2, MessageSquare, ListTodo, X, Bot, CheckCircle2, Plus, Folder, GitBranch, ArrowUp, Image as ImageIcon, Database, AlertCircle, AtSign, FileCode, Sparkles, Shield, Terminal, Search, Wrench, Users, HelpCircle } from "lucide-react";
import type { PipelineStatus, PipelineOutputLine } from "../../types/telemetry";
import { FOLLOW_THRESHOLD_PX, isFollowingBottom } from "../../services/scrollAnchor";
import {
  getConfiguredModelsList,
  ensureProvidersHydrated,
  ConfiguredModelItem,
  loadAllProviders,
  getAutoSelectedLocalWorker,
  isModelVisionCapable,
  findBestAvailableVisionModel,
  resolveInitialSelectedModel,
  saveActiveSelectedModel,
  getActiveSelectedModel,
  syncOllamaModels,
} from "../../services/aiModelManager";
import {
  ProviderLogo,
} from "../ui/BrandLogos";
import {
  openAiManagementDashboard,
  checkOllamaStatus,
  EVENT_START_CODING_WITH_OLLAMA,
} from "../../services/ollamaSetup";
import {
  streamChatCompletion,
  type ChatMessage,
  type AgentStep,
} from "../../services/aiChatService";
import { chatDraft, useChatDraft } from "../../services/chatDraft";
import {
  loadChatHistory,
  saveChatHistory,
  clearChatHistory,
  subscribeChatHistory,
} from "../../services/aiChatPersistence";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { AgentQuestion, PendingFileChange, ProjectIndexState } from "../../hooks/usePipeline";
import { approvalSummary, countDiffLines } from "../../hooks/usePipeline";
import { localProviderFor, type ApprovalDecision } from "../../services/agentApproval";
import { canRunAgent, rememberTierTooSmall } from "../../services/aiModelManager";
import { attachmentBlock, readAttachments, type AttachedFile } from "../../services/chatAttachments";
import { filterFiles, flattenFiles } from "../../services/fileSearch";
import type { FileNode } from "../FileTree";
import { readTextFile, writeTextFile } from "../../services/fileAccess";
import { formatDuration } from "../../services/agentTurnLimit";
import { summarizeFailure } from "../../services/providerErrors";

interface AiAssistantChatProps {
  status: PipelineStatus;
  activityLog: PipelineOutputLine[];
  onRunPipeline: (
    request: string,
    overrideModel?: { provider: string; model: string; apiKey?: string; baseUrl?: string },
    activeFilePath?: string,
    selectedCode?: string,
    conversationHistory?: Array<{ role: string; content: string }>,
    images?: string[],
    /** `plan` asks the agent runtime for a read-only planning turn. */
    runMode?: "agent" | "plan"
  ) => void;
  onCancelPipeline: () => void;
  /**
   * Send a message into the turn that is already running. Resolves to `null` on
   * success, or a sentence to show — and to put the unsent text back for.
   */
  onSteerPipeline?: (text: string) => Promise<string | null>;
  /**
   * Put the last turn's file changes back. Resolves to `null` on success, or a
   * sentence to show — the same contract as steering.
   */
  onUndoLastTurn?: () => Promise<string | null>;
  projectRoot?: string;
  /** Current git branch of the active project (shown on the hero welcome screen). */
  branch?: string;
  onClose?: () => void;
  onPopOutWide?: () => void;
  isWide?: boolean;
  selectedContext?: { path: string; code: string } | null;
  /** The project's files, for "Add Context → Files…". Absent means no picker. */
  projectFiles?: FileNode[];
  failureDetail?: string;
  /** A finished run that left every file's path and size untouched. */
  noFileChanges?: boolean;
  /** The runtime's own name for a state where it is blocked on the human. */
  waitingForUser?: string;
  /**
   * Working time on the current turn, excluding time blocked on the human. Owned
   * by the pipeline rather than counted here: the turn *limit* has to exclude the
   * same time, and two counters that disagree about what they measure are worse
   * than one.
   */
  turnElapsedMs?: number;
  /** The ceiling applied to one turn, in minutes. Zero means no limit. */
  turnLimitMinutes?: number;
  /** A request the agent is blocked on, waiting for the user's answer. */
  pendingApproval?: {
    id: unknown;
    method: string;
    command: string;
    reason: string;
    changes?: PendingFileChange[];
  } | null;
  respondToApproval?: (decision: ApprovalDecision) => Promise<void>;
  /** A `request_user_input` question, which needs answers rather than a decision. */
  pendingQuestion?: { id: unknown; questions: AgentQuestion[] } | null;
  respondToQuestion?: (answers: Record<string, string[]>) => Promise<void>;
  /** What the last turn changed, from the runtime's own item diffs. */
  turnChanges?: PendingFileChange[];
  /** Open a file's two sides in the diff viewer. */
  onReviewFile?: (path: string) => Promise<void>;
  indexStatus?: ProjectIndexState;
  isIndexing?: boolean;
  onSyncIndex?: () => void;
  streamingAnswer?: string;
  streamingThought?: string;
  agentSteps?: AgentStep[];
  activeAiSettings?: { provider: string; model: string } | null;
}

export type WorkflowMode = "agent" | "chat" | "plan";

/**
 * The mode a run will actually use, which is not always the one on the chip.
 *
 * Agent and plan runs go through the runtime, which needs a model that calls
 * tools. A model that cannot — a local one the daemon reports as having no tool
 * support, say — would read files and answer without changing anything, so the
 * run becomes a chat instead of a failure.
 *
 * The user's own `workflowMode` is deliberately left alone. It is their
 * selection, it is what the chip reports, and a mode the app moved behind their
 * back is one they can cancel by accident — which lands them straight back in a
 * mode the model cannot run. So the chip only ever shows a mode the reader chose,
 * and the downgrade stays internal.
 */
export function effectiveWorkflowMode(mode: WorkflowMode, canRunAgent: boolean): WorkflowMode {
  return canRunAgent ? mode : "chat";
}

/**
 * What "Implement plan" sends.
 *
 * Names the file rather than repeating the plan: the plan is in the project, in
 * the conversation, and in the index the agent reads — pasting it back in would
 * be a third copy that can disagree with the other two.
 */
export const IMPLEMENT_PLAN_PROMPT =
  "Implement the plan in implementation-plan.md. Follow it, verify with the project's own build and tests, and say what you deviated from and why.";

/**
 * Stable empties for the optional list props.
 *
 * `agentSteps = []` in a parameter list runs on every render and hands back a new
 * array each time, which is enough to make any memoised child below fail its
 * comparison forever. These are the same value every render, so the comparison
 * holds.
 */
const NO_STEPS: AgentStep[] = [];
const NO_CHANGES: PendingFileChange[] = [];

/**
 * How many animation frames "open at the newest message" may keep correcting
 * itself — 90 frames is about a second and a half at 60Hz.
 *
 * The scroll cannot be done once: the transcript is still being laid out when a
 * hydrated history arrives (a `ChangeLogCard`, a code block, an expanded step
 * drawer each change the height after the first paint), and a scroll issued
 * against a height that is about to change leaves the view somewhere other than
 * the end. Retrying is what makes it land; the cap is what stops a transcript
 * that can never reach the end from spinning a frame loop.
 */
const REVEAL_ATTEMPTS = 90;

export function cleanThoughtText(raw?: string): string {
  if (!raw) return "";
  return raw
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "")
    .replace(/<(?:invoke|function_call|call|action|tool)\b[\s\S]*?(?:<\/(?:invoke|function_call|call|action|tool)>|$)/gi, "")
    .replace(/<(?:parameter|arg|argument)\b[\s\S]*?(?:<\/(?:parameter|arg|argument)>|$)/gi, "")
    .replace(/```(?:json)?\s*\{\s*"(?:tool|name)"[\s\S]*?\}\s*```/gi, "")
    .replace(/Action:\s*[A-Za-z0-9_]+\s*\nAction Input:\s*\{[\s\S]*?\}/g, "")
    .replace(/(?:^|\n)(?:[#*`\s]*)(?:(?:File|path|Target)?:\s*)?\[?[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9_]+\]?[:*#`\s]*\n<{5,9}\s*SEARCH[\s\S]*?>{5,9}\s*REPLACE/g, "")
    .replace(/(?:^|\n)diff\s+--git[\s\S]*?(?=\n(?:[A-Z#*`]|diff\s+--git|$))/g, "")
    .replace(/<\/(?:tool_call|invoke|function_call|call|action|parameter|arg|argument|think)>/gi, "")
    .trim();
}

interface ChatTranscriptProps {
  /** Set on the message whose turn can be undone; null when there is nothing to undo. */
  undoMessageId?: string | null;
  undoBusy?: boolean;
  undoNotice?: string | null;
  onUndo?: () => Promise<void>;
  chatMessages: ChatMessage[];
  isWide: boolean;
  status: PipelineStatus;
  streamingAnswer: string;
  streamingThought: string;
  agentSteps: AgentStep[];
  agentElapsedMs: number;
  turnLimitMinutes: number;
  currentAgentPhase: string;
  blockedOn: string;
  turnChanges: PendingFileChange[];
  pendingQuestion: AiAssistantChatProps["pendingQuestion"];
  /** The model that produced the turn, named on the message it produced. */
  selectedModelItem: ConfiguredModelItem | null;
  onReviewFile?: (path: string) => Promise<void>;
  onCancelPipeline: () => void;
  bottomRef: React.RefObject<HTMLDivElement>;
}

/**
 * The conversation, memoised.
 *
 * The composer's text is state in the component above, so every character typed
 * re-rendered this — all of it: every message, its markdown, its code blocks,
 * its thinking accordion — because a keystroke and the transcript happened to
 * live in the same component. The transcript's inputs are unchanged by typing, so
 * with this boundary a keystroke costs the composer and nothing else.
 *
 * Props are all primitives, stable callbacks, or state that only moves when the
 * conversation does (`chatMessages` is replaced on a new message, not mutated),
 * which is what lets the comparison hold.
 */
const ChatTranscript = memo(function ChatTranscript({
  chatMessages,
  isWide,
  status,
  streamingAnswer,
  streamingThought,
  agentSteps,
  agentElapsedMs,
  turnLimitMinutes,
  currentAgentPhase,
  blockedOn,
  undoMessageId = null,
  undoBusy = false,
  undoNotice = null,
  onUndo,
  turnChanges,
  pendingQuestion,
  selectedModelItem,
  onReviewFile,
  onCancelPipeline,
  bottomRef,
}: ChatTranscriptProps) {
  return (
    <>
    {(chatMessages.length > 0 || status === "running") && (
      <div className={isWide ? "max-w-3xl lg:max-w-4xl mx-auto w-full space-y-4 py-2" : "space-y-4"}>
        {chatMessages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${
              msg.role === "user" ? "items-end" : "items-start"
            }`}
          >
            {/* Role Header with Model, Provider, Timestamp */}
            <div className={`flex items-center gap-1.5 mb-1 px-1 text-3xs text-zinc-400 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className="flex items-center gap-1.5 min-w-0">
                {msg.role === "user" ? (
                  <>
                    <span className="font-semibold text-zinc-300">You</span>
                    <Icon icon={User} className="w-3 h-3 text-zinc-400 shrink-0" />
                    {msg.timestamp && (
                      <span className="text-4xs font-mono text-zinc-500 ml-1">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    {msg.provider ? (
                      <ProviderLogo providerId={msg.provider} className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <Icon icon={Bot} className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                    )}
                    <span className="font-semibold text-purple-300 font-mono text-2xs truncate">
                      {msg.model || "AI Assistant"}
                    </span>
                    {msg.timestamp && (
                      <span className="text-4xs font-mono text-zinc-500 ml-1">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Message Bubble */}
            <div
              className={`max-w-[95%] p-3.5 rounded-2xl text-xs leading-relaxed transition-all ${
                msg.role === "user"
                  ? "bg-zinc-800/80 border border-zinc-700/60 text-zinc-100 rounded-tr-sm shadow-sm"
                  : msg.error
                  ? "bg-red-950/30 border border-red-500/30 text-red-200 rounded-tl-sm w-full"
                  : "bg-zinc-900/90 border border-zinc-800/90 text-zinc-100 rounded-tl-sm w-full"
              }`}
            >
              {/* Attached files, as the chips they were when they were sent. */}
              {msg.attachedPaths && msg.attachedPaths.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {msg.attachedPaths.map((path) => (
                    <span
                      key={path}
                      data-testid="message-attachment"
                      title={path}
                      className="flex items-center gap-1.5 px-1.5 py-1 rounded-md bg-zinc-900/70 border border-zinc-700/70 text-2xs text-zinc-300 max-w-[14rem]"
                    >
                      <Icon icon={FileCode} className="w-3 h-3 text-zinc-500 shrink-0" />
                      <span className="truncate font-mono">{path.split("/").pop() || path}</span>
                    </span>
                  ))}
                </div>
              )}

              {/* User Attached Images */}
              {msg.images && msg.images.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {msg.images.map((img, i) => (
                    <button
                      key={i}
                      type="button"
                      className="cursor-pointer rounded-lg border border-zinc-700 hover:opacity-90 transition-opacity"
                      title="Open attachment in a new window"
                      onClick={() => window.open(img, "_blank")}
                    >
                      <img
                        src={img}
                        alt="Attachment"
                        className="max-h-48 max-w-xs rounded-lg object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}

              {/* Collapsible Model Thinking & Agent Steps (auto-collapsed when summary exists) */}
              {((msg.steps && msg.steps.length > 0) || Boolean(msg.thinking)) && (
                <ThinkingAccordion
                  steps={msg.steps}
                  thinking={msg.thinking}
                  isLive={false}
                  hasSummary={Boolean(msg.content && msg.content.trim())}
                />
              )}

              <FormattedMarkdown content={msg.content} isStreaming={msg.isStreaming} />
              {msg.changes && msg.changes.length > 0 && (
                <ChangeLogCard changes={msg.changes} onReview={onReviewFile} />
              )}

              {/* Actionable Error Recovery Card */}
              {msg.error && (
                <div className="mt-3 p-3 rounded-xl bg-zinc-900/95 border border-zinc-700/60 text-xs space-y-2.5 shadow-xl">
                  {msg.errorType === "timeout" ? (
                    <>
                      <div className="flex items-center gap-2 text-amber-300 font-medium">
                        <Icon icon={AlertCircle} className="w-4 h-4 text-amber-400 shrink-0" />
                        <span>Generation Timed Out</span>
                      </div>
                      <p className="text-zinc-400 text-2xs leading-relaxed">
                        The local model <strong>{msg.model || "qwen2.5-coder"}</strong> took longer than expected to process the request. Local 7B models can be slow under heavy context. Consider switching to a faster local model (e.g. <code>qwen2.5-coder:1.5b</code> or <code>3b</code>) or shortening the prompt.
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => openAiManagementDashboard()}
                          className="px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-2xs font-medium transition-colors cursor-pointer"
                        >
                          Switch Model / Provider
                        </button>
                      </div>
                    </>
                  ) : msg.errorType === "offline" ? (
                    <>
                      <div className="flex items-center gap-2 text-red-300 font-medium">
                        <Icon icon={AlertCircle} className="w-4 h-4 text-red-400 shrink-0" />
                        <span>Provider Unreachable or Offline</span>
                      </div>
                      <p className="text-zinc-400 text-2xs leading-relaxed">
                        Unable to connect to <strong>{msg.provider || selectedModelItem?.providerId || "the AI provider"}</strong>. If you are using local models, ensure the Ollama background daemon is running.
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => openAiManagementDashboard()}
                          className="px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-2xs font-medium transition-colors cursor-pointer"
                        >
                          Configure Provider / Model
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("acsa:open-ollama-wizard"));
                          }}
                          className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-2xs transition-colors border border-zinc-700 cursor-pointer"
                        >
                          Start Ollama Wizard
                        </button>
                      </div>
                    </>
                  ) : msg.errorType === "api" ? (
                    <>
                      <div className="flex items-center gap-2 text-red-300 font-medium">
                        <Icon icon={AlertCircle} className="w-4 h-4 text-red-400 shrink-0" />
                        <span>Provider API / Model Error</span>
                      </div>
                      <p className="text-zinc-400 text-2xs leading-relaxed">
                        {msg.content?.replace(/^⚠️\s*\*\*Task Failed:\*\*\s*/i, "") ||
                          `The AI provider returned an error while processing your request with ${msg.model || "the selected model"}.`}
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => openAiManagementDashboard()}
                          className="px-2.5 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white text-2xs font-medium transition-colors cursor-pointer"
                        >
                          Configure Model / API Key
                        </button>
                      </div>
                    </>
                  ) : msg.errorType === "syntax" ? (
                    <>
                      <div className="flex items-center gap-2 text-zinc-300 font-medium">
                        <Icon icon={AlertCircle} className="w-4 h-4 text-amber-400 shrink-0" />
                        <span>Stopped Before Finishing</span>
                      </div>
                      <p className="text-zinc-400 text-2xs leading-relaxed">
                        The agent hit a syntax or lint problem it could not resolve and stopped. Open the <strong>Output</strong> tab to see exactly which check complained, then reply with a correction.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-zinc-300 font-medium">
                        <Icon icon={AlertCircle} className="w-4 h-4 text-amber-400 shrink-0" />
                        <span>Task Execution Notice</span>
                      </div>
                      <p className="text-zinc-400 text-2xs leading-relaxed">
                        {msg.content?.replace(/^⚠️\s*\*\*Task Failed:\*\*\s*/i, "") ||
                          "The task encountered an issue during execution. Check the output tab or console for details."}
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => openAiManagementDashboard()}
                          className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-2xs transition-colors border border-zinc-700 cursor-pointer"
                        >
                          Check AI Settings
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {/* Bottom Message Actions (Copy button positioned under message) */}
            {msg.content && (
              <div className={`mt-1 flex items-center ${msg.role === "user" ? "justify-end" : "justify-start"} px-1`}>
                <CopyMessageButton text={msg.content} />
                {onUndo && undoMessageId === msg.id && (
                  <button
                    type="button"
                    disabled={undoBusy}
                    data-testid="undo-last-turn"
                    onClick={() => void onUndo()}
                    title="Put these files back to how they were before that turn"
                    className={`inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded border transition-all select-none ${
                      undoBusy
                        ? "text-muted border-transparent cursor-not-allowed"
                        : "text-muted hover:text-zinc-200 hover:bg-zinc-800/80 border-transparent cursor-pointer"
                    }`}
                  >
                    <Icon icon={RotateCcw} className="w-3 h-3" />
                    {undoBusy ? "Undoing…" : "Undo"}
                  </button>
                )}
                {onUndo && undoMessageId === msg.id && undoNotice && (
                  <span role="status" data-testid="undo-notice" className="text-3xs text-muted">
                    {undoNotice}
                  </span>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Active Running Agent Assistant Turn */}
        {status === "running" && (
          <div className="flex flex-col items-start">
            <div className="flex items-center gap-1.5 mb-1 px-1 text-3xs text-zinc-400 justify-start">
              {selectedModelItem?.providerId ? (
                <ProviderLogo providerId={selectedModelItem.providerId} className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <Icon icon={Bot} className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              )}
              <span className="font-semibold text-purple-300 font-mono text-2xs">
                {selectedModelItem?.model || "ACSA Agent"}
              </span>
              {/* The most prominent label of the three, and it said
                  "Working" through a six-minute wait for an answer. */}
              <span
                className={`flex items-center gap-1 text-3xs font-mono ml-2 ${
                  blockedOn ? "text-amber-300" : "text-purple-400"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    blockedOn ? "bg-amber-400 animate-pulse" : "bg-purple-400 animate-pulse"
                  }`}
                />
                {blockedOn
                  ? `Waiting for ${blockedOn}`
                  : turnLimitMinutes > 0
                  ? `Working ${formatDuration(agentElapsedMs)} of ${turnLimitMinutes}m`
                  : `Working ${formatDuration(agentElapsedMs)}`}
              </span>
            </div>

            <div className="max-w-[95%] p-3.5 rounded-2xl text-xs leading-relaxed bg-zinc-900/90 border border-purple-500/30 text-zinc-100 rounded-tl-sm w-full shadow-lg">
              {/* Live Thinking Accordion (auto-collapses when summary arrives) */}
              <ThinkingAccordion
                steps={agentSteps}
                thinking={streamingThought}
                isLive={true}
                hasSummary={Boolean(streamingAnswer && streamingAnswer.trim())}
                elapsedSeconds={Math.floor(agentElapsedMs / 1000)}
                blockedOn={blockedOn}
              />

              {/* Live Streaming Answer */}
              {streamingAnswer ? (
                <div className="mt-2.5 pt-2.5 border-t border-zinc-800/80">
                  <FormattedMarkdown content={streamingAnswer} isStreaming={true} />
                </div>
              ) : blockedOn ? (
                /* Not thinking — stopped. A spinner here is a lie. */
                <div className="flex items-center gap-2 text-amber-300 text-xs py-1">
                  <Icon icon={HelpCircle} className="w-3.5 h-3.5 text-amber-400" />
                  <span>
                    {pendingQuestion
                      ? "The agent asked you a question — answer it below to continue"
                      : "The agent needs your approval before it continues"}
                  </span>
                </div>
              ) : (
                !streamingThought && (!agentSteps || agentSteps.length === 0) ? (
                  <div className="flex items-center gap-2 text-zinc-400 text-xs py-1">
                    <Icon icon={RefreshCw} className="w-3 h-3 animate-spin text-purple-400" />
                    <span>Thinking through solution...</span>
                  </div>
                ) : null
              )}

              {/* Stop Generating Button & Active Step */}
              <div className="mt-3 pt-2.5 border-t border-zinc-800/60 flex items-center justify-between">
                <span
                  className={`text-2xs truncate max-w-[70%] ${
                    blockedOn ? "text-amber-300 font-medium" : "text-zinc-400"
                  }`}
                >
                  {blockedOn
                    ? `Waiting for ${blockedOn}`
                    : agentSteps.length > 0
                    ? `Step ${agentSteps.length}: ${agentSteps[agentSteps.length - 1].name}`
                    : currentAgentPhase || "Initializing..."}
                </span>
                <button
                  type="button"
                  onClick={onCancelPipeline}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white text-2xs font-medium transition-colors border border-zinc-700/80 cursor-pointer shadow-sm shrink-0"
                >
                  <Icon icon={Square} className="w-2.5 h-2.5 fill-red-400 text-red-400" />
                  <span>Stop Generating</span>
                </button>
              </div>
            </div>

            {/* Bottom Message Actions for Running Turn */}
            {streamingAnswer && (
              <div className="mt-1 flex items-center justify-start px-1">
                <CopyMessageButton text={streamingAnswer} />
              </div>
            )}
          </div>
        )}
      </div>
    )}

  {/* Live copy, while the turn is still going. Once it ends the same card
      is on the message, so this one stands down rather than doubling up. */}
  {status === "running" && turnChanges.length > 0 && (
    <ChangeLogCard
      changes={turnChanges.map((change) => ({
        path: change.path,
        ...countDiffLines(change.diff),
      }))}
      onReview={onReviewFile}
    />
  )}

  <div ref={bottomRef} />
    </>
  );
});

export function AiAssistantChat({
  status,
  activityLog,
  onRunPipeline,
  onCancelPipeline,
  onSteerPipeline,
  onUndoLastTurn,
  projectRoot = "",
  branch = "",
  onClose,
  onPopOutWide,
  isWide = false,
  selectedContext = null,
  projectFiles = [],
  failureDetail = "",
  noFileChanges = false,
  waitingForUser = "",
  pendingApproval = null,
  respondToApproval,
  turnElapsedMs = 0,
  turnLimitMinutes = 0,
  pendingQuestion = null,
  respondToQuestion,
  turnChanges = NO_CHANGES,
  onReviewFile,
  indexStatus,
  isIndexing = false,
  onSyncIndex,
  streamingAnswer = "",
  streamingThought = "",
  agentSteps = NO_STEPS,
  activeAiSettings = null,
}: AiAssistantChatProps) {

  const [configuredModels, setConfiguredModels] = useState<ConfiguredModelItem[]>(() => getConfiguredModelsList());
  const [selectedModelItem, setSelectedModelItem] = useState<ConfiguredModelItem | null>(() =>
    resolveInitialSelectedModel()
  );

  /** Whether this turn's plan reached disk. Drives the line under the reply. */
  const [planFile, setPlanFile] = useState<{ path: string; ok: boolean } | null>(null);
  /**
   * False while a plan run's write is still in flight.
   *
   * The reply has to be finalised *after* that write settles: finalising first
   * built its note from a result that had not arrived yet, which is why the first
   * plan run finished with no note at all.
   */
  const [planWriteSettled, setPlanWriteSettled] = useState(true);
  const lastWrittenPlan = useRef("");
  // Whether the run in flight was started as a plan run. Read at send time, not at
  // finish time: asking `workflowMode` when the turn ends means a mode change
  // mid-run silently skips the write, and leaves the reply's note disagreeing with
  // whether the file exists.
  const planRunRef = useRef(false);

  // The registry hydrates asynchronously (from the database, over IPC), so reading
  // it in a mount-time initialiser can legitimately find nothing — and then chat
  // refuses to send with "no model is installed or selected" for the whole session,
  // even though the dashboard shows a connected provider. Re-resolve once hydration
  // lands; an explicit pick by the user is never overwritten.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureProvidersHydrated();
      if (cancelled) return;
      setConfiguredModels(getConfiguredModelsList());
      setSelectedModelItem((current) => current ?? resolveInitialSelectedModel());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectModel = (item: ConfiguredModelItem | null) => {
    setSelectedModelItem(item);
    if (item) {
      saveActiveSelectedModel(item.providerId, item.model);
    }
  };
  const [localWorker, setLocalWorker] = useState<string>(getAutoSelectedLocalWorker());
  const effectiveProvider =
    selectedModelItem?.providerId || activeAiSettings?.provider || "ollama";
  const effectiveModel =
    selectedModelItem?.model || activeAiSettings?.model || localWorker;
  // What the model pill says on hover. The old text announced a "Cloud Brain" and
  // a "Local Worker" regardless of what was selected; now that a local model can be
  // the agent itself, say where the chosen one actually runs.
  const modelTitle = selectedModelItem
    ? selectedModelItem.category === "local"
      ? `${selectedModelItem.model} — runs on this machine. Free, and nothing leaves it, but a local model is far less capable than a hosted one.`
      : `${selectedModelItem.model} — hosted by ${selectedModelItem.providerName}`
    : `Running on ${effectiveProvider}:${effectiveModel}`;

  /**
   * Whether the chosen model can drive agent or plan at all.
   *
   * Both go through the runtime, which needs a model that calls tools; a local
   * model the daemon reports as having no tool support can only talk. Nothing
   * selected reads as `true`: with no explicit choice the app falls back to a
   * configured default, and guessing "cannot" there would switch a working setup
   * into ask mode on first paint.
   */
  const selectedModelCanRunAgent = selectedModelItem
    ? canRunAgent(selectedModelItem.providerId, selectedModelItem.model)
    : true;

  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  // Persistent chat history across tab switches, panel open/close, and reloads
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() =>
    loadChatHistory(projectRoot)
  );
  // Subscribed, not passed down: see services/chatDraft.ts. This is what keeps a
  // keystroke from re-rendering the workbench above the chat.
  const draft = useChatDraft();
  const [confirmClearChat, setConfirmClearChat] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  /** Why the last steer did not send, if it did not. Cleared on the next send. */
  const [steerError, setSteerError] = useState<string | null>(null);
  /** What an undo did or could not do, shown where the button was. */
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>("agent");

  // The finalisation effect below reads the plan-file result, but must not
  // *depend* on it: it appends the assistant reply, so re-running it when the
  // value changes would add the same message twice. Mirrored instead, and kept
  // current by its own effect.
  const planFileRef = useRef(planFile);
  // Entering or leaving a mode starts a new piece of work. Keeping the previous
  // plan-file result would leave `Implement plan` enabled for a plan that is no
  // longer on screen — the control has to mean "the plan you can see is written".
  useEffect(() => {
    setPlanFile(null);
    lastWrittenPlan.current = "";
  }, [workflowMode]);
  useEffect(() => {
    planFileRef.current = planFile;
  }, [planFile]);

  /**
   * What the next message will be sent as.
   *
   * The chip keeps showing the reader's own mode; this is what the run uses. See
   * `effectiveWorkflowMode`.
   */
  const effectiveMode = effectiveWorkflowMode(workflowMode, selectedModelCanRunAgent);

  /**
   * What the mode chip's tooltip says.
   *
   * The chip is only ever the reader's own choice — the app's capability
   * downgrade is internal (see `effectiveWorkflowMode`) — so this is simply the
   * way back out. Both composers render it, hence one sentence rather than two
   * that drift.
   */
  const modeChipTitle = workflowMode === "plan" ? "Turn plan mode off" : "Turn ask mode off";

  /**
   * A plan run's answer *is* the plan, so it gets written down.
   *
   * The app writes it, not the model: the plan sandbox is read-only, which is the
   * only thing that actually stops a planning turn from editing code, and handing
   * the model write access to "just one file" would give that guarantee up for the
   * whole project. Rewritten on every plan turn, so the file tracks the plan rather
   * than keeping the first draft of it.
   */
  useEffect(() => {
    if (!planRunRef.current || status !== "success" || !projectRoot) {
      setPlanWriteSettled(true);   // nothing to write, so nothing to wait for
      return;
    }
    const plan = (streamingAnswer || "").trim();
    if (!plan || plan === lastWrittenPlan.current) {
      setPlanWriteSettled(true);
      return;
    }
    lastWrittenPlan.current = plan;
    const path = `${projectRoot.replace(/\/+$/, "")}/implementation-plan.md`;
    writeTextFile(path, `${plan}\n`, projectRoot)
      .then(() => setPlanFile({ path, ok: true }))
      .finally(() => setPlanWriteSettled(true))
      // The plan is still in the transcript, so a failed write is a note about the
      // file, not a failed run.
      .catch(() => setPlanFile({ path, ok: false }));
  }, [status, streamingAnswer, projectRoot]);

  const isStreamingRef = useRef(false);

  // Multimodal image attachment state
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  /**
   * Files folded into the next message. Chips above the input, text in the prompt —
   * see services/chatAttachments.ts for what a large file does to the budget.
   */
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isFilePickerOpen, setIsFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const fileQueryInputRef = useRef<HTMLInputElement | null>(null);
  const filePickerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageFiles = (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        if (dataUrl) {
          setAttachedImages((prev) => [...prev, dataUrl]);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  // Drag and drop, alongside paste: both end in `handleImageFiles`, so a dropped
  // image and a pasted one take the same route to the same attachment list. The
  // `dragover` handler *must* preventDefault or the browser never fires `drop` —
  // the classic way this silently does nothing.
  const [isImageDragOver, setIsImageDragOver] = useState(false);

  const handleImageDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsImageDragOver(true);
  };

  const handleImageDragLeave = () => setIsImageDragOver(false);

  const projectFileList = useMemo(() => flattenFiles(projectFiles), [projectFiles]);

  const attachFile = (path: string) => {
    const clean = path.trim();
    if (!clean) return;
    setAttachedFiles((prev) =>
      prev.some((file) => file.path === clean)
        ? prev
        : [...prev, { path: clean, name: clean.split("/").pop() || clean }],
    );
    setIsFilePickerOpen(false);
    setFileQuery("");
  };

  const removeFile = (path: string) => {
    setAttachedFiles((prev) => prev.filter((file) => file.path !== path));
  };

  /**
   * A drop carries either an image or a path. Images were the only kind this
   * understood; a row dragged out of the explorer carries its path as text, which
   * is the same file the reader was pointing at.
   */
  useEffect(() => {
    if (isFilePickerOpen) fileQueryInputRef.current?.focus();
  }, [isFilePickerOpen]);

  const handleComposerDrop = (e: React.DragEvent) => {
    // Only when the drop carries no file objects — a dropped file has no path in a
    // webview, and the existing rule that a stray text file is not an attachment
    // stays exactly as it was. `getData` is also absent from a synthetic
    // DataTransfer, so reading it has to be the thing that can fail without
    // taking the image path down with it.
    const droppedFiles = e.dataTransfer?.files?.length ?? 0;
    if (droppedFiles === 0) {
      let asText = "";
      try {
        asText = e.dataTransfer?.getData?.("text/plain")?.trim() ?? "";
      } catch {
        asText = "";
      }
      // An absolute path is what an explorer row carries; dragged text is not a
      // file and attaching it would put whatever was selected into the prompt.
      if (asText.startsWith("/")) attachFile(asText);
    }
    handleImageDrop(e);
  };

  const handleImageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsImageDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) handleImageFiles(files);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      handleImageFiles(imageFiles);
    }
  };

  const isCurrentModelVisionCapable = selectedModelItem
    ? isModelVisionCapable(selectedModelItem.providerId, selectedModelItem.model)
    : false;

  const bestVisionAlternative =
    attachedImages.length > 0 && !isCurrentModelVisionCapable
      ? findBestAvailableVisionModel(loadAllProviders())
      : null;

  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const heroMenuRef = useRef<HTMLDivElement>(null);
  /** The row for the model in use, so the list can open on it. */
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const heroContextMenuRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  /** The transcript's scroll container, so appends can tell whether to follow. */
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  /** The composer, so a card that needs an answer can be brought into view. */
  const composerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const projectName = projectRoot ? projectRoot.split("/").filter(Boolean).pop() || "acsa-code" : "acsa-code";
  const latestActivity = activityLog[activityLog.length - 1]?.content || "";
  /**
   * A failed run whose reason the runtime did not phrase usefully.
   *
   * `failureDetail` holds the runtime's own words when it has any. A dead provider
   * is the case where it effectively has none — the transcript used to say only
   * "the task needs attention". What the runtime *did* print is enough to name the
   * cause, so this reads it back out.
   */
  const failureSummary =
    status === "failed" && !failureDetail ? summarizeFailure(activityLog) ?? "" : "";
  const currentAgentPhase = latestActivity.includes("syntax")
    ? "Checking generated changes"
    : latestActivity.includes("performance") || latestActivity.includes("sandbox")
    ? "Running verification checks"
    : latestActivity.includes("Written:") || latestActivity.includes("patch")
    ? "Applying verified changes"
    : status === "running"
    ? "Thinking through the task"
    : status === "success"
    ? "Task completed"
    : status === "failed" || status === "error"
    ? "Task failed"
    : "Ready";

  // The clock for the running turn is the pipeline's (`turnElapsedMs`) — it has
  // to stop while the agent is waiting on an answer, because the turn *limit*
  // stops then too, and a second counter here used to keep running.

  /**
   * Put the cursor on the card the turn is blocked on.
   *
   * The card was already pinned above the composer, so it could be seen — but
   * nothing announced it and nothing moved focus, which is why a run parked for
   * six minutes was diagnosed by reading the accessibility tree. A blocking prompt
   * has to be where the keyboard is, not only where the pixels are. Fired once per
   * card (`announcedCardRef`), so moving focus elsewhere does not yank it back.
   */
  const announcedCardRef = useRef("");
  useEffect(() => {
    const key = pendingApproval
      ? `approval:${String(pendingApproval.id)}`
      : pendingQuestion
      ? `question:${String(pendingQuestion.id)}`
      : "";
    if (!key) {
      announcedCardRef.current = "";
      return;
    }
    if (announcedCardRef.current === key) return;
    const card = composerRef.current?.querySelector<HTMLElement>("[data-pending-card]");
    if (!card) return;
    announcedCardRef.current = key;
    card.focus();
  }, [pendingApproval, pendingQuestion]);

  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === "running" && (status === "success" || status === "failed" || status === "error")) {
      const isSuccess = status === "success";
      let errorType: "offline" | "timeout" | "syntax" | "api" | "general" = "general";
      const detailLower = (failureDetail || "").toLowerCase();
      if (
        detailLower.includes("unable to connect") ||
        detailLower.includes("unreachable") ||
        detailLower.includes("connection refused")
      ) {
        errorType = "offline";
      } else if (detailLower.includes("timed out") || detailLower.includes("timeout")) {
        errorType = "timeout";
      } else if (
        detailLower.includes("api error") ||
        detailLower.includes("http 40") ||
        detailLower.includes("http 50") ||
        detailLower.includes("404") ||
        detailLower.includes("401") ||
        detailLower.includes("403") ||
        detailLower.includes("429") ||
        detailLower.includes("responses endpoint") ||
        detailLower.includes("v1/responses") ||
        detailLower.includes("api key") ||
        detailLower.includes("not supported in the v1") ||
        detailLower.includes("returned no changes") ||
        detailLower.includes("empty response")
      ) {
        errorType = "api";
      } else if (detailLower.includes("syntax") || detailLower.includes("lint")) {
        errorType = "syntax";
      }

      // The agent's own final message is the answer. There is no separate
      // "verification result" object any more — that data source is gone.
      //
      // A run that changed no file says so. The wording describes what was
      // measured (paths and sizes) rather than claiming "nothing happened" — a
      // run that answered a question legitimately changes nothing, and a design
      // that was never written is otherwise indistinguishable from one that was.
      //
      // On a local model the same measurement means something else, and it is not
      // the user's fault: measured against `qwen3.5:9b`, `qwen2.5-coder:7b` and
      // `deepseek-coder:6.7b` behind the tool adapter, none of them emitted a
      // single function call for the runtime's real prompt — they answer in prose,
      // or write a tool call as a `<read path="…"/>` tag or a ```bash fence, which
      // nothing executes. A short probe prompt does make `qwen3.5:9b` call tools,
      // so it is the size of a Codex-shaped prompt that defeats them, not the
      // plumbing. Say so, and name the way out, instead of leaving a dead turn
      // that reads like a completed task. See docs/AGENT_RUNTIME.md.
      // The pipeline already reports a run that never touched a tool as a step
      // named "No tools used" — that is the measurement, rather than a guess from
      // the reply text.
      // A plan run's reply is not final until its write has settled — the note is
      // built from that result, and there is nothing to say until it is known.
      if (planRunRef.current && status === "success" && !planWriteSettled) return;

      // Saying "too large for this tier" once is not enough — the next run would
      // try the same thing again. Remember it, so the picker can drop that model
      // from the agent list instead of offering a run that cannot fit.
      if (
        status === "failed" &&
        selectedModelItem &&
        /request too large|tokens per minute|\b413\b/i.test(`${failureDetail ?? ""} ${failureSummary ?? ""}`)
      ) {
        rememberTierTooSmall(selectedModelItem.providerId, selectedModelItem.model);
      }

      const usedNoTools = agentSteps.some((step) => step.name === "No tools used");
      const localRun = Boolean(localProviderFor(selectedModelItem?.providerId)) && usedNoTools;
      const noChangesNote = localRun
        ? "\n\n> **Nothing ran.** The model answered without calling a single tool, so no file was read, edited or run. Local models this size usually cannot drive the agent — switch the model picker to a hosted provider (a free tier will do) and send this again."
        : "\n\n> No files were added, removed or resized in this run.";
      // A plan turn is *supposed* to leave the code alone, so "no files were
      // added" is true and misleading: the file it did write is the plan. Say where
      // it went, and offer the one next step.
      // The runtime's own state, not a guess from the text: it says
      // `waitingOnUserInput` when a skill has asked a question and the turn is
      // holding for an answer. Without this the reply ends the turn looking like
      // a finished task, and the next thing the user sends starts a new one.
      const waitingNote =
        waitingForUser === "waitingOnUserInput"
          ? "\n\n> **Waiting on you.** The agent asked something and stopped. Answer in the box below to carry on — your reply continues the same thread."
          : waitingForUser === "waitingOnApproval"
          ? "\n\n> **Waiting on you.** The agent needs an approval before it continues."
          : "";
      const finalContent = isSuccess
        ? (streamingAnswer || "Task completed.") +
          (noFileChanges && !planRunRef.current ? noChangesNote : "") +
          waitingNote
        : failureDetail || failureSummary
        ? `⚠️ **Task Failed:** ${failureDetail || failureSummary}`
        : "The task needs attention. Review Problems or Output for details.";

      const finalizedSteps = agentSteps.map((s) =>
        s.status === "running" ? { ...s, status: "done" as const } : s
      );

      const agentMsg: ChatMessage = {
        id: `assistant-agent-${Date.now()}`,
        role: "assistant",
        content: finalContent,
        timestamp: Date.now(),
        provider: selectedModelItem?.providerId || "ollama",
        model: selectedModelItem?.model || "ACSA Agent",
        steps: finalizedSteps.length > 0 ? finalizedSteps : undefined,
        thinking: cleanThoughtText(streamingThought) || undefined,
        error: !isSuccess,
        errorType: !isSuccess ? errorType : undefined,
        // Recorded on the message, not only in live state, so the log scrolls
        // back with the transcript instead of vanishing on the next turn.
        changes:
          turnChanges.length > 0
            ? turnChanges.map((change) => ({
                path: change.path,
                ...countDiffLines(change.diff),
              }))
            : undefined,
      };
      setChatMessages((prev) => {
        const next = [...prev, agentMsg];
        saveChatHistory(next, projectRoot);
        return next;
      });
    }
    prevStatusRef.current = status;
  }, [status, failureDetail, failureSummary, noFileChanges, waitingForUser, turnChanges, projectRoot, selectedModelItem, streamingAnswer, streamingThought, agentSteps, planWriteSettled]);

  /**
   * Ask Ollama what is actually installed, and believe it.
   *
   * Models are deleted outside the app, and the registry only ever grew, so a
   * deleted model stayed in this picker forever. The daemon is the source of
   * truth; refresh whenever the list is about to be looked at. `syncOllamaModels`
   * also clears a saved selection that names a model that is gone, because the
   * agent resolves its model from that.
   */
  /**
   * What the run is blocked on, in words, or "" when it is not blocked.
   *
   * A blocked run used to look exactly like a busy one — the spinner and the
   * "Step N" line kept going for minutes while the turn was really waiting on a
   * person. Watched live: a run sat for roughly six minutes and the only way to
   * learn why was to read the accessibility tree.
   */
  const blockedOn = pendingQuestion
    ? "your answer"
    : pendingApproval
    ? "your approval"
    : "";

  // Answers being collected for a `request_user_input` question, keyed by
  // question id. The runtime takes every answer in one response, so option
  // clicks accumulate and the response goes out once each question has one —
  // which for the common single-question case means the first click sends.
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string[]>>({});

  useEffect(() => {
    // A new question starts from a clean slate; carrying answers across would
    // answer the wrong question.
    setQuestionAnswers({});
  }, [pendingQuestion?.id]);

  useEffect(() => {
    if (!blockedOn) return;
    // Bring it into view. On a long transcript the card is both the only thing
    // that needs attention and the easiest thing to miss, and until this existed
    // nothing moved or changed when the turn stopped to ask.
    composerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [blockedOn]);

  const answerQuestion = useCallback(
    (questionId: string, values: string[]) => {
      const next = { ...questionAnswers, [questionId]: values };
      setQuestionAnswers(next);

      const questions = pendingQuestion?.questions ?? [];
      const complete =
        questions.length > 0 &&
        questions.every((q) => (next[q.id] ?? []).some((value) => value.trim() !== ""));
      if (complete) {
        void respondToQuestion?.(next);
        setQuestionAnswers({});
      }
    },
    [questionAnswers, pendingQuestion, respondToQuestion],
  );

  const refreshLocalModels = useCallback(async () => {
    try {
      const status = await checkOllamaStatus();
      if (!status.running) return;
      syncOllamaModels(status.models, undefined, status.modelsDetails);
      setConfiguredModels(getConfiguredModelsList());
    } catch {
      /* Not installed, or not running: leave the registry as it is. */
    }
  }, []);

  useEffect(() => {
    void refreshLocalModels();
  }, [refreshLocalModels]);

  useEffect(() => {
    if (isModelMenuOpen) void refreshLocalModels();
  }, [isModelMenuOpen, refreshLocalModels]);

  // The list is taller than the panel when a window is short, so it used to open
  // showing rows below the model actually in use. Start on the selected row.
  useEffect(() => {
    if (!isModelMenuOpen) return;
    const timer = window.setTimeout(() => {
      selectedRowRef.current?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isModelMenuOpen]);

  // Sync available models and listen for global updates
  useEffect(() => {
    const refresh = () => {
      const list = getConfiguredModelsList();
      setConfiguredModels(list);
      setLocalWorker(getAutoSelectedLocalWorker());
      setSelectedModelItem((prev) => {
        const saved = getActiveSelectedModel();
        if (saved) {
          const match = list.find((m) => m.providerId === saved.providerId && m.model === saved.model);
          if (match) return match;
        }
        if (prev) {
          const match = list.find((m) => m.model === prev.model && m.providerId === prev.providerId);
          if (match) return match;
        }
        return list.find((m) => m.isDefault) || list[0] || null;
      });
    };

    refresh();
    window.addEventListener("acsa:models-updated", refresh);
    window.addEventListener("acsa:local-worker-updated", refresh);
    window.addEventListener("acsa:selected-model-changed", refresh);
    return () => {
      window.removeEventListener("acsa:models-updated", refresh);
      window.removeEventListener("acsa:local-worker-updated", refresh);
      window.removeEventListener("acsa:selected-model-changed", refresh);
    };
  }, []);

  // Listen for focus requests / Start Coding with Ollama triggers
  useEffect(() => {
    const handleFocus = (e: any) => {
      const targetModel = e?.detail?.model;
      if (targetModel) {
        const list = getConfiguredModelsList();
        const match = list.find((m) => m.model === targetModel);
        if (match) {
          handleSelectModel(match);
        }
      }
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    };

    window.addEventListener("acsa:focus-ai-chat-input", handleFocus);
    window.addEventListener(EVENT_START_CODING_WITH_OLLAMA, handleFocus);
    return () => {
      window.removeEventListener("acsa:focus-ai-chat-input", handleFocus);
      window.removeEventListener(EVENT_START_CODING_WITH_OLLAMA, handleFocus);
    };
  }, []);

  // Load chat history on mount or when projectRoot changes
  useEffect(() => {
    setChatMessages(loadChatHistory(projectRoot));
  }, [projectRoot]);

  // Subscribe to external chat updates across tabs/panels
  useEffect(() => {
    const unsub = subscribeChatHistory(projectRoot, (incoming) => {
      if (!isStreamingRef.current) {
        setChatMessages(incoming);
      }
    });
    return unsub;
  }, [projectRoot]);

  // Auto-focus the input textarea when panel opens or model changes
  useEffect(() => {
    // Never steal focus from the card the turn is blocked on. This effect runs
    // after the card's own focus effect, so without this, opening the chat while
    // a turn was already parked on an approval put the cursor in the input and
    // left the thing that needed an answer unannounced. When the card clears, the
    // input takes focus back, which is where the user is going next anyway.
    if (pendingApproval || pendingQuestion) return;
    textareaRef.current?.focus();
  }, [selectedModelItem, workflowMode, pendingApproval, pendingQuestion]);

  // Keyboard shortcut listeners (Cmd+L for Chat mode, Shift+Cmd+I for Agent mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        setWorkflowMode("agent");
        textareaRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        setWorkflowMode((prev) => (prev === "chat" ? "agent" : "chat"));
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        (!menuRef.current || !menuRef.current.contains(e.target as Node)) &&
        (!modelMenuRef.current || !modelMenuRef.current.contains(e.target as Node)) &&
        (!heroMenuRef.current || !heroMenuRef.current.contains(e.target as Node))
      ) {
        setIsModelMenuOpen(false);
      }
      if (
        (!contextMenuRef.current || !contextMenuRef.current.contains(e.target as Node)) &&
        (!heroContextMenuRef.current || !heroContextMenuRef.current.contains(e.target as Node))
      ) {
        setIsContextMenuOpen(false);
      }
      if (
        filePickerRef.current &&
        !filePickerRef.current.contains(e.target as Node)
      ) {
        setIsFilePickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleWorkflowRequest = (event: Event) => {
      const mode = (event as CustomEvent<WorkflowMode>).detail;
      setWorkflowMode(mode);
      if (!selectedContext?.code) return;
      const context = `\n\nSelected code from ${selectedContext.path}:\n\`\`\`\n${selectedContext.code}\n\`\`\``;
      chatDraft.set(
        mode === "agent"
          ? `Edit the selected code to make it more readable. Preserve behavior and write the change to ${selectedContext.path}.${context}`
          : mode === "plan"
          ? `Help me design and plan architectural improvements or changes for this selected code.${context}`
          : `Help me understand this selected code.${context}`
      );
      textareaRef.current?.focus();
    };
    window.addEventListener("acsa:ai-workflow", handleWorkflowRequest);
    return () => window.removeEventListener("acsa:ai-workflow", handleWorkflowRequest);
  }, [selectedContext]);

  // Opening a chat lands on the newest message.
  //
  // The follow-tail effect below deliberately does nothing when the reader is not
  // at the bottom — and a freshly opened transcript is exactly that, scrolled to
  // the top of the whole history, so the reply someone came back to read was a
  // manual scroll away. This runs once, when there is finally something to scroll
  // to (history arrives after mount), and then the follow logic takes over.
  //
  // "Once" is the whole difficulty, and it is why this checks where it landed
  // rather than trusting that it ran. The transcript is still being laid out when
  // history arrives — cards and code blocks land over several frames — so
  // `scrollIntoView` can fire against a box whose height is about to change and
  // leave the view at the top while looking like success. Marking the scroll done
  // at that point wedges it for good: the effect returns early from then on, and
  // the follow-tail effect will not fill in, because a container at the top is by
  // definition not following the bottom. So it retries for a moment, stops the
  // instant the view is really at the end, and only then sets the flag. Verified
  // by hand on a relaunch with a five-message transcript: the manual scroll
  // reached the newest message while the automatic one had left it at the first,
  // and after this change the automatic one lands where the manual one did.
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (didInitialScroll.current || chatMessages.length === 0) return;
    let attempts = 0;
    let settledHeight = -1;
    let pinnedTop = -1;
    let frame = requestAnimationFrame(function reveal() {
      if (didInitialScroll.current) return;
      const container = transcriptScrollRef.current;
      const sentinel = chatBottomRef.current;
      attempts += 1;
      if (container && sentinel) {
        // The reader scrolled away under their own steam — this is a jump for a
        // transcript that has just opened, not a lock on the scrollbar.
        if (pinnedTop >= 0 && container.scrollTop < pinnedTop - FOLLOW_THRESHOLD_PX) {
          didInitialScroll.current = true;
          return;
        }
        sentinel.scrollIntoView({ block: "end", behavior: "auto" });
        pinnedTop = container.scrollTop;
        // Done once the view is at the end *and* the transcript has stopped
        // growing. "At the end" alone is not enough to stop on: while history is
        // still being laid out the content is momentarily shorter than the panel,
        // so the view is trivially at the end and the next frame moves it.
        if (isFollowingBottom(container) && container.scrollHeight === settledHeight) {
          didInitialScroll.current = true;
          return;
        }
        settledHeight = container.scrollHeight;
      }
      // Not at the end yet — layout is still moving. Keep going for about a
      // second and a half, then accept it, so a transcript that can never reach
      // the end does not spin a frame loop forever.
      if (attempts < REVEAL_ATTEMPTS) frame = requestAnimationFrame(reveal);
      else didInitialScroll.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [chatMessages.length]);

  /**
   * Whether the reader was following the tail — judged from the last *scroll
   * event*, not from the box as it looks once an append has landed.
   *
   * Appends are in the DOM before this component's effects run, so the follow
   * effect used to measure after the fact: a tall new message has already pushed
   * `scrollHeight` up by hundreds of pixels, the container reads as someone who
   * scrolled away, and the follow is skipped — leaving the end of the reply, and
   * anything the reply added under it, below the fold. A short reply stays inside
   * the threshold, which is why only long ones ever failed to follow.
   */
  const followingTail = useRef(true);
  /** Scroll events we caused ourselves, during a smooth scroll, are not the user. */
  const followLockUntil = useRef(0);
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (performance.now() < followLockUntil.current) return;
      followingTail.current = isFollowingBottom(el);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * Undo belongs to the turn that just finished, so it is offered *on that
   * message* rather than in the composer — where it was a control that had
   * nothing to do with what you were reading.
   *
   * The last assistant message is the one it applies to: snapshots are kept per
   * turn and pruned, so offering it on every old reply would be a surprise rather
   * than a convenience.
   */
  const undoMessageId =
    status !== "running" && turnChanges.length > 0 && onUndoLastTurn
      ? [...chatMessages].reverse().find((message) => message.role === "assistant")?.id ?? null
      : null;

  const handleUndo = useCallback(async () => {
    if (!onUndoLastTurn) return;
    setUndoBusy(true);
    setUndoNotice(null);
    const failure = await onUndoLastTurn();
    setUndoNotice(failure ?? "Undone — those files are back to how they were before that turn.");
    setUndoBusy(false);
  }, [onUndoLastTurn]);

  // Follow the tail on new messages, logs and streaming updates — but only while
  // the reader is already at the bottom. Scrolling up to read something used to
  // be undone by the next token. Streaming lands many times a second and a smooth
  // scroll restarted that often never settles, so those are instant.
  //
  // `planFile` is in the list because it grows the transcript *after* the reply is
  // appended: the Implement plan button appears once the plan reaches disk, and
  // without following for that the button the reader was just told about is the
  // one thing still below the fold.
  useEffect(() => {
    if (!followingTail.current) return;
    const streaming = isStreaming || status === "running";
    followLockUntil.current = performance.now() + 600;
    chatBottomRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
  }, [chatMessages, activityLog, isStreaming, streamingAnswer, agentSteps, status, planFile]);

  // ── Handle Send ─────────────────────────────────────────────────────────
  const handleSend = async (textToSend = draft, forcedMode?: WorkflowMode) => {
    // The caller may be switching mode and sending in one click (Implement plan).
    // Reading the state variable here would use the value from before the update,
    // and the run would take the wrong branch — planning when asked to build.
    //
    // `effectiveMode` is the reader's mode *unless* the chosen model cannot run
    // it, in which case the run is a chat. The chip is untouched by that: see
    // `effectiveWorkflowMode`.
    const mode = forcedMode ?? effectiveMode;
    const trimmed = textToSend.trim();
    if (!trimmed && attachedImages.length === 0 && attachedFiles.length === 0) return;

    const currentImages = attachedImages.length > 0 ? [...attachedImages] : undefined;
    const currentFiles = attachedFiles.length > 0 ? [...attachedFiles] : [];
    const basePrompt =
      trimmed ||
      (currentFiles.length > 0
        ? "Please look at the attached file(s)."
        : currentImages
          ? "Please analyze the attached image(s)."
          : "");
    // Read at send time rather than at attach time: the reader may have edited the
    // file since, and the message should carry what is on disk when it is sent.
    const attachmentText =
      currentFiles.length > 0
        ? attachmentBlock(await readAttachments(currentFiles, (path) => readTextFile(path, projectRoot)))
        : "";
    const promptToSend = `${basePrompt}${attachmentText}`;

    if (mode === "agent" || mode === "plan") {
      if (status === "running") {
        // Steering, not a second turn: the runtime takes a message into the turn
        // that is already running. This used to `return` here, so pressing Enter
        // mid-run did nothing at all and said nothing about it.
        if (!onSteerPipeline) return;
        setSteerError(null);
        const failure = await onSteerPipeline(promptToSend);
        if (failure) {
          // The text stays in the composer: a message that did not send must not
          // look like one that did, and retyping it is the tax this avoids.
          setSteerError(failure);
          return;
        }
        const steered: ChatMessage = {
          id: `user-${Date.now()}`,
          role: "user",
          content: promptToSend,
          timestamp: Date.now(),
        };
        setChatMessages((prev) => {
          const next = [...prev, steered];
          saveChatHistory(next, projectRoot);
          return next;
        });
        chatDraft.set("");
        // Attachments are deliberately kept: a steer carries text only, so they
        // were not sent and are still the user's to send with the next turn.
        return;
      }
      const providers = loadAllProviders();
      const activeProvider = selectedModelItem ? providers[selectedModelItem.providerId] : undefined;

      // Extract recent conversation memory for the autonomous agent
      const recentHistory = chatMessages
        .filter((m) => !m.error && m.content)
        .slice(-6)
        .map((m) => ({
          role: m.role,
          content: m.content.slice(0, 1500),
        }));

      planRunRef.current = mode === "plan";
      planFileRef.current = null;
      lastWrittenPlan.current = "";
      setPlanFile(null);
      setPlanWriteSettled(mode !== "plan");
      onRunPipeline(
        promptToSend,
        selectedModelItem
          ? {
              provider: selectedModelItem.providerId,
              model: selectedModelItem.model,
              apiKey: activeProvider?.apiKey,
              baseUrl: activeProvider?.baseUrl,
            }
          : undefined,
        selectedContext?.path || undefined,
        selectedContext?.code || undefined,
        recentHistory,
        currentImages,
        mode === "plan" ? "plan" : "agent"
      );
      // Optional: add a user message to chat history too, so they see what they asked
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: basePrompt,
        images: currentImages,
        attachedPaths: currentFiles.map((file) => file.path),
        timestamp: Date.now(),
      };
      setChatMessages((prev) => {
        const next = [...prev, userMsg];
        saveChatHistory(next, projectRoot);
        return next;
      });
      chatDraft.set("");
      setAttachedImages([]);
      setAttachedFiles([]);
      return;
    }

    // ── Chat Mode: Streaming conversational AI
    if (isStreaming) return;

    if (!selectedModelItem) {
      setChatMessages((prev) => {
        const warning: ChatMessage = {
          id: `warn-${Date.now()}`,
          role: "assistant",
          content: "⚠️ No local AI model is installed or selected. Please pull a model in the AI Management Dashboard to begin chatting.",
          timestamp: Date.now(),
          error: true,
        };
        const updated = [...prev, warning];
        saveChatHistory(updated, projectRoot);
        return updated;
      });
      return;
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: basePrompt,
      images: currentImages,
      attachedPaths: currentFiles.map((file) => file.path),
      timestamp: Date.now(),
    };
    setAttachedFiles([]);

    const assistantMsgId = `assistant-${Date.now()}`;
    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      provider: selectedModelItem.providerId,
      model: selectedModelItem.model,
      isStreaming: true,
    };

    const nextHistory = [...chatMessages, userMsg];
    const withPlaceholder = [...nextHistory, assistantPlaceholder];
    planRunRef.current = false;
    setPlanFile(null);
    setChatMessages(withPlaceholder);
    saveChatHistory(withPlaceholder, projectRoot);
    chatDraft.set("");
    setAttachedImages([]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const providers = loadAllProviders();
    const activeProvider = providers[selectedModelItem.providerId];

    // Chat only, now: plan mode runs on the agent runtime with a read-only
    // sandbox, so its instruction lives in `AGENT_PLAN_INSTRUCTIONS` rather than
    // in a system message prepended here.
    const outgoingMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> =
      nextHistory.map((m) => ({ role: m.role, content: m.content }));

    await streamChatCompletion({
      provider: selectedModelItem.providerId,
      model: selectedModelItem.model,
      messages: outgoingMessages,
      images: currentImages,
      projectRoot,
      // What the reader is looking at. The engine reads these, plus whatever the
      // index says matches the question, so a model that cannot call tools still
      // answers about this project rather than about code in general.
      activePath: selectedContext?.path ?? "",
      selection: selectedContext?.code ?? "",
      baseUrl: activeProvider?.baseUrl,
      apiKey: activeProvider?.apiKey,
      signal: controller.signal,
      onDelta: (delta) => {
        setChatMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, content: msg.content + delta }
              : msg
          )
        );
      },
      onDone: () => {
        setIsStreaming(false);
        setChatMessages((prev) => {
          const updated = prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, isStreaming: false }
              : msg
          );
          saveChatHistory(updated, projectRoot);
          return updated;
        });
      },
      onError: (errMsg) => {
        setIsStreaming(false);
        setChatMessages((prev) => {
          const updated = prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content: msg.content
                    ? `${msg.content}\n\n⚠️ **Error:** ${errMsg}`
                    : `⚠️ **Error:** ${errMsg}`,
                  isStreaming: false,
                  error: true,
                }
              : msg
          );
          saveChatHistory(updated, projectRoot);
          return updated;
        });
      },
    });
  };

  const handleStopStream = () => {
    if (status === "running") {
      onCancelPipeline();
    }
    abortControllerRef.current?.abort();
      setIsStreaming(false);
      setChatMessages((prev) => {
        const updated = prev.map((msg) =>
          msg.isStreaming ? { ...msg, isStreaming: false } : msg
        );
        saveChatHistory(updated, projectRoot);
        return updated;
      });
  };

  const handleClearChat = () => {
    clearChatHistory(projectRoot);
    setChatMessages([]);
  };

  const handleQuickAction = (text: string) => {
    chatDraft.set(text);
    void handleSend(text);
  };

  /**
   * The files attached to the next message, and the picker that adds them.
   *
   * One block for both composers — the centered hero and the docked one — so the
   * two cannot end up with different ideas about what is attached.
   */
  const renderFileContext = () => (
    <>
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-1">
          {attachedFiles.map((file) => (
            <span
              key={file.path}
              data-testid="attached-file"
              title={file.path}
              className="flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded-md bg-zinc-800/80 border border-zinc-700/70 text-2xs text-zinc-200 max-w-[16rem]"
            >
              <Icon icon={FileCode} className="w-3 h-3 text-zinc-400 shrink-0" />
              <span className="truncate font-mono">{file.name}</span>
              <button
                type="button"
                onClick={() => removeFile(file.path)}
                title={`Remove ${file.name}`}
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-700/70 transition-colors cursor-pointer shrink-0"
              >
                <Icon icon={X} className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {isFilePickerOpen && (
        <div
          ref={filePickerRef}
          className="absolute bottom-full mb-2 left-0 w-72 max-h-64 bg-[#18181b]/95 backdrop-blur-xl border border-zinc-700/60 rounded-xl shadow-2xl p-1.5 z-popover flex flex-col"
        >
          <input
            ref={fileQueryInputRef}
            value={fileQuery}
            onChange={(e) => setFileQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setIsFilePickerOpen(false);
              if (e.key === "Enter") {
                const first = filterFiles(projectFileList, fileQuery, 1)[0];
                if (first) attachFile(first.path);
              }
            }}
            placeholder="Filter project files…"
            className="mb-1.5 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-purple-500/60"
          />
          <div className="overflow-y-auto">
            {filterFiles(projectFileList, fileQuery).map((file) => (
              <button
                key={file.path}
                type="button"
                data-testid="file-option"
                onClick={() => attachFile(file.path)}
                title={file.path}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-2xs text-zinc-300 hover:bg-zinc-800/80 hover:text-white transition-colors cursor-pointer"
              >
                <Icon icon={FileCode} className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="truncate font-mono">{file.name}</span>
                <span className="ml-auto truncate text-3xs text-zinc-500 max-w-[8rem]">
                  {file.path.replace(/\/[^/]+$/, "")}
                </span>
              </button>
            ))}
            {projectFileList.length === 0 && (
              <p className="px-2 py-3 text-2xs text-zinc-500">No files in this project yet.</p>
            )}
          </div>
        </div>
      )}
    </>
  );

  const renderModelMenu = (isCenterHero: boolean) => {
    // Every configured model, in every mode. The list used to drop the ones that
    // cannot call tools and print "· 2 hidden", which removed exactly the models a
    // reader might want — a local one, a free one — and left them wondering what
    // was missing. `canRunAgent` is still asked; it just decides how the turn runs
    // (see `effectiveWorkflowMode`) rather than what the reader is allowed to pick.
    const selectedIsChatOnly = Boolean(selectedModelItem) && !selectedModelCanRunAgent;

    const cleanSearch = modelSearchQuery.trim().toLowerCase();
    const filteredModels = cleanSearch
      ? configuredModels.filter(
          (m) =>
            m.model.toLowerCase().includes(cleanSearch) ||
            m.providerName.toLowerCase().includes(cleanSearch)
        )
      : configuredModels;

    return (
      <div
        ref={modelMenuRef}
        className={`absolute ${
          isCenterHero ? "top-full mt-2 left-0 max-w-[calc(100vw-2rem)]" : "bottom-full mb-1.5 right-0 max-w-[calc(100%-0.5rem)]"
        } w-72 max-h-80 bg-[#18181b] border border-zinc-800 rounded-xl shadow-2xl p-2 z-popover flex flex-col text-left`}
      >
        <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-zinc-800/80 shrink-0">
          <span className="text-3xs font-semibold text-zinc-400 uppercase tracking-wider font-mono">
            {workflowMode === "plan" ? "Plan Model" : workflowMode === "chat" ? "Chat Model" : "Agent Model"}
          </span>
          <span className="text-3xs text-zinc-500 font-mono">
            {configuredModels.length} models
          </span>
        </div>

        {/* A note, not a warning: the turn will run, as a chat. Nothing here asks
            the reader to change their mind about the model they picked. */}
        {selectedIsChatOnly && (
          <p className="mb-2 shrink-0 rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-2 text-3xs text-zinc-400 font-sans leading-relaxed">
            <span className="font-mono text-zinc-300">{selectedModelItem!.model}</span> does not call
            tools, so a turn answers in the chat instead of editing files.
          </p>
        )}

        {configuredModels.length > 5 && (
          <div className="mb-2 shrink-0">
            <input
              type="text"
              placeholder="Filter models..."
              value={modelSearchQuery}
              onChange={(e) => setModelSearchQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-100 font-mono placeholder-zinc-500 focus:outline-none focus:border-purple-500/60"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0 pr-0.5">
          {configuredModels.length === 0 ? (
            <div className="px-2.5 py-3 text-center space-y-2">
              <div className="text-xs text-zinc-400 font-sans">No model available</div>
              <p className="text-3xs text-zinc-500 font-sans">
                Add a cloud key, or install a model for{" "}
                <span className="text-emerald-400 font-mono">Ollama</span> to run on this machine.
              </p>
              <p className="text-3xs text-zinc-500 font-sans">
                A local model is free and private, but needs to be one that supports tool
                calling to edit files and run commands.
              </p>
              <button
                type="button"
                onClick={() => {
                  setIsModelMenuOpen(false);
                  openAiManagementDashboard();
                }}
                className="w-full px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold font-sans transition-colors shadow-sm"
              >
                ⚙️ Configure Cloud Keys
              </button>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="px-2.5 py-4 text-center text-xs text-zinc-500 font-mono">
              No models match "{modelSearchQuery}"
            </div>
          ) : (
            filteredModels.map((item) => {
              const isSelected =
                item.model === selectedModelItem?.model && item.providerId === selectedModelItem?.providerId;
              return (
                <button
                  key={`${item.providerId}-${item.model}`}
                  ref={isSelected ? selectedRowRef : undefined}
                  type="button"
                  onClick={() => {
                    handleSelectModel(item);
                    setIsModelMenuOpen(false);
                  }}
                  className={`w-full shrink-0 min-h-[1.75rem] flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    isSelected ? "bg-purple-950/50 text-purple-300 font-semibold" : "text-zinc-300 hover:bg-zinc-800/80"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 truncate">
                    <ProviderLogo providerId={item.providerId} className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate font-mono text-2xs">{item.model}</span>
                    {/* A local model runs on this machine, cannot be as capable as
                        a hosted one, and costs nothing — worth saying in the row. */}
                    {item.category === "local" && (
                      <span className="shrink-0 px-1 py-px rounded text-4xs font-mono uppercase tracking-wide bg-emerald-950/60 text-emerald-400 border border-emerald-900/60">
                        local
                      </span>
                    )}
                  </div>
                  {isSelected && <Icon icon={Check} className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
                </button>
              );
            })
          )}
        </div>

        <div className="pt-1.5 mt-1 border-t border-zinc-800/80 flex items-center justify-between px-1 shrink-0">
          <button
            type="button"
            onClick={() => {
              setIsModelMenuOpen(false);
              openAiManagementDashboard();
            }}
            className="text-3xs text-purple-400 hover:text-purple-300 py-0.5 transition-colors font-mono font-medium flex items-center gap-1"
          >
            <span>⚙️ Configure Cloud Keys & Models</span>
          </button>
        </div>
      </div>
    );
  };

  const renderAddContextMenu = (isCenterHero: boolean) => (
    <div
      className={`absolute ${
        isCenterHero ? "top-full mt-2 left-0" : "bottom-full mb-2 left-0"
      } w-52 bg-[#18181b]/95 backdrop-blur-xl border border-zinc-700/60 rounded-xl shadow-2xl p-1.5 z-popover space-y-0.5 text-left animate-in fade-in-0 zoom-in-95 duration-100`}
    >
      <div className="px-2.5 py-1.5 text-2xs font-semibold text-zinc-400 select-none">
        Add Context
      </div>

      {/* 1: Media */}
      <button
        type="button"
        onClick={() => {
          setIsContextMenuOpen(false);
          fileInputRef.current?.click();
        }}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-zinc-200 hover:bg-zinc-800/80 hover:text-white transition-all group"
      >
        <Icon icon={ImageIcon} className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 shrink-0" />
        <span className="font-medium">Media</span>
      </button>

      {/* 2: Files — this replaced a "Mentions" entry that typed an `@` no one
             handled. A mention is a file reference, so it opens the picker. */}
      <button
        type="button"
        data-testid="add-context-files"
        onClick={() => {
          setIsContextMenuOpen(false);
          setFileQuery("");
          setIsFilePickerOpen(true);
        }}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-zinc-200 hover:bg-zinc-800/80 hover:text-white transition-all group"
      >
        <Icon icon={AtSign} className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 shrink-0" />
        <span className="font-medium">Files</span>
      </button>

      {/* 3: Actions */}
      <button
        type="button"
        onClick={() => {
          setIsContextMenuOpen(false);
          const nextPrompt = draft && !draft.endsWith(" ") ? `${draft} /` : `${draft}/`;
          chatDraft.set(nextPrompt);
          setTimeout(() => textareaRef.current?.focus(), 50);
        }}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-zinc-200 hover:bg-zinc-800/80 hover:text-white transition-all group"
      >
        <svg
          className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="18" height="18" x="3" y="3" rx="2.5" />
          <path d="m9 9 6 6" />
        </svg>
        <span className="font-medium">Actions</span>
      </button>

      {/* 4: Browser */}
      <button
        type="button"
        onClick={() => {
          setIsContextMenuOpen(false);
          const prefix = "/browser ";
          const nextPrompt = draft.startsWith(prefix) ? draft : `${prefix}${draft}`.trimStart();
          chatDraft.set(nextPrompt);
          setTimeout(() => textareaRef.current?.focus(), 50);
        }}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-zinc-200 hover:bg-zinc-800/80 hover:text-white transition-all group"
      >
        <svg
          className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="4" />
          <line x1="21.17" x2="12" y1="8" y2="8" />
          <line x1="3.95" x2="8.54" y1="6.06" y2="14" />
          <line x1="10.88" x2="15.46" y1="21.94" y2="14" />
        </svg>
        <span className="font-medium">Browser</span>
      </button>

      <div className="my-1 border-t border-zinc-800/80" />

      {/* Modes. Codex puts its plan toggle in this same menu rather than behind a
          second popup — one place for "what this turn is", which is what the +
          button already means. Agent is the default, so it is the absence of
          either of these. */}
      {([
        { id: "plan" as const, label: "Plan mode", hint: "Read the project, write the plan", icon: Sparkles, tone: "group-hover:text-amber-300" },
        { id: "chat" as const, label: "Ask mode", hint: "Chat only — no tools", icon: MessageSquare, tone: "group-hover:text-purple-300" },
      ]).map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => {
            setIsContextMenuOpen(false);
            setWorkflowMode((prev) => (prev === entry.id ? "agent" : entry.id));
          }}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-zinc-200 hover:bg-zinc-800/80 hover:text-white transition-all group"
        >
          <Icon icon={entry.icon} className={`w-4 h-4 text-zinc-400 ${entry.tone} shrink-0`} />
          <span className="font-medium">{entry.label}</span>
          <span className="text-3xs text-zinc-500 ml-auto shrink-0">
            {workflowMode === entry.id ? "On" : "Turn on"}
          </span>
        </button>
      ))}
    </div>
  );


  return (
    <div className="h-full w-full flex flex-col bg-[#141416] text-zinc-200 font-sans select-none overflow-hidden border-l border-[var(--vscode-border)]">
      {/* ── Header: Title, Pop-out, Close ───────────────────────────────── */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-[var(--vscode-border)] bg-[#18181b] shrink-0 font-sans">
        <div className="flex items-center gap-2">
          <Icon icon={Bot} className="w-4 h-4 text-purple-400" />
          <span className="text-body font-semibold text-zinc-100 tracking-tight">AI Assistant</span>
          {indexStatus && (
            <div className="flex items-center gap-1.5 ml-1">
              {isIndexing ? (
                <span className="flex items-center gap-1 text-3xs text-accent bg-primary-action/10 px-2 py-0.5 rounded-full border border-accent/20 animate-pulse font-mono">
                  <Icon icon={RefreshCw} className="w-2.5 h-2.5 animate-spin" />
                  Indexing AST...
                </span>
              ) : indexStatus.indexed ? (
                <button
                  type="button"
                  onClick={onSyncIndex}
                  title={`Project Code Intelligence:
• Files synced: ${indexStatus.profile?.indexed_files ?? "--"}
• Symbols indexed: ${indexStatus.totalSymbols}
• Frameworks: ${indexStatus.profile?.frameworks?.join(", ") || "generic"}
Click to re-index project.`}
                  className="flex items-center gap-1 text-3xs text-emerald-400 bg-emerald-950/30 hover:bg-emerald-900/40 px-2 py-0.5 rounded-full border border-emerald-800/40 transition-colors font-mono cursor-pointer"
                >
                  <Icon icon={Database} className="w-2.5 h-2.5" />
                  <span>{indexStatus.profile?.indexed_files ?? 0} files synced</span>
                </button>
            ) : (
              <button
                  type="button"
                  onClick={onSyncIndex}
                  className="text-3xs text-amber-400 bg-amber-950/30 hover:bg-amber-900/40 px-2 py-0.5 rounded-full border border-amber-800/40 transition-colors font-mono cursor-pointer"
                  title="Click to build AST symbol index"
                >
                  Index AST
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {chatMessages.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearChat(true)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Clear Conversation"
            >
              <Icon icon={Trash2} className="w-3.5 h-3.5" />
            </button>
          )}

          {onPopOutWide && (
            <button
              type="button"
              onClick={onPopOutWide}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title={isWide ? "Dock to Side Tool Window" : "Open in Center Stage Editor Tab"}
            >
              <Icon icon={isWide ? Minimize2 : Maximize2} className="w-3.5 h-3.5" />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Close AI Assistant (Cmd+L)"
            >
              <Icon icon={X} className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Main Scroll Area ────────────────────────────────────────────── */}
      <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto p-4 font-sans">
        {/* ── 1. Chat Mode Content ──────────────────────────────────────── */}
        <>
          {/* Empty State / Welcome Screen */}
          {chatMessages.length === 0 && status !== "running" && (
            isWide ? (
              /* Center Stage Hero Mode (Full Canvas Omnibar) */
              <div className="h-full min-h-[460px] flex flex-col items-center justify-center p-6">
                <div className="w-full max-w-2xl space-y-4">
                  {/* Context pill strip */}
                  <div className="flex items-center justify-between px-1 text-xs text-zinc-400">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-900/90 border border-zinc-800 text-zinc-300">
                        <Icon icon={Folder} className="w-3 h-3 text-purple-400" />
                        <span className="font-mono text-2xs">{projectName}</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-900/90 border border-zinc-800 text-zinc-300">
                        <Icon icon={GitBranch} className="w-3 h-3 text-emerald-400" />
                        <span className="font-mono text-2xs">{branch || "—"}</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-900/90 border border-zinc-800 text-zinc-400">
                      <ProviderLogo providerId={effectiveProvider} className="w-3 h-3" />
                      <span className="font-mono text-2xs text-zinc-300">{effectiveModel}</span>
                    </div>
                  </div>

                  {/* Centered Floating Hero Omnibar Card */}
                  <div className="relative rounded-2xl bg-[#1c1c24]/95 backdrop-blur-xl border border-zinc-700/60 shadow-2xl p-4 space-y-3">
                    {renderFileContext()}
                    {/* Attached Image Previews */}
                    {attachedImages.length > 0 && (
                      <div className="space-y-2 pb-1">
                        <div className="flex items-center gap-2 overflow-x-auto pb-1">
                          {attachedImages.map((img, idx) => (
                            <div key={idx} className="relative group shrink-0 rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800">
                              <img src={img} alt="Attachment" className="w-14 h-14 object-cover" />
                              <button
                                type="button"
                                onClick={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
                                className="absolute top-0.5 right-0.5 bg-black/80 hover:bg-red-600 text-white rounded-full p-0.5 transition-colors cursor-pointer"
                                title="Remove image"
                              >
                                <Icon icon={X} className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>

                        {/* Non-vision model indicator */}
                        {!isCurrentModelVisionCapable && (
                          <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 text-xs animate-in fade-in-0 duration-150">
                            <div className="flex items-center gap-2 min-w-0">
                              <Icon icon={AlertCircle} className="w-4 h-4 text-amber-400 shrink-0" />
                              <span className="truncate">
                                <strong className="font-semibold text-amber-200">{selectedModelItem?.model || "Current model"}</strong> is text-only. Attached image(s) will be omitted.
                              </span>
                            </div>
                            {bestVisionAlternative && (
                              <button
                                type="button"
                                onClick={() => {
                                  handleSelectModel(bestVisionAlternative);
                                }}
                                className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 hover:text-white font-medium text-2xs transition-colors cursor-pointer shrink-0 whitespace-nowrap flex items-center gap-1"
                              >
                                <span>Switch to {bestVisionAlternative.model}</span>
                                <span>→</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(e) => {
                        chatDraft.set(e.target.value);
                        // "@" is how every other editor starts a file reference.
                        if (e.target.value.endsWith("@")) setIsFilePickerOpen(true);
                      }}
                      onPaste={handlePaste}
                      onDragOver={handleImageDragOver}
                      onDragLeave={handleImageDragLeave}
                      onDrop={handleComposerDrop}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSend();
                        }
                      }}
                      placeholder={
                        isImageDragOver
                          ? "Drop the image to attach it…"
                          : workflowMode === "agent"
                          ? "Describe a task for the agent to build, edit, or test… (Enter to run)"
                          : workflowMode === "plan"
                          ? "Brainstorm an architectural plan or discuss design decisions… (Enter)"
                          : "Ask anything, / for commands, @ for context (Enter to send)"
                      }
                      rows={3}
                      className={`w-full bg-transparent border-0 text-sm text-zinc-100 placeholder-zinc-500 outline-none resize-none font-sans leading-relaxed focus:ring-0 p-1 ${
                        isImageDragOver ? "rounded-lg ring-2 ring-purple-500/50 bg-purple-500/5" : ""
                      }`}
                    />

                    {/* Bottom control bar inside card */}
                    <div className="flex items-center justify-between pt-2.5 border-t border-zinc-800/80">
                      <div className="flex items-center gap-2">
                        {/* Add Context (+) Dropdown */}
                        <div className="relative shrink-0" ref={heroContextMenuRef}>
                          <button
                            type="button"
                            onClick={() => {
                              setIsContextMenuOpen((prev) => !prev);
                                                      setIsModelMenuOpen(false);
                            }}
                            className={`p-1.5 rounded-lg border transition-colors ${
                              isContextMenuOpen
                                ? "bg-zinc-800 text-zinc-100 border-zinc-700"
                                : "bg-zinc-800/40 hover:bg-zinc-800/80 border-zinc-800/80 text-zinc-400 hover:text-zinc-200"
                            }`}
                            title="Add Context (Media, Files, Actions, Browser)"
                          >
                            <Icon icon={Plus} className="w-3.5 h-3.5" />
                          </button>
                          {isContextMenuOpen && renderAddContextMenu(true)}
                        </div>

                        {/* An active mode, as a chip you can dismiss. Agent is the
                            default and shows nothing: a label that is present every
                            time is not a label, it is furniture. */}
                        {workflowMode !== "agent" && (
                          <button
                            type="button"
                            onClick={() => setWorkflowMode("agent")}
                            title={modeChipTitle}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/40 text-amber-200 text-xs font-medium transition-all shadow-sm"
                          >
                            <Icon icon={X} className="w-3 h-3 shrink-0" />
                            <span className="font-sans text-2xs">{workflowMode === "plan" ? "Plan" : "Ask"}</span>
                          </button>
                        )}


                        {/* Model Selector Pill */}
                        <div className="relative" ref={heroMenuRef}>
                          <button
                            type="button"
                            onClick={() => {
                              setIsModelMenuOpen((prev) => !prev);
                                                    }}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/80 border border-zinc-800/80 text-xs text-zinc-200 font-medium transition-all shadow-sm"
                            title={modelTitle}
                          >
                            <ProviderLogo providerId={effectiveProvider} className="w-3.5 h-3.5 shrink-0" />
                            <span className="font-mono text-2xs">{effectiveModel}</span>
                            <Icon icon={ChevronDown} className="w-3 h-3 text-zinc-400" />
                          </button>

                          {isModelMenuOpen && renderModelMenu(true)}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleSend()}
                        disabled={!draft.trim()}
                        className={`flex items-center justify-center w-8 h-8 rounded-xl transition-all shadow-sm ${
                          draft.trim()
                            ? "bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20"
                            : "bg-zinc-800/40 border border-zinc-800/80 text-zinc-500 cursor-not-allowed"
                        }`}
                        title={workflowMode === "agent" ? "Run Agent (Enter)" : "Send (Enter)"}
                      >
                        <Icon icon={ArrowUp} className="w-4 h-4 stroke-[2.5]" />
                      </button>
                    </div>
                  </div>

                  {/* Prompt suggestion chips */}
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => handleQuickAction("Give me a breakdown of the recent changes in this project.")}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800 text-xs text-zinc-300 hover:text-white transition-all group"
                    >
                      <Icon icon={GitCommit} className="w-3.5 h-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
                      <span>Recent changes breakdown</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleQuickAction("Explain the architecture and main components of this codebase.")}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800 text-xs text-zinc-300 hover:text-white transition-all group"
                    >
                      <Icon icon={Code} className="w-3.5 h-3.5 text-purple-400 group-hover:scale-110 transition-transform" />
                      <span>Explain project architecture</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleQuickAction("How do I test and verify recent modifications in this workspace?")}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800 text-xs text-zinc-300 hover:text-white transition-all group"
                    >
                      <Icon icon={CheckCircle2} className="w-3.5 h-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
                      <span>Test & verification guide</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Compact Side Dock Empty State */
              <div className="space-y-5 max-w-xl mx-auto py-2">
                <div>
                  <h2 className="text-sm font-bold text-zinc-100 tracking-tight flex items-center gap-2">
                    <span>ACSA Code AI Assistant</span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-1">
                    Ask questions, request code reviews, generate components, or inspect recent changes.
                  </p>
                </div>

                {/* Quick Action Suggestions */}
                <div className="space-y-2">
                  <span className="text-3xs font-semibold text-zinc-400 uppercase tracking-wider font-mono">
                    Suggested Prompts
                  </span>
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => handleQuickAction("Give me a breakdown of the recent changes in this project.")}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/80 text-left transition-all group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon icon={GitCommit} className="w-4 h-4 text-emerald-400 shrink-0 group-hover:scale-110 transition-transform" />
                        <span className="text-xs font-medium text-zinc-200 group-hover:text-zinc-100 truncate">
                          Give me a breakdown of the recent changes
                        </span>
                      </div>
                      <span className="text-xs text-zinc-500 group-hover:text-zinc-300 shrink-0">›</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleQuickAction("Explain the architecture and main components of this codebase.")}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/80 text-left transition-all group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon icon={Code} className="w-4 h-4 text-purple-400 shrink-0 group-hover:scale-110 transition-transform" />
                        <span className="text-xs font-medium text-zinc-200 group-hover:text-zinc-100 truncate">
                          Explain project architecture & key files
                        </span>
                      </div>
                      <span className="text-xs text-zinc-500 group-hover:text-zinc-300 shrink-0">›</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleQuickAction("How do I test and verify recent modifications in this workspace?")}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/80 text-left transition-all group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon icon={CheckCircle2} className="w-4 h-4 text-amber-400 shrink-0 group-hover:scale-110 transition-transform" />
                        <span className="text-xs font-medium text-zinc-200 group-hover:text-zinc-100 truncate">
                          How to test and verify recent modifications
                        </span>
                      </div>
                      <span className="text-xs text-zinc-500 group-hover:text-zinc-300 shrink-0">›</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          )}

          {/* Conversation Messages */}
        <ChatTranscript
          chatMessages={chatMessages}
          undoMessageId={undoMessageId}
          undoBusy={undoBusy}
          undoNotice={undoNotice}
          onUndo={handleUndo}
          isWide={isWide}
          status={status}
          streamingAnswer={streamingAnswer}
          streamingThought={streamingThought}
          agentSteps={agentSteps}
          agentElapsedMs={turnElapsedMs}
          turnLimitMinutes={turnLimitMinutes}
          currentAgentPhase={currentAgentPhase}
          blockedOn={blockedOn}
          turnChanges={turnChanges}
          pendingQuestion={pendingQuestion}
          selectedModelItem={selectedModelItem}
          onReviewFile={onReviewFile}
          onCancelPipeline={onCancelPipeline}
          bottomRef={chatBottomRef}
        />

        {/* Under the plan it refers to, and only once that plan is on disk. It is
            not in the composer: a control there is present before anything has been
            planned, which is how it came to start a write-enabled turn naming a file
            that did not exist. */}
        {planFile && !isStreaming && (
          <p className="px-3 pb-1 shrink-0 text-3xs text-zinc-400" data-testid="plan-note">
            {planFile.ok
              ? "Plan written to implementation-plan.md — the agent can implement it from there."
              : "The plan is above, but implementation-plan.md could not be written."}
          </p>
        )}
        {planFile?.ok === true && !isStreaming && (
          <div className="px-3 pb-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setWorkflowMode("agent");
                void handleSend(IMPLEMENT_PLAN_PROMPT, "agent");
              }}
              title="Switch to agent mode and implement implementation-plan.md"
              className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-colors shadow-sm"
            >
              <Icon icon={Wrench} className="w-3.5 h-3.5 shrink-0" />
              <span className="font-sans">Implement plan</span>
            </button>
          </div>
        )}
        </>
      </div>

      {/* ── Input Box & Controls (Only shown when not in empty Center Stage mode) ── */}
      {(!isWide || chatMessages.length > 0 || status === "running") && (
        <div
          ref={composerRef}
          className={`p-3 border-t border-[var(--vscode-border)] bg-[#18181b] shrink-0 font-sans ${isWide ? "py-4" : ""}`}
        >
          <div className={isWide ? "max-w-3xl lg:max-w-4xl mx-auto w-full" : "w-full"}>
            {/* Why a steer did not send. Above the input, where the text it
                refers to still is — the message is kept, so this explains rather
                than reports a loss. */}
            {steerError && (
              <div
                role="alert"
                data-testid="steer-error"
                className="mb-2 flex items-start gap-2 rounded-xl border border-amber-500/50 bg-amber-950/40 px-3 py-2 text-2xs leading-relaxed text-amber-100"
              >
                <Icon icon={AlertCircle} className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300" />
                <span className="break-words">{steerError}</span>
              </div>
            )}
            {/* The agent is blocked until this is answered. */}
            {/* A question, not a permission request. The runtime's own
                `request_user_input` carries options and free text, and the answer
                goes back keyed by question id — rendered as an approval card it
                read "APPROVAL NEEDED … $ item/tool/requestUserInput", which told
                the user nothing and could not be answered correctly. */}
            {pendingQuestion && pendingQuestion.questions.length > 0 && (
              <div
                data-pending-card
                role="alertdialog"
                aria-modal="false"
                aria-labelledby="agent-question-heading"
                tabIndex={-1}
                className="mb-3 p-3 rounded-2xl bg-[#111827]/95 border border-purple-500/60 shadow-2xl backdrop-blur-xl max-h-[45vh] overflow-y-auto focus:outline-none"
              >
                <div className="flex items-center gap-2 text-purple-300 font-semibold text-2xs tracking-wider uppercase mb-2">
                  <Icon icon={HelpCircle} className="w-3.5 h-3.5 text-purple-300 shrink-0" />
                  <span id="agent-question-heading">The agent is asking</span>
                </div>
                {pendingQuestion.questions.map((question) => (
                  <div key={question.id} className="mb-3 last:mb-1">
                    <p className="text-xs font-semibold text-zinc-100">{question.header}</p>
                    <p className="text-2xs text-zinc-400 mt-0.5 mb-2 leading-relaxed">
                      {question.question}
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {(question.options ?? []).map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          onClick={() => answerQuestion(question.id, [option.label])}
                          className="text-left px-3 py-1.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 border border-zinc-700 hover:border-purple-500/50 text-zinc-200 text-xs transition-colors cursor-pointer"
                        >
                          {option.label}
                          {option.description ? (
                            <span className="block text-3xs text-zinc-500 mt-0.5">
                              {option.description}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                    {question.isOther && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const field = event.currentTarget.elements.namedItem(
                            "answer",
                          ) as HTMLInputElement | null;
                          const value = field?.value.trim() ?? "";
                          if (!value) return;
                          if (field) field.value = "";
                          answerQuestion(question.id, [value]);
                        }}
                        className="mt-2 flex items-center gap-2"
                      >
                        <input
                          name="answer"
                          type={question.isSecret ? "password" : "text"}
                          placeholder="Or type your own answer…"
                          className="flex-1 bg-black/50 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-purple-500/60"
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors cursor-pointer"
                        >
                          Answer
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}

            {pendingApproval && (
              <div
                data-pending-card
                role="alertdialog"
                aria-modal="false"
                aria-labelledby="agent-approval-heading"
                tabIndex={-1}
                className="mb-3 p-3 rounded-2xl bg-[#1c1917]/95 border border-amber-500/60 shadow-2xl backdrop-blur-xl max-h-[45vh] overflow-y-auto focus:outline-none"
              >
                <div className="flex items-center gap-2 text-amber-400 font-semibold text-2xs tracking-wider uppercase mb-1.5">
                  <Icon icon={Shield} className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span id="agent-approval-heading">Approval needed</span>
                </div>
                <p className="text-xs text-zinc-300 mb-2 leading-relaxed">
                  {pendingApproval.reason ||
                    `The agent wants to ${approvalSummary(pendingApproval.method)} before it continues.`}
                </p>
                {/* Only when there is one. A file-change approval carries no
                    command and no paths, so there is nothing honest to put here. */}
                {pendingApproval.command ? (
                <div className="flex items-center gap-2 p-2 rounded-xl bg-black/80 border border-zinc-800 font-mono text-2xs text-emerald-400 overflow-x-auto select-all mb-2.5">
                  <Icon icon={Terminal} className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span className="text-zinc-500 select-none">$</span>
                  <span>{pendingApproval.command}</span>
                </div>
                ) : null}
                {/* A file-change approval names an item, not a command. Showing
                    the diff is the difference between approving a change and
                    approving a mystery — which is what the bare itemId gave. */}
                {pendingApproval.changes && pendingApproval.changes.length > 0 ? (
                  <div className="mb-2.5 space-y-1.5">
                    {pendingApproval.changes.map((change) => (
                      <div
                        key={change.path}
                        className="rounded-xl border border-zinc-800 bg-black/60 overflow-hidden"
                      >
                        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-800">
                          <span
                            className={
                              change.kind === "add"
                                ? "text-3xs font-mono uppercase text-emerald-400"
                                : change.kind === "delete"
                                ? "text-3xs font-mono uppercase text-red-400"
                                : "text-3xs font-mono uppercase text-amber-400"
                            }
                          >
                            {change.kind}
                          </span>
                          <span
                            className="text-2xs font-mono text-zinc-300 truncate"
                            title={change.path}
                          >
                            {change.path}
                          </span>
                        </div>
                        {change.diff ? (
                          <pre className="max-h-40 overflow-auto px-2.5 py-1.5 text-3xs leading-relaxed text-zinc-400 whitespace-pre font-mono">
                            {change.diff}
                          </pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void respondToApproval?.("decline")}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-all border border-zinc-700 cursor-pointer"
                  >
                    <Icon icon={X} className="w-3.5 h-3.5 text-red-400" />
                    <span>Decline</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void respondToApproval?.("acceptForSession")}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-all border border-zinc-700 cursor-pointer"
                  >
                    <Icon icon={Shield} className="w-3.5 h-3.5 text-amber-400" />
                    <span>Allow for session</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void respondToApproval?.("accept")}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium shadow-lg transition-all cursor-pointer"
                  >
                    <Icon icon={Check} className="w-3.5 h-3.5" />
                    <span>Approve &amp; run</span>
                  </button>
                </div>
              </div>
            )}

            {/* Unified Omnibar Input Card */}
            <div className="relative rounded-2xl bg-zinc-900/90 border border-zinc-800/90 focus-within:border-purple-500/50 focus-within:ring-1 focus-within:ring-purple-500/20 p-2.5 transition-all shadow-lg">
              {renderFileContext()}
              {/* Attached Image Previews */}
              {attachedImages.length > 0 && (
                <div className="space-y-1.5 pb-2">
                  <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    {attachedImages.map((img, idx) => (
                      <div key={idx} className="relative group shrink-0 rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800">
                        <img src={img} alt="Attachment" className="w-14 h-14 object-cover" />
                        <button
                          type="button"
                          onClick={() => setAttachedImages((prev) => prev.filter((_, i) => i !== idx))}
                          className="absolute top-0.5 right-0.5 bg-black/80 hover:bg-red-600 text-white rounded-full p-0.5 transition-colors cursor-pointer"
                          title="Remove image"
                        >
                          <Icon icon={X} className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Non-vision model indicator */}
                  {!isCurrentModelVisionCapable && (
                    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 text-2xs animate-in fade-in-0 duration-150">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Icon icon={AlertCircle} className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="truncate">
                          <strong className="font-semibold text-amber-200">{selectedModelItem?.model || "Current model"}</strong> is text-only.
                        </span>
                      </div>
                      {bestVisionAlternative && (
                        <button
                          type="button"
                          onClick={() => {
                            handleSelectModel(bestVisionAlternative);
                          }}
                          className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 hover:text-white font-medium text-3xs transition-colors cursor-pointer shrink-0 whitespace-nowrap"
                        >
                          Switch to {bestVisionAlternative.model} →
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  chatDraft.set(e.target.value);
                  if (e.target.value.endsWith("@")) setIsFilePickerOpen(true);
                }}
                onPaste={handlePaste}
                onDragOver={handleImageDragOver}
                onDragLeave={handleImageDragLeave}
                onDrop={handleComposerDrop}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={
                  workflowMode === "agent"
                    ? "Describe a task for the agent to build, edit, or test… (Enter to run)"
                    : workflowMode === "plan"
                    ? "Brainstorm an architectural plan or discuss design decisions… (Enter)"
                    : `Ask ${selectedModelItem?.model || "AI"} anything… (Shift+Enter for new line)`
                }
                rows={2}
                className={`w-full bg-transparent border-0 text-xs text-zinc-100 placeholder-zinc-500 outline-none resize-none font-sans leading-relaxed focus:ring-0 p-0.5 ${
                  isImageDragOver ? "rounded-lg ring-2 ring-purple-500/50 bg-purple-500/5" : ""
                }`}
              />

              {/* Bottom control strip inside card */}
              <div className="relative flex items-center justify-between gap-1.5 pt-2 border-t border-zinc-800/70 mt-1">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {/* Add Context (+) Dropdown */}
                  <div className="relative shrink-0" ref={contextMenuRef}>
                    <button
                      type="button"
                      onClick={() => {
                        setIsContextMenuOpen((prev) => !prev);
                                          setIsModelMenuOpen(false);
                      }}
                      className={`p-1 rounded-md border transition-colors shrink-0 ${
                        isContextMenuOpen
                          ? "bg-zinc-800 text-zinc-100 border-zinc-700"
                          : "bg-zinc-800/40 hover:bg-zinc-800/80 border-zinc-800/80 text-zinc-400 hover:text-zinc-200"
                      }`}
                      title="Add Context (Media, Files, Actions, Browser)"
                    >
                      <Icon icon={Plus} className="w-3.5 h-3.5" />
                    </button>
                    {isContextMenuOpen && renderAddContextMenu(false)}
                  </div>

                  {/* Active mode as a dismissable chip; see the hero composer. */}
                  {workflowMode !== "agent" && (
                    <button
                      type="button"
                      onClick={() => setWorkflowMode("agent")}
                      title={modeChipTitle}
                      className="relative shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/40 text-amber-200 text-xs font-medium transition-all"
                    >
                      <Icon icon={X} className="w-3 h-3 shrink-0" />
                      <span className="font-sans text-2xs">{workflowMode === "plan" ? "Plan" : "Ask"}</span>
                    </button>
                  )}


                  {/* Model Selector Dropdown Button */}
                  <div className="relative min-w-0 flex-1" ref={menuRef}>
                    <button
                      type="button"
                      onClick={() => {
                        setIsModelMenuOpen((prev) => !prev);
                                        }}
                      className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800/40 hover:bg-zinc-800/80 border border-zinc-800/80 text-xs text-zinc-200 transition-colors"
                      title={modelTitle}
                    >
                      <ProviderLogo providerId={effectiveProvider} className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-mono text-3xs truncate">
                        {effectiveModel}
                      </span>
                      <Icon icon={ChevronDown} className="w-3 h-3 text-zinc-400 shrink-0 ml-auto" />
                    </button>

                  </div>

                </div>

                {/* Right: Send / Stop icon button */}
                <div className="flex items-center gap-1 shrink-0">
                  {(isStreaming || status === "running") ? (
                    <>
                      {/* Steering. The composer used to offer only Stop while a
                          turn ran, so a message typed mid-run had nowhere to go
                          and Enter did nothing at all. Text only: the runtime
                          accepts images in a steer, this command does not send
                          them, and saying so beats dropping them. */}
                      <button
                        type="button"
                        onClick={() => handleSend()}
                        disabled={!draft.trim()}
                        className={`flex items-center justify-center w-7 h-7 rounded-lg transition-all shadow-sm shrink-0 ${
                          draft.trim()
                            ? "bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20 cursor-pointer"
                            : "bg-zinc-800/40 border border-zinc-800/80 text-zinc-500 cursor-not-allowed"
                        }`}
                        title={
                          draft.trim()
                            ? "Send into the running turn (Enter) — text only"
                            : "Type a message to steer the running turn"
                        }
                        aria-label="Steer the running turn"
                      >
                        <Icon icon={ArrowUp} className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                      <button
                        type="button"
                        onClick={handleStopStream}
                        className="flex items-center justify-center w-7 h-7 rounded-lg bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-red-300 transition-colors shadow-sm"
                        title="Stop Generation"
                      >
                        <Icon icon={Square} className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSend()}
                      disabled={!draft.trim() && attachedImages.length === 0}
                      className={`flex items-center justify-center w-7 h-7 rounded-lg transition-all shadow-sm shrink-0 ${
                        draft.trim() || attachedImages.length > 0
                          ? "bg-purple-600 hover:bg-purple-500 text-white shadow-purple-600/20 cursor-pointer"
                          : "bg-zinc-800/40 border border-zinc-800/80 text-zinc-500 cursor-not-allowed"
                      }`}
                      title={workflowMode === "agent" ? "Run Agent (Enter)" : "Send (Enter)"}
                    >
                      <Icon icon={ArrowUp} className="w-3.5 h-3.5 stroke-[2.5]" />
                    </button>
                  )}
                </div>

                {/* Anchored to the whole control strip rather than the pill. The
                    pill wrapper is capped at 150px, so a 288px menu hung off the
                    side of a narrow chat panel and was clipped — which is what
                    "the picker UI is broken" was. Against the strip, `max-w` is a
                    percentage of the composer and the menu always fits. */}
                {isModelMenuOpen && renderModelMenu(false)}
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmClearChat && (
        <ConfirmDialog
          isOpen={true}
          title="Clear Conversation"
          message="Are you sure you want to clear the entire chat history? This cannot be undone."
          confirmText="Clear Chat"
          cancelText="Cancel"
          isDestructive={true}
          onConfirm={() => {
            handleClearChat();
            setConfirmClearChat(false);
          }}
          onCancel={() => setConfirmClearChat(false)}
        />
      )}

      {/* Hidden File Input for Image Attachments */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleImageFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/* ── 1-Click Message Copy Button ────────────────────────────────────────── */
export function CopyMessageButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy message to clipboard"
      className={`inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded transition-all select-none cursor-pointer ${
        copied
          ? "text-emerald-400 bg-emerald-950/40 border border-emerald-800/50"
          : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/80 border border-transparent"
      } ${className}`}
    >
      {copied ? (
        <>
          <Icon icon={Check} className="w-3 h-3 text-emerald-400" />
          <span className="font-medium text-3xs">Copied</span>
        </>
      ) : (
        <>
          <Icon icon={Copy} className="w-3 h-3" />
          <span className="font-medium text-3xs">Copy</span>
        </>
      )}
    </button>
  );
}

function getStepCategory(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("plan") || lower.includes("architect")) {
    return { icon: ListTodo, color: "text-amber-400 bg-amber-500/10 border-amber-500/20", label: "PLAN" };
  }
  if (lower.startsWith("subagent:") || lower.includes("swarm")) {
    return { icon: Users, color: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20", label: "SWARM" };
  }
  if (lower.includes("syntax") || lower.includes("gate") || lower.includes("healing") || lower.includes("verif")) {
    return { icon: Shield, color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20", label: "VERIFY" };
  }
  if (lower.includes("grep") || lower.includes("search") || lower.includes("find")) {
    return { icon: Search, color: "text-blue-400 bg-blue-500/10 border-blue-500/20", label: "SEARCH" };
  }
  if (lower.includes("run") || lower.includes("command") || lower.includes("bash")) {
    return { icon: Terminal, color: "text-orange-400 bg-orange-500/10 border-orange-500/20", label: "SHELL" };
  }
  if (lower.startsWith("tool:") || lower.includes("read") || lower.includes("edit")) {
    return { icon: Wrench, color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20", label: "TOOL" };
  }
  return { icon: Code2, color: "text-purple-400 bg-purple-500/10 border-purple-500/20", label: "AGENT" };
}

const INTERNAL_FRAMEWORK_STEPS = new Set([
  "git intelligence",
  "scale detection",
  "intent analysis",
  "agent engine",
  "architect plan",
  "agent setup",
  "model reasoning",
  "agent completed",
  "agent guidance",
  "verification",
]);

/* ── Collapsible Thinking & Steps Accordion ───────────────────────────── */
interface ThinkingAccordionProps {
  steps?: AgentStep[];
  thinking?: string;
  isLive?: boolean;
  hasSummary?: boolean;
  elapsedSeconds?: number;
  /** The run is blocked on the user, so it is not thinking. */
  blockedOn?: string;
}

/**
 * "Edited N files  +X −Y", with a row per file and a Review on each.
 *
 * The answer to "should every write need approval?" is no — log it instead. On
 * the message rather than only in live state, so it scrolls back with the
 * transcript; a log you can only read once is not a log.
 */
function ChangeLogCard({
  changes,
  onReview,
}: {
  changes: { path: string; added: number; removed: number }[];
  onReview?: (path: string) => Promise<void>;
}) {
  if (changes.length === 0) return null;
  const added = changes.reduce((total, change) => total + change.added, 0);
  const removed = changes.reduce((total, change) => total + change.removed, 0);

  return (
    <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-zinc-800">
        <span className="text-2xs text-zinc-300">
          Edited {changes.length} {changes.length === 1 ? "file" : "files"}
        </span>
        <span className="flex items-center gap-3 font-mono text-2xs">
          <span className="text-emerald-400">+{added}</span>
          <span className="text-red-400">−{removed}</span>
        </span>
      </div>
      {changes.map((change) => (
        <button
          key={change.path}
          type="button"
          onClick={() => void onReview?.(change.path)}
          title={`Review ${change.path}`}
          className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-zinc-900/70 transition-colors cursor-pointer"
        >
          <span className="text-2xs font-mono text-zinc-400 truncate">{change.path}</span>
          <span className="flex items-center gap-3 font-mono text-2xs shrink-0">
            {change.added > 0 && <span className="text-emerald-400">+{change.added}</span>}
            {change.removed > 0 && <span className="text-red-400">−{change.removed}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

function ThinkingAccordion({
  steps = NO_STEPS,
  thinking = "",
  isLive = false,
  hasSummary = false,
  elapsedSeconds = 0,
  blockedOn = "",
}: ThinkingAccordionProps) {
  // Auto-collapse if a summary or conclusion has been reached
  const [isOpen, setIsOpen] = useState(() => isLive && !hasSummary);

  const prevLiveRef = useRef(isLive);
  const prevSummaryRef = useRef(hasSummary);

  useEffect(() => {
    // When a conclusion/summary is delivered, auto-collapse the thinking loop
    if (!prevSummaryRef.current && hasSummary) {
      setIsOpen(false);
    }
    // When live execution finishes, auto-collapse
    if (prevLiveRef.current && !isLive) {
      setIsOpen(false);
    } else if (!prevLiveRef.current && isLive && !hasSummary) {
      setIsOpen(true);
    }
    prevLiveRef.current = isLive;
    prevSummaryRef.current = hasSummary;
  }, [isLive, hasSummary]);

  const effectiveSteps = isLive
    ? steps
    : steps.map((s) => (s.status === "running" ? { ...s, status: "done" as const } : s));

  // Filter out vague internal Python lifecycle milestones (Git Intelligence, Scale Detection, etc.)
  // Only surface actionable user-facing steps (Read File, Edit File, Search Codebase, Syntax Gate, etc.)
  const visibleSteps = effectiveSteps.filter((s) => {
    const name = (s.name || "").trim().toLowerCase();
    return !INTERNAL_FRAMEWORK_STEPS.has(name);
  });

  const cleanedThought = cleanThoughtText(thinking);

  if (visibleSteps.length === 0 && !cleanedThought && !isLive) {
    return null;
  }

  const activeStep = visibleSteps.find((s) => s.status === "running") || visibleSteps[visibleSteps.length - 1];
  const completedCount = visibleSteps.filter((s) => s.status === "done" || s.status === "success").length;

  return (
    <div className="mb-2.5 rounded-xl border border-zinc-800/80 bg-zinc-950/50 overflow-hidden text-xs transition-all">
      {/* Header Bar */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-900/60 hover:bg-zinc-900/90 text-left transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon
            icon={isOpen ? ChevronDown : ChevronRight}
            className="w-3.5 h-3.5 text-zinc-400 shrink-0"
          />
          {isLive && !hasSummary ? (
            <div className="flex items-center gap-2 min-w-0">
              {/* A blocked run is not thinking, and a spinner that keeps turning
                  is what made a six-minute wait look like hard work. */}
              <Icon
                icon={blockedOn ? HelpCircle : RefreshCw}
                className={`w-3 h-3 shrink-0 ${
                  blockedOn ? "text-amber-400" : "text-purple-400 animate-spin"
                }`}
              />
              <span
                className={`font-semibold font-mono text-2xs ${
                  blockedOn ? "text-amber-300" : "text-purple-300"
                }`}
              >
                {blockedOn ? `Waiting for ${blockedOn} (${elapsedSeconds}s)` : `Thinking (${elapsedSeconds}s)…`}
              </span>
              {activeStep && (
                <span className="text-3xs text-zinc-400 truncate hidden sm:inline">
                  · {activeStep.name}
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <Icon icon={Sparkles} className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span className="font-semibold text-zinc-300 font-mono text-2xs">
                {elapsedSeconds > 0
                  ? `Thought for ${elapsedSeconds}s`
                  : visibleSteps.length > 0
                  ? "What the agent did"
                  : "Model Reasoning"}
              </span>
              {visibleSteps.length > 0 && (
                <span className="text-3xs text-zinc-500 font-mono">
                  ({completedCount}/{visibleSteps.length} {visibleSteps.length === 1 ? "step" : "steps"})
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 text-3xs text-zinc-500 font-mono">
          <span className="px-1.5 py-0.5 rounded bg-zinc-800/60 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors">
            {isOpen ? "Hide reasoning" : "View reasoning"}
          </span>
        </div>
      </button>

      {/* Expanded Drawer */}
      {isOpen && (
        <div className="p-3 space-y-3 border-t border-zinc-800/60 bg-zinc-950/80">
          {/* Actionable Steps Checklist (Tool calls, Syntax checks, Subagents) */}
          {visibleSteps.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-3xs font-semibold uppercase tracking-wider text-zinc-500 font-mono mb-1">
                Execution Steps
              </div>
              <div className="space-y-1 pl-1">
                {visibleSteps.map((step, idx) => {
                  const isRunning = isLive && step.status === "running";
                  const isSuccess = step.status === "done" || step.status === "success";
                  const isFailed = step.status === "failed";
                  const category = getStepCategory(step.name);

                  return (
                    <div
                      key={idx}
                      className={`flex items-start gap-2 text-2xs py-1 px-1.5 rounded transition-colors ${
                        isRunning
                          ? "bg-purple-950/20 text-purple-200"
                          : isSuccess
                          ? "text-zinc-300 hover:bg-zinc-900/40"
                          : isFailed
                          ? "bg-red-950/20 text-red-300"
                          : "text-zinc-500"
                      }`}
                    >
                      <div className="mt-0.5 shrink-0 flex items-center gap-1.5">
                        {isRunning ? (
                          <Icon icon={RefreshCw} className="w-3 h-3 text-purple-400 animate-spin" />
                        ) : isSuccess ? (
                          <Icon icon={CheckCircle2} className="w-3 h-3 text-emerald-400" />
                        ) : isFailed ? (
                          <Icon icon={X} className="w-3 h-3 text-red-400" />
                        ) : (
                          <span className="inline-block w-2 h-2 rounded-full bg-zinc-700 mx-0.5" />
                        )}
                        <span className={`px-1 py-0.5 text-4xs font-mono uppercase font-semibold rounded border inline-flex items-center gap-1 ${category.color}`}>
                          <Icon icon={category.icon} className="w-2.5 h-2.5" />
                          {category.label}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className={`font-medium ${isRunning ? "text-purple-200" : "text-zinc-200"}`}>
                          {step.name}
                        </span>
                        {step.detail && (
                          <span className="text-3xs text-zinc-400 ml-1.5 font-mono break-all">
                            — {step.detail}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Model Thoughts / Streaming Reasoning */}
          {cleanedThought && (
            <div className="space-y-1">
              <div className="text-3xs font-semibold uppercase tracking-wider text-zinc-500 font-mono">
                Model Thoughts
              </div>
              <div className="p-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800 text-2xs font-mono text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                {cleanedThought}
                {isLive && <span className="inline-block w-1.5 h-3 bg-purple-400 ml-1 animate-pulse align-middle" />}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Formatted Markdown & Code Block Renderer ─────────────────────────── */
/**
 * Memoised on purpose. The composer's text lives above the whole workbench, so
 * every keystroke re-renders this component for every message in the transcript;
 * without the memo each one re-parsed its markdown and rebuilt its code blocks.
 * Same on the streaming path, where the growing message used to re-render every
 * code block it already had on each token.
 */
const FormattedMarkdown = memo(function FormattedMarkdown({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  if (!content && isStreaming) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-xs py-1">
        <Icon icon={RefreshCw} className="w-3 h-3 animate-spin text-purple-400" />
        <span>Thinking…</span>
      </div>
    );
  }

  // Split content by code blocks: ```lang ... ```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-2 leading-relaxed">
      {parts.map((part, idx) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const firstLineEnd = part.indexOf("\n");
          const lang = part.slice(3, firstLineEnd > 0 ? firstLineEnd : 3).trim() || "code";
          const code = firstLineEnd > 0 ? part.slice(firstLineEnd + 1, -3) : part.slice(3, -3);
          return <CodeBlock key={idx} language={lang} code={code} />;
        }

        // Render formatted text lines
        return <FormattedParagraph key={idx} text={part} />;
      })}
      {isStreaming && (
        <span className="inline-block w-1.5 h-3.5 bg-purple-400 ml-0.5 animate-pulse align-middle" />
      )}
    </div>
  );
});

const FormattedParagraph = memo(function FormattedParagraph({ text }: { text: string }) {
  const lines = text.split("\n");

  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1.5" />;

        // Headings: ###
        if (trimmed.startsWith("### ")) {
          return (
            <h4 key={i} className="text-xs font-bold text-zinc-100 pt-1">
              {trimmed.slice(4)}
            </h4>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={i} className="text-xs font-bold text-white pt-1">
              {trimmed.slice(3)}
            </h3>
          );
        }

        // List item: - or *
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div key={i} className="flex items-start gap-1.5 ml-2">
              <span className="text-purple-400 font-bold">•</span>
              <span>{renderInlineStyles(trimmed.slice(2))}</span>
            </div>
          );
        }

        // Numbered list: 1.
        if (/^\d+\.\s/.test(trimmed)) {
          return (
            <div key={i} className="ml-2">
              {renderInlineStyles(trimmed)}
            </div>
          );
        }

        // Blockquote: >
        if (trimmed.startsWith("> ")) {
          return (
            <div key={i} className="bg-purple-500/10 border border-purple-500/20 rounded-md px-3 py-1.5 text-zinc-300 italic">
              {renderInlineStyles(trimmed.slice(2))}
            </div>
          );
        }

        return <div key={i}>{renderInlineStyles(line)}</div>;
      })}
    </div>
  );
});

function renderInlineStyles(text: string) {
  // Support inline `code` and **bold**
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

  return (
    <>
      {tokens.map((token, index) => {
        if (token.startsWith("`") && token.endsWith("`")) {
          return (
            <code
              key={index}
              className="px-1 py-0.5 rounded bg-zinc-800 text-purple-300 font-mono text-2xs"
            >
              {token.slice(1, -1)}
            </code>
          );
        }
        if (token.startsWith("**") && token.endsWith("**")) {
          return (
            <strong key={index} className="font-bold text-white">
              {token.slice(2, -2)}
            </strong>
          );
        }
        return token;
      })}
    </>
  );
}

const CodeBlock = memo(function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden my-2 font-mono text-2xs">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800/80 text-zinc-400">
        <span className="text-3xs font-semibold uppercase">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-3xs text-zinc-400 hover:text-white transition-colors"
        >
          {copied ? <Icon icon={Check} className="w-3 h-3 text-emerald-400" /> : <Icon icon={Copy} className="w-3 h-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-zinc-200 leading-relaxed font-mono whitespace-pre">
        {code}
      </pre>
    </div>
  );
});

export default AiAssistantChat;
