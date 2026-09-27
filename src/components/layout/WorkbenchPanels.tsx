/**
 * WorkbenchPanels.tsx — the components dockview actually renders.
 *
 * These are module-level constants on purpose. Dockview captures the component
 * function when a panel is created and treats a new function identity as a new
 * component type, so a map of inline arrows rebuilt on every render means a new
 * *type* for every panel, every render. A stable map also stops dockview from
 * re-running `updateOptions` (and a full layout pass) on each workbench render.
 *
 * Because these live at module scope they cannot close over workbench state —
 * they read it from WorkbenchContext instead, which is also the only way an
 * open panel can see a file change. See WorkbenchContext.tsx.
 */
import { lazy, useCallback } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { AssetPreview } from "../editor/AssetPreview";
import { LazySurface } from "../ui/LazySurface";
import { useWorkbench } from "./WorkbenchContext";
import { DESKTOP_REQUIRED_MESSAGE } from "../../services/engineBridge";

/* Lazily-loaded heavy surfaces: Monaco dominates the bundle but is not needed
   to paint the workbench, so each of these defers until a tab needs it. They stay
   module constants so the identity React and dockview see never changes. */
const MonacoEditorContainer = lazy(() =>
  import("../editor/MonacoEditorContainer").then((m) => ({ default: m.MonacoEditorContainer }))
);
const MonacoDiffContainer = lazy(() =>
  import("../editor/MonacoDiffContainer").then((m) => ({ default: m.MonacoDiffContainer }))
);

/** Image / asset preview tab. Self-contained: it needs only its panel params. */
const AssetPreviewPanel = (props: IDockviewPanelProps<{ filePath: string; isTauri: boolean; projectRoot?: string }>) => (
  <AssetPreview {...props} />
);

/** Monaco code editor tab. */
const EditorPanel = (props: IDockviewPanelProps<{ filePath: string }>) => {
  const live = useWorkbench();
  const updateTabContent = live.updateTabContent;
  const tab = live.openTabs.find((t) => t.path === props.params.filePath);
  const target = live.targetEditorLine;
  const tabPath = tab?.path ?? "";

  // Stable, so the memo around MonacoEditorContainer actually holds: an editor
  // the user is not typing in must not re-render because this one changed.
  const handleChange = useCallback(
    (newVal: string) => updateTabContent(tabPath, newVal),
    [updateTabContent, tabPath]
  );

  if (!tab) {
    return (
      <div className="h-full w-full flex items-center justify-center text-zinc-500 text-xs bg-[var(--vscode-editor-bg)]">
        File closed
      </div>
    );
  }

  return (
    <LazySurface label="editor">
      <MonacoEditorContainer
        path={tab.path}
        content={tab.content}
        onChange={handleChange}
        onSave={live.saveFile}
        aiSettings={live.aiSettings}
        themeId={live.themeId}
        targetLine={target?.path === tab.path ? target.line : undefined}
        targetColumn={target?.path === tab.path ? target.column : undefined}
        revealTrigger={target?.path === tab.path ? target.ts : undefined}
        onSelectionChange={live.onSelectionChange}
        projectRoot={live.projectRoot}
      />
    </LazySurface>
  );
};

/** Monaco diff viewer tab — the run's patch, or a file's git diff. */
const DiffPanel = (
  props: IDockviewPanelProps<{
    filePath?: string;
    originalContent?: string;
    modifiedContent?: string;
    isGit?: boolean;
  }>
) => {
  const live = useWorkbench();
  const isGit = props.params?.isGit;
  const original = isGit ? (props.params?.originalContent ?? "") : "";
  const modified = isGit ? (props.params?.modifiedContent ?? "") : live.currentDiff;
  const path = isGit ? (props.params?.filePath ?? "git.diff") : "patch.diff";

  return (
    <LazySurface label="diff viewer">
      <MonacoDiffContainer
        originalContent={original}
        modifiedContent={modified}
        filePath={path}
        onAccept={async () => {
          if (path && path !== "patch.diff" && path !== "git.diff") {
            try {
              if (live.isTauriAvailable) {
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("write_file_content", {
                  filePath: path,
                  content: modified,
                  projectRoot: live.projectRoot,
                });
              } else {
                throw new Error(DESKTOP_REQUIRED_MESSAGE);
              }
              live.applyPatchToTab(path, modified);
            } catch (err) {
              console.error("Failed to write accepted patch to disk:", err);
            }
          }
          props.api.close();
          live.setCurrentDiff("");
          live.refreshProjectFiles();
          live.refreshBranch();
        }}
        onReject={() => {
          props.api.close();
          live.setCurrentDiff("");
        }}
      />
    </LazySurface>
  );
};

/**
 * The map handed to `<DockviewReact components={…}>`. Module-level, so every
 * panel sees the same component identities for the life of the process.
 */
export const WORKBENCH_PANELS = {
  assetPreview: AssetPreviewPanel,
  editor: EditorPanel,
  diff: DiffPanel,
};
