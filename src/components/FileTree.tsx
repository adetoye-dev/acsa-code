/**
 * FileTree.tsx — Project File Explorer Component
 *
 * Renders an interactive, recursive directory tree for the active project.
 * Supports expanding/collapsing folders, creating files/directories,
 * opening files into editor tabs, and highlighting modified/blast-radius files.
 */

import { useState, useMemo, useEffect } from "react";
import { Trash2, Plus, ChevronRight, FolderPlus, ChevronDown, RefreshCw, Folder, X, ChevronsDownUp, Copy } from "lucide-react";
import { Icon } from "./ui/Icon";
import { ConfirmDialog } from './ui/ConfirmDialog';

import { FileIcon } from "./ui/FileIcon";

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
  /** Last write time, ms since the epoch. 0 when the platform cannot say. */
  modified_ms?: number;
  children?: FileNode[];
}

export interface FolderOption {
  path: string;
  label: string;
}

const HIDDEN_NAMES = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "__pycache__",
  ".acsa",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".eslintcache",
  "context-index.json",
  ".context-index.json",
  "context_index.json",
  ".context-index",
  ".context_index",
  "Thumbs.db",
]);

export function isHiddenFileOrDir(name: string): boolean {
  if (HIDDEN_NAMES.has(name)) return true;
  const lower = name.toLowerCase();
  return (
    lower === "__pycache__" ||
    lower === ".acsa" ||
    lower.endsWith("_cache") ||
    lower.startsWith(".cache") ||
    lower.includes("context-index") ||
    lower.includes("context_index") ||
    lower.endsWith(".pyc") ||
    lower.endsWith(".pyo") ||
    lower.endsWith(".bak") ||
    lower.endsWith(".orig") ||
    lower === ".ds_store" ||
    lower === "thumbs.db"
  );
}

export function filterHiddenNodes(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((node) => !isHiddenFileOrDir(node.name))
    .map((node) => {
      if (node.children && node.children.length > 0) {
        return {
          ...node,
          children: filterHiddenNodes(node.children),
        };
      }
      return node;
    });
}

export function collectFolders(nodes: FileNode[], baseProjectDir?: string): FolderOption[] {
  const list: FolderOption[] = [{ path: "", label: "/ (Project Root)" }];

  function traverse(items: FileNode[]) {
    for (const item of items) {
      if (isHiddenFileOrDir(item.name)) continue;
      if (item.is_dir) {
        let rel = item.path;
        if (baseProjectDir && rel.startsWith(baseProjectDir)) {
          rel = rel.slice(baseProjectDir.length).replace(/^[/\\]+/, "");
        }
        list.push({
          path: item.path,
          label: rel ? `/${rel}` : item.name,
        });
        if (item.children && item.children.length > 0) {
          traverse(item.children);
        }
      }
    }
  }

  traverse(nodes);
  return list;
}

interface FileTreeProps {
  files: FileNode[];
  activeFilePath: string | null;
  onSelectFile: (file: FileNode) => void;
  onCreateFile: (parentPath: string, name: string, isDir: boolean) => void;
  onDeleteFile: (path: string) => void;
  onRefresh: () => void;
  onOpenFolder?: () => void;
  projectName: string;
  projectPath?: string;
  touchedPaths?: string[];
}

/**
 * A stable empty list. `touchedPaths = []` in the parameter list would hand back a
 * new array every render, and a new array is enough to make a memoised child below
 * fail its comparison forever — the trap that silently cost the chat transcript
 * its memo.
 */
const NO_TOUCHED_PATHS: string[] = [];

export function FileTree({
  files,
  activeFilePath,
  onSelectFile,
  onCreateFile,
  onDeleteFile,
  onRefresh,
  onOpenFolder,
  projectName,
  projectPath,
  touchedPaths = NO_TOUCHED_PATHS,
}: FileTreeProps) {
  // Default: ALL directories COLLAPSED (Set is empty)
  // Restores user-expanded directories from localStorage if available
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    try {
      const key = `acsa_expanded_dirs_${projectName || "default"}`;
      const stored = localStorage.getItem(key);
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) {
          return new Set<string>(arr);
        }
      }
    } catch {}
    return new Set<string>();
  });

  const [newEntryModal, setNewEntryModal] = useState<{
    parentPath: string;
    isDir: boolean;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; isDir: boolean } | null>(null);
  const [newEntryName, setNewEntryName] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FileNode;
  } | null>(null);

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  // Clamp context menu inside viewport
  const contextMenuPos = useMemo(() => {
    if (!contextMenu) return null;
    const menuWidth = 180;
    const menuHeight = contextMenu.node.is_dir ? 190 : 130;
    const x = Math.min(contextMenu.x, window.innerWidth - menuWidth - 10);
    const y = Math.min(contextMenu.y, window.innerHeight - menuHeight - 10);
    return { x: Math.max(10, x), y: Math.max(10, y) };
  }, [contextMenu]);

  // Persist expanded directories on change
  useEffect(() => {
    try {
      const key = `acsa_expanded_dirs_${projectName || "default"}`;
      localStorage.setItem(key, JSON.stringify(Array.from(expandedDirs)));
    } catch {}
  }, [expandedDirs, projectName]);

  // Auto-expand parent folders of active file so it is visible in the tree
  useEffect(() => {
    if (!activeFilePath) return;
    const lastSlash = Math.max(activeFilePath.lastIndexOf("/"), activeFilePath.lastIndexOf("\\"));
    if (lastSlash <= 0) return;
    const parentDir = activeFilePath.slice(0, lastSlash);

    setExpandedDirs((prev) => {
      let p = parentDir;
      let changed = false;
      const next = new Set(prev);
      while (p) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
        const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        if (slash <= 0) break;
        p = p.slice(0, slash);
      }
      return changed ? next : prev;
    });
  }, [activeFilePath]);

  const visibleFiles = useMemo(() => filterHiddenNodes(files || []), [files]);

  const folderOptions = useMemo(() => {
    return collectFolders(visibleFiles, projectPath);
  }, [visibleFiles, projectPath]);

  const getDefaultParentPath = (): string => {
    if (activeFilePath) {
      const lastSlash = Math.max(activeFilePath.lastIndexOf("/"), activeFilePath.lastIndexOf("\\"));
      if (lastSlash > 0) {
        return activeFilePath.slice(0, lastSlash);
      }
    }
    return "";
  };

  const getPreviewPath = (parentPath: string, name: string) => {
    const cleanName = name.replace(/^[/\\]+/, "");
    if (!parentPath) return `/${cleanName}`;
    let rel = parentPath;
    if (projectPath && rel.startsWith(projectPath)) {
      rel = rel.slice(projectPath.length).replace(/^[/\\]+/, "");
    }
    return rel ? `/${rel}/${cleanName}` : `/${cleanName}`;
  };

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const collapseAll = () => {
    setExpandedDirs(new Set());
    try {
      const key = `acsa_expanded_dirs_${projectName || "default"}`;
      localStorage.removeItem(key);
    } catch {}
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEntryModal || !newEntryName.trim()) return;

    let targetParent = newEntryModal.parentPath;
    let targetName = newEntryName.trim();

    if (targetName.startsWith("/")) {
      targetParent = "";
      targetName = targetName.slice(1);
    }

    onCreateFile(targetParent, targetName, newEntryModal.isDir);
    setNewEntryModal(null);
    setNewEntryName("");
  };

  const renderNode = (node: FileNode, depth = 0) => {
    const isDir = node.is_dir;
    const isExpanded = expandedDirs.has(node.path);
    const isActive = activeFilePath === node.path;
    const isTouched = touchedPaths.some((p) => {
      const rel = p.replace(/^\.?\//, "");
      return node.path === rel || node.path.endsWith(`/${rel}`);
    });

    return (
      <div key={node.path} className="select-none text-body font-sans">
        <div
          role="treeitem"
          aria-selected={isActive}
          aria-expanded={isDir ? expandedDirs.has(node.path) : undefined}
          onClick={() => {
            if (isDir) {
              toggleDir(node.path);
            } else {
              onSelectFile(node);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ x: e.clientX, y: e.clientY, node });
          }}
          onKeyDown={(e) => {
            if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              setConfirmDelete({ path: node.path, isDir });
            }
          }}
          tabIndex={0}
          style={{ paddingLeft: `${depth * 12 + 10}px` }}
          className={`group flex items-center justify-between py-1 pr-2 rounded cursor-pointer transition-colors ${
            isActive
              ? "bg-zinc-800/90 text-zinc-100 font-medium"
              : "text-zinc-300 hover:bg-zinc-800/50 hover:text-white"
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            {isDir ? (
              <span className="text-zinc-400 hover:text-zinc-200">
                {isExpanded ? (
                  <Icon icon={ChevronDown} className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Icon icon={ChevronRight} className="w-3.5 h-3.5 shrink-0" />
                )}
              </span>
            ) : (
              <span className="w-3.5" />
            )}
            <FileIcon fileName={node.name} isDir={isDir} isOpen={isExpanded} className="w-4 h-4 shrink-0" />
            <span className="truncate">{node.name}</span>
            {isTouched && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 ml-1" title="Changed by the agent in this session" />
            )}
          </div>

          {/* Action buttons on hover (Folders only: New File / Folder) */}
          {isDir && (
            <div className="hidden group-hover:flex items-center gap-1">
              <button
                type="button"
                title="New File inside this folder"
                onClick={(e) => {
                  e.stopPropagation();
                  setNewEntryModal({ parentPath: node.path, isDir: false });
                  setNewEntryName("");
                }}
                className="p-0.5 text-zinc-400 hover:text-zinc-200 rounded"
              >
                <Icon icon={Plus} className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="New Folder inside this folder"
                onClick={(e) => {
                  e.stopPropagation();
                  setNewEntryModal({ parentPath: node.path, isDir: true });
                  setNewEntryName("");
                }}
                className="p-0.5 text-zinc-400 hover:text-zinc-200 rounded"
              >
                <Icon icon={FolderPlus} className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Render children if directory is expanded */}
        {isDir && isExpanded && node.children && (
          <div>
            {node.children.length === 0 ? (
              <div
                style={{ paddingLeft: `${(depth + 1) * 12 + 18}px` }}
                className="py-0.5 text-2xs text-zinc-500 italic"
              >
                (empty folder)
              </div>
            ) : (
              node.children.map((child) => renderNode(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full border-r border-zinc-800/80 w-full shrink-0 select-none font-sans">
      {/* Explorer Header */}
      <div className="flex flex-col border-b border-zinc-800/80 bg-zinc-950/40">
        <div className="flex items-center justify-between px-3 py-2 text-zinc-300 text-2xs font-semibold uppercase tracking-wider">
          <span className="truncate" title={projectPath && projectPath !== "." ? projectPath : projectName}>
            {projectName || "EXPLORER"}
          </span>
          <div className="flex items-center gap-1 text-zinc-400">
            <button
              type="button"
              title="New Folder... (Cmd+Shift+N)"
              onClick={() => {
                setNewEntryModal({ parentPath: getDefaultParentPath(), isDir: true });
                setNewEntryName("");
              }}
              className="p-1 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
            >
              <Icon icon={FolderPlus} className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="New File... (Cmd+N)"
              onClick={() => {
                setNewEntryModal({ parentPath: getDefaultParentPath(), isDir: false });
                setNewEntryName("");
              }}
              className="p-1 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
            >
              <Icon icon={Plus} className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="Refresh Explorer"
              onClick={onRefresh}
              className="p-1 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
            >
              <Icon icon={RefreshCw} className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="Collapse All Folders"
              onClick={collapseAll}
              className="p-1 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
            >
              <Icon icon={ChevronsDownUp} className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Project-Scoped File / Folder Creation Panel ──────────────────────── */}
      {newEntryModal && (
        <div className="border-b border-zinc-700/80 bg-workbench p-3 shadow-lg text-body animate-in fade-in slide-in-from-top-2 duration-150 shrink-0 font-sans">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 font-semibold text-zinc-100 text-xs">
              {newEntryModal.isDir ? (
                <Icon icon={FolderPlus} className="w-4 h-4 text-zinc-400" />
              ) : (
                <Icon icon={Plus} className="w-4 h-4 text-zinc-400" />
              )}
              <span>New {newEntryModal.isDir ? "Folder" : "File"} in Project</span>
            </div>
            <button
              type="button"
              onClick={() => setNewEntryModal(null)}
              className="text-zinc-400 hover:text-zinc-200 p-0.5 rounded hover:bg-zinc-800"
              title="Cancel (Esc)"
            >
              <Icon icon={X} className="w-3.5 h-3.5" />
            </button>
          </div>

          <form onSubmit={handleCreateSubmit} className="space-y-2.5">
            {/* Target Location / Destination Folder Dropdown */}
            <div>
              <label htmlFor="filetree-destination-folder-1" className="text-xs text-zinc-300 font-medium block mb-1">
                Destination Folder:
              </label>
              <select id="filetree-destination-folder-1"
                value={newEntryModal.parentPath}
                onChange={(e) =>
                  setNewEntryModal((prev) => (prev ? { ...prev, parentPath: e.target.value } : null))
                }
                className="w-full bg-workbench border border-zinc-700 hover:border-zinc-500 rounded-md px-2.5 py-1.5 text-body text-zinc-100 focus:outline-none focus:border-zinc-500 font-sans cursor-pointer transition-colors"
              >
                {folderOptions.map((opt) => (
                  <option key={opt.path || "root"} value={opt.path}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Name / Subpath Input */}
            <div>
              <label htmlFor="filetree-field-2" className="text-xs text-zinc-300 font-medium block mb-1">
                {newEntryModal.isDir ? "Folder Name (or subpath):" : "File Name (or subpath):"}
              </label>
              <input id="filetree-field-2"
                // The user just asked for this input; focusing it is the point.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                type="text"
                placeholder={
                  newEntryModal.isDir
                    ? "e.g. components or utils/submodule"
                    : "e.g. Button.tsx or helpers/format.ts"
                }
                value={newEntryName}
                onChange={(e) => setNewEntryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setNewEntryModal(null);
                  }
                }}
                className="w-full bg-workbench border border-zinc-700 hover:border-zinc-500 rounded-md px-2.5 py-1.5 text-body text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 font-sans transition-colors"
              />
            </div>

            {/* Live Destination Path Preview */}
            {newEntryName.trim() && (
              <div className="text-3xs text-zinc-400 font-mono bg-black/40 px-2 py-1 rounded border border-white/5 truncate">
                <span className="text-zinc-500">Will create: </span>
                <span className="text-zinc-200">
                  {getPreviewPath(newEntryModal.parentPath, newEntryName.trim())}
                </span>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => setNewEntryModal(null)}
                className="px-2.5 py-1 text-2xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newEntryName.trim()}
                className="px-3 py-1 text-2xs rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium shadow-sm transition-all"
              >
                Create {newEntryModal.isDir ? "Folder" : "File"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* File Tree List */}
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {visibleFiles.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-zinc-500 space-y-2">
            <div>No files in directory.</div>
            {onOpenFolder && (
              <button
                type="button"
                onClick={onOpenFolder}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 mx-auto"
              >
                <Icon icon={Folder} className="w-3.5 h-3.5" />
                <span>Open Project Folder</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setNewEntryModal({ parentPath: "", isDir: false });
                setNewEntryName("main.py");
              }}
              className="mt-1 text-zinc-400 hover:text-white underline block mx-auto text-2xs"
            >
              + Create main.py
            </button>
          </div>
        ) : (
          visibleFiles.map((node) => renderNode(node, 0))
        )}
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && contextMenuPos && (
        <div
          role="presentation"
          style={{ top: contextMenuPos.y, left: contextMenuPos.x }}
          className="fixed z-popover min-w-[170px] bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-lg shadow-2xl p-1 text-xs text-zinc-200 animate-in fade-in zoom-in-95 duration-75 select-none font-sans"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2.5 py-1 text-2xs text-zinc-400 font-mono truncate border-b border-white/5 mb-1 max-w-[200px]">
            {contextMenu.node.name}
          </div>
          {contextMenu.node.is_dir && (
            <>
              <button
                type="button"
                onClick={() => {
                  setNewEntryModal({ parentPath: contextMenu.node.path, isDir: false });
                  setNewEntryName("");
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-white/10 hover:text-white text-left transition-colors"
              >
                <Icon icon={Plus} className="w-3.5 h-3.5 text-zinc-400" />
                <span>New File...</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewEntryModal({ parentPath: contextMenu.node.path, isDir: true });
                  setNewEntryName("");
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-white/10 hover:text-white text-left transition-colors"
              >
                <Icon icon={FolderPlus} className="w-3.5 h-3.5 text-amber-400" />
                <span>New Folder...</span>
              </button>
              <div className="my-1 border-t border-white/10" />
            </>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(contextMenu.node.path);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-white/10 hover:text-white text-left transition-colors"
          >
            <Icon icon={Copy} className="w-3.5 h-3.5 text-zinc-400" />
            <span>Copy Path</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(contextMenu.node.name);
              setContextMenu(null);
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-white/10 hover:text-white text-left transition-colors"
          >
            <Icon icon={Copy} className="w-3.5 h-3.5 text-zinc-400" />
            <span>Copy Name</span>
          </button>
          <div className="my-1 border-t border-white/10" />
          <button
            type="button"
            onClick={() => {
              const p = contextMenu.node.path;
              setContextMenu(null);
              setConfirmDelete({ path: p, isDir: contextMenu.node.is_dir });
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-red-500/20 text-red-400 hover:text-red-300 text-left transition-colors"
          >
            <Icon icon={Trash2} className="w-3.5 h-3.5" />
            <span>Delete...</span>
          </button>
        </div>
      )}

      {confirmDelete && (() => {
        const fileName = confirmDelete.path.split(/[/\\]/).filter(Boolean).pop() || confirmDelete.path;

        return (
          <ConfirmDialog
            isOpen={true}
            title={confirmDelete.isDir ? "Delete Folder" : "Delete File"}
            message={
              <span>
                Are you sure you want to delete{" "}
                <span className="font-semibold text-zinc-100">"{fileName}"</span>? This action cannot be undone.
              </span>
            }
            detail={confirmDelete.path}
            confirmText="Delete"
            cancelText="Cancel"
            isDestructive={true}
            onConfirm={() => {
              onDeleteFile(confirmDelete.path);
              setConfirmDelete(null);
            }}
            onCancel={() => setConfirmDelete(null)}
          />
        );
      })()}
    </div>
  );
}

export default FileTree;
