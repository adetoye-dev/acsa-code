import { GitBranch, Activity, AlertCircle, FileCode, Cpu, HardDrive, Database, RefreshCw } from "lucide-react";
import { Icon } from "../ui/Icon";
import type { ProjectIndexState } from "../../hooks/usePipeline";
import { useSystemMetrics } from "../../hooks/useSystemMetrics";

export interface StatusBarProps {
  gitBranch: string;
  encoding?: string;
  cursorPosition?: string;
  indexStatus?: ProjectIndexState;
  isIndexing?: boolean;
  onSyncIndex?: () => void;
  /**
   * Non-empty while the agent is stopped waiting on the user — the runtime's own
   * status name (`waitingOnApproval` / `waitingOnUserInput`).
   */
  agentBlockedOn?: string;
}

/**
 * The runtime's status name, in words.
 *
 * This is surfaced in the status bar rather than only inside the chat because a
 * run parked on an approval used to be invisible from anywhere else: the
 * reported symptom was a run that sat blocked for about six minutes with nothing
 * on screen to say why, and the only way to find out was the accessibility tree.
 */
export function blockedLabel(status: string): string {
  if (status === "waitingOnApproval") return "Agent waiting for your approval";
  if (status === "waitingOnUserInput") return "Agent waiting for your answer";
  return "Agent waiting for you";
}

export function StatusBar({
  gitBranch,
  encoding = "UTF-8",
  cursorPosition = "Ln 1, Col 1",
  indexStatus,
  isIndexing = false,
  onSyncIndex,
  agentBlockedOn = "",
}: StatusBarProps) {
  // Fetched here rather than handed down: see hooks/useSystemMetrics.ts for why a
  // host metric should not re-render the workbench three times a second.
  const metrics = useSystemMetrics();
  const formatMetric = (value?: number) => value === undefined ? "--" : `${Math.round(value)}%`;

  return (
    <div className="h-[24px] bg-canvas border-t border-hairline flex items-center justify-between px-4 text-xs text-muted select-none w-full">
      <div className="flex items-center space-x-4">
        {/* Always present, so the announcement fires when the text appears rather
            than when the region is inserted. */}
        <div role="status" aria-live="polite" className="flex items-center">
          {agentBlockedOn ? (
            <span className="flex items-center space-x-1 text-amber-300 font-medium">
              <Icon icon={AlertCircle} className="w-3.5 h-3.5" />
              <span>{blockedLabel(agentBlockedOn)}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center space-x-1">
          <Icon icon={GitBranch} className="w-3.5 h-3.5" />
          <span>{gitBranch}</span>
        </div>
        <div className="flex items-center space-x-1">
          <span>{cursorPosition}</span>
        </div>
        <div className="flex items-center space-x-1">
          <Icon icon={FileCode} className="w-3.5 h-3.5" />
          <span>{encoding}</span>
        </div>

        {/* ── AST Code Intelligence Indexer Badge ── */}
        <div className="h-3.5 w-px bg-hairline/80 mx-1" />
        {isIndexing ? (
          <div className="flex items-center space-x-1.5 text-accent animate-pulse" title="AST Code Indexing in progress...">
            <Icon icon={RefreshCw} className="w-3.5 h-3.5 animate-spin text-accent" />
            <span className="font-mono text-2xs">Indexing AST...</span>
          </div>
        ) : indexStatus?.indexed ? (
          <button
            type="button"
            onClick={onSyncIndex}
            className="flex items-center space-x-1.5 text-xs text-muted hover:text-foreground transition-colors cursor-pointer group"
            title={`Project Code Intelligence:
• Files synced: ${indexStatus.profile?.indexed_files ?? "--"}
• Symbols indexed: ${indexStatus.totalSymbols} across project
• Frameworks: ${indexStatus.profile?.frameworks?.join(", ") || "generic"}
Click to re-index project.`}
          >
            <Icon icon={Database} className="w-3.5 h-3.5 text-muted group-hover:scale-110 transition-transform" />
            <span className="group-hover:underline font-mono text-2xs">{indexStatus.profile?.indexed_files ?? 0} files synced</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onSyncIndex}
            className="flex items-center space-x-1 text-xs text-amber-400/80 hover:text-amber-400 cursor-pointer"
            title="Click to build AST symbol index for instant code intelligence"
          >
            <Icon icon={Database} className="w-3.5 h-3.5" />
            <span className="text-2xs">Index Project</span>
          </button>
        )}
      </div>
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-1" title={metrics?.cpu_count ? `${metrics.cpu_count} CPU Cores` : undefined}>
          <Icon icon={Cpu} className="w-3.5 h-3.5" />
          <span>CPU: {formatMetric(metrics?.cpu_usage_percent)}</span>
        </div>
        <div className="flex items-center space-x-1" title={metrics?.memory_used_mb && metrics?.memory_total_mb ? `${metrics.memory_used_mb} MB / ${metrics.memory_total_mb} MB (${Math.round(metrics.memory_usage_percent)}%)` : undefined}>
          <Icon icon={Activity} className="w-3.5 h-3.5" />
          <span>RAM: {formatMetric(metrics?.memory_usage_percent)}</span>
        </div>
        <div
          className="flex items-center space-x-1"
          title={
            metrics?.disk_used_gb !== undefined && metrics?.disk_total_gb !== undefined
              ? `${metrics.disk_used_gb.toFixed(1)} GB used of ${metrics.disk_total_gb.toFixed(1)} GB${
                  metrics.disk_free_gb !== undefined ? ` (${metrics.disk_free_gb.toFixed(1)} GB free)` : ""
                }`
              : undefined
          }
        >
          <Icon icon={HardDrive} className="w-3.5 h-3.5" />
          <span>Disk: {formatMetric(metrics?.disk_usage_percent)}</span>
        </div>
      </div>
    </div>
  );
}
