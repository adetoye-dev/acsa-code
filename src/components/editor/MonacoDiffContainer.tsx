/**
 * MonacoDiffContainer.tsx — the diff surface: agent patches, and git.
 *
 * This drives `monaco.editor.createDiffEditor` itself rather than going through
 * `@monaco-editor/react`'s `<DiffEditor/>`. Two reasons, both about disposal:
 *
 *  * The library disposes a diff editor's models *before* the editor, and Monaco
 *    treats that as a bug of its own making — it subscribes to each model's
 *    `onWillDispose` and reports "TextModel got disposed before DiffEditorWidget
 *    model got reset" for every unmount. Unmounting is not an edge case: it is
 *    what happens when a selection goes back to nothing, when the repository page
 *    is left, or when React re-runs an effect.
 *  * Disposal order is therefore ours to get right: the widget first, then the
 *    models it was showing. That is the order Monaco's own usage documents.
 *
 * The models are per-instance and never shared, so a surface can never be handed
 * another surface's text or free a model someone else is still diffing.
 */

import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import "../../monacoSetup";
import { Check, X, Menu } from "lucide-react";
import { Icon } from "../ui/Icon";
import { applyMonacoTheme } from "../../services/themeManager";
import { PANE_EDITOR_OPTIONS } from "../../services/monacoPaneOptions";

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

/** Which language Monaco highlights a diff in, from the file it came from. */
function getLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".rs")) return "rust";
  return "plaintext";
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel | null;
    modified: monaco.editor.ITextModel | null;
  }>({ original: null, modified: null });

  /**
   * The props as they were when this surface mounted.
   *
   * The editor is created once per mount, so its effect must not depend on the
   * text — otherwise every keystroke in a file being diffed would rebuild it. The
   * content effects below are what follow the props afterwards.
   */
  const initial = useRef({ originalContent, modifiedContent, filePath });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { originalContent: originalText, modifiedContent: modifiedText, filePath: path } =
      initial.current;
    const language = getLanguage(path);

    // Defined before an editor asks for it by name.
    applyMonacoTheme(monaco, "github-dark");
    const original = monaco.editor.createModel(originalText, language);
    const modified = monaco.editor.createModel(modifiedText, language);
    const editor = monaco.editor.createDiffEditor(host, {
      renderSideBySide: true,
      fontSize: 13,
      fontFamily: "var(--ide-font-family, 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace)",
      lineNumbers: "on",
      // Same pane rules as the editor: re-measure on resize, and keep hovers and
      // hints from being clipped at the pane's edge.
      ...PANE_EDITOR_OPTIONS,
      scrollBeyondLastLine: false,
      readOnly: true,
      minimap: { enabled: false },
      theme: "github-dark",
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;
    modelsRef.current = { original, modified };

    return () => {
      // Widget first, then the models it was showing: the reverse order is the
      // reported bug this component exists to avoid.
      editor.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
      modelsRef.current = { original: null, modified: null };
    };
  }, []);

  /** The text follows the props; the models and the editor stay put. */
  useEffect(() => {
    const model = modelsRef.current.original;
    if (model && !model.isDisposed() && model.getValue() !== originalContent) {
      model.setValue(originalContent);
    }
  }, [originalContent]);

  useEffect(() => {
    const model = modelsRef.current.modified;
    if (model && !model.isDisposed() && model.getValue() !== modifiedContent) {
      model.setValue(modifiedContent);
    }
  }, [modifiedContent]);

  /** Another file means another language, not another editor. */
  useEffect(() => {
    const language = getLanguage(filePath);
    const { original, modified } = modelsRef.current;
    if (original && !original.isDisposed()) monaco.editor.setModelLanguage(original, language);
    if (modified && !modified.isDisposed()) monaco.editor.setModelLanguage(modified, language);
  }, [filePath]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide });
  }, [renderSideBySide]);

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
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}

export default MonacoDiffContainer;
