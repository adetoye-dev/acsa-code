/**
 * MonacoDiffContainer.tsx — Real Monaco Diff Inspector
 *
 * Renders unified or side-by-side git diffs using @monaco-editor/react's <DiffEditor />.
 * Allows developers to review autonomous agent patches with exact VS Code diff decorations.
 */

import { useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import "../../monacoSetup";
import { Check, X, Menu } from "lucide-react";
import { Icon } from "../ui/Icon";
import { applyMonacoTheme } from "../../services/themeManager";

interface MonacoDiffContainerProps {
  originalContent: string;
  modifiedContent: string;
  filePath: string;
  /**
   * The container's own toolbar — the file name, the inline/side-by-side
   * toggle, and any accept/reject actions.
   *
   * A host that already heads the diff with the file's path and what the two
   * sides are (the repository page does) turns this off, so the pane does not
   * say its own name twice. Standalone tabs keep it, since it is their only
   * chrome.
   */
  showToolbar?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
}

export function MonacoDiffContainer({
  originalContent,
  modifiedContent,
  filePath,
  showToolbar = true,
  onAccept,
  onReject,
}: MonacoDiffContainerProps) {
  const [renderSideBySide, setRenderSideBySide] = useState(true);

  /**
   * Memoised for the same reason as the editor's: an inline literal changes
   * identity on every render, and `@monaco-editor/react` answers that with
   * `editor.updateOptions(...)` every time.
   */
  const diffOptions = useMemo(
    () => ({
      renderSideBySide,
      fontSize: 13,
      fontFamily: "var(--ide-font-family, 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace)",
      lineNumbers: "on" as const,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      readOnly: true,
      minimap: { enabled: false },
    }),
    [renderSideBySide]
  );

  const getLanguage = (path: string): string => {
    if (path.endsWith(".py")) return "python";
    if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
    if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
    if (path.endsWith(".json")) return "json";
    if (path.endsWith(".md")) return "markdown";
    if (path.endsWith(".rs")) return "rust";
    return "plaintext";
  };

  return (
    <div className="flex flex-col h-full w-full bg-workbench overflow-hidden select-none">
      {/* Diff Toolbar */}
      {showToolbar && (
        <div className="flex items-center justify-between px-4 py-2 bg-workbench border-b border-hairline text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-300">Diff Review:</span>
            <span className="font-mono text-zinc-400">{filePath || "patch.diff"}</span>
          </div>

          <div className="flex items-center gap-2">
            {/* Toggle Side-by-side vs Inline */}
            <button
              type="button"
              onClick={() => setRenderSideBySide(!renderSideBySide)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-workbench hover:bg-workbench border border-hairline text-zinc-300 text-xs transition-colors"
              title={renderSideBySide ? "Switch to Inline View" : "Switch to Side-by-Side View"}
            >
              {renderSideBySide ? (
                <>
                  <Icon icon={Menu} className="w-3.5 h-3.5" />
                  <span>Inline</span>
                </>
              ) : (
                <>
                  <Icon icon={Menu} className="w-3.5 h-3.5" />
                  <span>Side-by-Side</span>
                </>
              )}
            </button>

            {onReject && (
              <button
                type="button"
                onClick={onReject}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-950/60 hover:bg-red-900 border border-red-800 text-red-300 text-xs font-medium transition-colors"
              >
                <Icon icon={X} className="w-3.5 h-3.5" />
                <span>Reject</span>
              </button>
            )}

            {onAccept && (
              <button
                type="button"
                onClick={onAccept}
                className="flex items-center gap-1 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold shadow-sm transition-colors"
              >
                <Icon icon={Check} className="w-3.5 h-3.5" />
                <span>Accept Patch</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Monaco Diff Editor Surface */}
      <div className="flex-1 overflow-hidden">
        <DiffEditor
          height="100%"
          width="100%"
          language={getLanguage(filePath)}
          original={originalContent}
          modified={modifiedContent}
          theme="github-dark"
          beforeMount={(monaco) => {
            applyMonacoTheme(monaco, "github-dark");
          }}
          options={diffOptions}
        />
      </div>
    </div>
  );
}

export default MonacoDiffContainer;
