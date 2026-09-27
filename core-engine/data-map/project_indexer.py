#!/usr/bin/env python3
"""
project_indexer.py — High-Performance AST Symbol & Dependency Indexer

Scans a project directory, extracts all function, class, component, and endpoint
symbols using tree_sitter_cfg, builds structural dependencies (imports and call
relationships), and writes a compact symbol index to `.acsa/index.json`.

Supports:
1. Full project indexing: `python project_indexer.py --project-root <path>`
2. Incremental single-file update: `python project_indexer.py --project-root <path> --file <relative_path>`
3. Query symbols: `python project_indexer.py --project-root <path> --query <symbol_name>`
4. Symbol outline: `python project_indexer.py --project-root <path> --outline <relative_path>`

Zero external dependencies beyond tree_sitter_cfg (which has its own regex fallback).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

# ── Ensure sibling imports work ──────────────────────────────────────────────
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from tree_sitter_cfg import (  # noqa: E402
    FunctionSignature,
    SupportedLanguage,
    parse_file,
)

# One shared setup: the same JSON line to stdout and to a rotating file in the
# data directory, with the component taken from the logger name rather than
# written into a format string per module. See core-engine/log_setup.py.
from log_setup import configure

logger = configure("ProjectIndexer")

# ── Ignored Directories & File Patterns ─────────────────────────────────────
IGNORED_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".acsa",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".cache",
    "dist",
    "build",
    ".tauri",
    "target",
    "tmp",
    "scratch",
}

INDEXABLE_EXTENSIONS = {
    ".py": SupportedLanguage.PYTHON,
    ".ts": SupportedLanguage.TYPESCRIPT,
    ".tsx": SupportedLanguage.TYPESCRIPT,
    ".js": SupportedLanguage.JAVASCRIPT,
    ".jsx": SupportedLanguage.JAVASCRIPT,
    ".go": SupportedLanguage.GO,
    ".rs": SupportedLanguage.RUST,
}


@dataclass
class SymbolEntry:
    name: str
    kind: str  # "function" | "method" | "class" | "component" | "endpoint"
    file_path: str  # relative to project root
    start_line: int
    end_line: int
    signature: str
    docstring: Optional[str] = None
    parameters: list[dict[str, Any]] = field(default_factory=list)
    return_type: Optional[str] = None
    is_async: bool = False


@dataclass
class FileIndex:
    relative_path: str
    language: str
    size_bytes: int
    line_count: int
    content_hash: str
    symbols: list[SymbolEntry] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)


def compute_file_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


# Files this tool used to write into a project and no longer does. They are
# private artifacts, never user content, so a project still carrying them has
# dead bytes and an untracked entry nobody can account for.
RETIRED_STATE_FILES = ("context-index.json", "usage.jsonl", ".context-index.json")

# Everything in `.acsa/` is derived. A `.gitignore` inside the directory ignores
# its own contents, which keeps the folder out of `git status` without editing
# the project's own `.gitignore` — verified: with this file present, git reports
# nothing at all for the directory.
_STATE_GITIGNORE = (
    "# Written by ACSA Code. Everything in here is derived; it is safe to delete.\n*\n"
)


def prepare_state_dir(project_root: Path) -> Path:
    """Create `.acsa/`, keep it out of git, and clear out retired artifacts."""
    acsa_dir = project_root / ".acsa"
    acsa_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Written every time rather than only when absent: it was missing from a
        # real project, and the whole directory then showed as an untracked
        # change. Rewriting a two-line file costs nothing.
        ignore_file = acsa_dir / ".gitignore"
        if not ignore_file.exists() or ignore_file.read_text(encoding="utf-8") != _STATE_GITIGNORE:
            ignore_file.write_text(_STATE_GITIGNORE, encoding="utf-8")
    except OSError as exc:
        logger.warning("Could not write %s: %s", acsa_dir / ".gitignore", exc)

    for name in RETIRED_STATE_FILES:
        stale = acsa_dir / name
        if stale.exists():
            try:
                stale.unlink()
                logger.info("Removed retired state file %s", stale)
            except OSError as exc:
                logger.warning("Could not remove %s: %s", stale, exc)
    return acsa_dir


def write_json_atomic(target: Path, payload: Any) -> None:
    """Write JSON via a temp file + rename so readers never see a partial file.

    The bridge (and any concurrent watcher-triggered incremental update) reads
    this file while it may be rewritten. A plain ``write_text`` is not atomic:
    two overlapping writers interleave and leave concatenated JSON behind, which
    silently breaks the whole index. ``os.replace`` is atomic on POSIX/Windows.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_path = tempfile.mkstemp(dir=str(target.parent), prefix=target.name + ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, indent=2))
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp_path, target)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def extract_imports(content: str, language: str) -> list[str]:
    """Extract imported module/file names using regex."""
    imports: list[str] = []
    lines = content.splitlines()

    if language in ("typescript", "javascript"):
        import_re = re.compile(r"""(?:import\s+(?:(?:[\w*\s{},$]+)\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))""")
        for line in lines:
            line_str = line.strip()
            if line_str.startswith("//"):
                continue
            m = import_re.search(line_str)
            if m:
                target = m.group(1) or m.group(2)
                if target and not target.startswith("node:"):
                    imports.append(target)

    elif language == "python":
        py_import_re = re.compile(r"""^(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))""")
        for line in lines:
            line_str = line.strip()
            if line_str.startswith("#"):
                continue
            m = py_import_re.search(line_str)
            if m:
                target = m.group(1) or m.group(2)
                if target:
                    imports.append(target.strip())

    elif language == "go":
        in_multiline = False
        for line in lines:
            line_str = line.strip()
            if line_str.startswith("//"):
                continue
            if line_str.startswith("import ("):
                in_multiline = True
                continue
            if in_multiline:
                if line_str == ")":
                    in_multiline = False
                    continue
                m = re.search(r'"([^"]+)"', line_str)
                if m:
                    imports.append(m.group(1))
            else:
                m = re.match(r'^import\s+"([^"]+)"', line_str)
                if m:
                    imports.append(m.group(1))

    elif language == "rust":
        rust_use_re = re.compile(r"^use\s+([^;]+);")
        for line in lines:
            line_str = line.strip()
            if line_str.startswith("//"):
                continue
            m = rust_use_re.search(line_str)
            if m:
                target = m.group(1).split("::")[0].strip()
                if target:
                    imports.append(target)

    return sorted(list(set(imports)))


def index_single_file(full_path: Path, project_root: Path) -> Optional[FileIndex]:
    """Parse a single file and return its FileIndex structure."""
    if not full_path.is_file():
        return None

    ext = full_path.suffix.lower()
    if ext not in INDEXABLE_EXTENSIONS:
        return None

    try:
        content = full_path.read_text(encoding="utf-8")
    except Exception as exc:
        logger.warning("Could not read %s: %s", full_path, exc)
        return None

    rel_path = str(full_path.relative_to(project_root))
    lang = INDEXABLE_EXTENSIONS[ext].value
    content_hash = compute_file_hash(content)
    line_count = len(content.splitlines())

    # Run AST parsing via tree_sitter_cfg
    ast_result = parse_file(str(full_path))
    symbols: list[SymbolEntry] = []

    for fn in ast_result.functions:
        kind = "function"
        if fn.is_method:
            kind = "method"
        elif fn.name and fn.name[0].isupper() and lang in ("typescript", "javascript"):
            kind = "component"
        elif any("app." in (d or "") or "router." in (d or "") for d in fn.decorators):
            kind = "endpoint"

        params = [asdict(p) for p in (fn.parameters or [])]
        param_str = ", ".join(f"{p['name']}: {p['type_annotation'] or 'Any'}" if p.get('type_annotation') else p['name'] for p in params)
        ret_str = f" -> {fn.return_type}" if fn.return_type else ""
        async_str = "async " if fn.is_async else ""
        sig_str = f"{async_str}{fn.name}({param_str}){ret_str}"

        symbols.append(
            SymbolEntry(
                name=fn.name,
                kind=kind,
                file_path=rel_path,
                start_line=fn.start_line,
                end_line=fn.end_line,
                signature=sig_str,
                docstring=fn.docstring,
                parameters=params,
                return_type=fn.return_type,
                is_async=fn.is_async,
            )
        )

    imports = extract_imports(content, lang)

    return FileIndex(
        relative_path=rel_path,
        language=lang,
        size_bytes=len(content.encode("utf-8")),
        line_count=line_count,
        content_hash=content_hash,
        symbols=symbols,
        imports=imports,
    )


def detect_project_profile(project_root: Path, file_indices: list[FileIndex]) -> dict[str, Any]:
    """Detect technologies, ecosystem, project archetype, scale tier, and greenfield mode."""
    total_loc = sum(f.line_count for f in file_indices)
    file_count = len(file_indices)
    is_greenfield = (file_count == 0)
    mode = "greenfield" if is_greenfield else "brownfield"

    # Determine scale tier
    if total_loc < 1000 and file_count < 10:
        scale_tier = "micro"
    elif total_loc < 25000 and file_count < 150:
        scale_tier = "standard"
    else:
        scale_tier = "enterprise"

    # Detect frameworks & languages across ecosystems
    frameworks: list[str] = []
    ecosystems: list[str] = []

    # Node / TypeScript / JavaScript
    pkg_json = project_root / "package.json"
    if pkg_json.exists():
        ecosystems.append("node")
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8"))
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            framework_map = [
                ("React", "react"), ("Next.js", "next"), ("Vue", "vue"),
                ("Svelte", "svelte"), ("Angular", "@angular/core"),
                ("Express", "express"), ("NestJS", "@nestjs/core"),
                ("Fastify", "fastify"), ("TailwindCSS", "tailwindcss"),
                ("Vite", "vite"), ("Electron", "electron"), ("Tauri", "@tauri-apps/api")
            ]
            for f_name, dep_key in framework_map:
                if dep_key in deps:
                    frameworks.append(f_name)
        except Exception:
            pass

    # Python
    py_manifests = [project_root / "requirements.txt", project_root / "pyproject.toml", project_root / "setup.py", project_root / "Pipfile"]
    if any(m.exists() for m in py_manifests):
        ecosystems.append("python")
        req_text = ""
        for m in py_manifests:
            if m.exists():
                try:
                    req_text += m.read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    pass
        req_lower = req_text.lower()
        py_framework_map = [
            ("FastAPI", "fastapi"), ("Flask", "flask"), ("Django", "django"),
            ("Pydantic", "pydantic"), ("SQLAlchemy", "sqlalchemy"),
            ("Click", "click"), ("Typer", "typer"), ("Pytest", "pytest"),
            ("Tornado", "tornado"), ("Celery", "celery")
        ]
        for f_name, dep_key in py_framework_map:
            if dep_key in req_lower:
                frameworks.append(f_name)

    # Go
    go_mod = project_root / "go.mod"
    if go_mod.exists():
        ecosystems.append("go")
        try:
            go_text = go_mod.read_text(encoding="utf-8", errors="ignore").lower()
            for f_name, dep_key in [("Gin", "gin-gonic/gin"), ("Fiber", "gofiber/fiber"), ("Echo", "labstack/echo")]:
                if dep_key in go_text:
                    frameworks.append(f_name)
        except Exception:
            pass

    # Rust
    cargo_toml = project_root / "Cargo.toml"
    if cargo_toml.exists():
        ecosystems.append("rust")
        try:
            cargo_text = cargo_toml.read_text(encoding="utf-8", errors="ignore").lower()
            for f_name, dep_key in [("Actix", "actix-web"), ("Axum", "axum"), ("Tokio", "tokio"), ("Clap", "clap")]:
                if dep_key in cargo_text:
                    frameworks.append(f_name)
        except Exception:
            pass

    lang_counts: dict[str, int] = {}
    for f in file_indices:
        lang_counts[f.language] = lang_counts.get(f.language, 0) + 1

    primary_language = max(lang_counts, key=lang_counts.get) if lang_counts else "unknown"

    # Compute archetype dynamically
    if is_greenfield:
        archetype = "Greenfield / Blank Workspace"
    elif "Next.js" in frameworks:
        archetype = "Next.js Fullstack Application"
    elif "React" in frameworks:
        archetype = "React Single Page Application"
    elif "Vue" in frameworks:
        archetype = "Vue Single Page Application"
    elif "Svelte" in frameworks:
        archetype = "Svelte Application"
    elif "FastAPI" in frameworks:
        archetype = "Python FastAPI Service"
    elif "Django" in frameworks:
        archetype = "Django Web Application"
    elif "Flask" in frameworks:
        archetype = "Flask Web Application"
    elif "Express" in frameworks:
        archetype = "Node.js Express Service"
    elif "rust" in ecosystems:
        archetype = "Rust Systems Application / CLI"
    elif "go" in ecosystems:
        archetype = "Go Service / CLI"
    elif primary_language != "unknown":
        archetype = f"{primary_language.capitalize()} Project"
    else:
        archetype = "Generic Software Project"

    return {
        "mode": mode,
        "archetype": archetype,
        "scale_tier": scale_tier,
        "total_loc": total_loc,
        "indexed_files": file_count,
        "primary_language": primary_language,
        "ecosystems": sorted(list(set(ecosystems))),
        "frameworks": sorted(list(set(frameworks))),
        "languages": lang_counts,
    }


def extract_architectural_landmarks(project_root: Path, file_indices: list[FileIndex]) -> dict[str, Any]:
    """Dynamically discover architectural landmarks across ANY codebase using AST and file topology.
    
    Identifies:
    1. Entrypoints (main.*, App.*, index.*, server.*, manage.py, app/layout.*)
    2. Navigation & Header Landmark (<header>, <nav>, Navbar, Header, Layout)
    3. Footer & Status Landmark (<footer>, StatusBar, BottomBar)
    4. Routing & API Endpoints (routes/, api/, @app.get, createBrowserRouter)
    5. Data Models & State Stores (stores/, models/, create(, defineStore)
    6. Primary Views & Panels (views/, pages/, panels/, dashboards/)
    """
    landmarks: dict[str, Any] = {
        "entrypoints": [],
        "navigation": None,
        "footer_status": None,
        "routing": [],
        "state_data": [],
        "views_panels": [],
    }

    has_ui_files = any(Path(fi.relative_path).suffix.lower() in (".tsx", ".jsx", ".vue", ".svelte", ".html") for fi in file_indices)
    nav_candidates: list[tuple[str, int, str, list[str], str]] = []
    footer_candidates: list[tuple[str, int, str, list[str], str]] = []

    for fi in file_indices:
        rel = fi.relative_path
        rel_lower = rel.lower()
        full_path = project_root / rel
        ext = Path(rel).suffix.lower()
        is_ui_file = ext in (".tsx", ".jsx", ".vue", ".svelte", ".html")

        # 1. Entrypoint detection
        fname = Path(rel).name.lower()
        if fname in (
            "main.tsx", "main.ts", "index.tsx", "index.ts", "app.tsx", "app.jsx",
            "main.py", "app.py", "server.py", "manage.py", "main.go", "main.rs",
            "server.ts", "server.js", "layout.tsx", "rootlayout.tsx"
        ):
            landmarks["entrypoints"].append({
                "file": rel,
                "symbols": [s.name for s in fi.symbols[:3]],
                "description": f"Application root / entrypoint ({fname})"
            })

        # 2. Inspect content for semantic tags and UI landmarks
        try:
            content = full_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            content = ""

        content_lower = content.lower()
        lines = content.splitlines()

        # UI landmarks (Only consider UI files if the project contains UI files)
        if not has_ui_files or is_ui_file:
            # Navigation / Header detection
            nav_score = 0
            nav_elements: list[str] = []
            nav_line_range = "1-100"

            # Check for <header tag
            for idx, l in enumerate(lines, 1):
                l_strip = l.strip().lower()
                if l_strip.startswith("<header") or " <header" in l_strip:
                    nav_score += 25
                    nav_elements.append("<header>")
                    start_l = max(1, idx - 2)
                    end_l = min(len(lines), idx + 35)
                    nav_line_range = f"{start_l}-{end_l}"
                    # Check lines inside header for brand/logo
                    header_snippet = "\n".join(lines[start_l - 1:end_l]).lower()
                    if "brand" in header_snippet or "logo" in header_snippet:
                        nav_score += 15
                        nav_elements.append("brand/logo")
                    break

            for idx, l in enumerate(lines, 1):
                l_strip = l.strip().lower()
                if l_strip.startswith("<nav") or " <nav" in l_strip:
                    nav_score += 15
                    nav_elements.append("<nav>")
                    break

            if any(term in rel_lower for term in ("navbar", "nav_bar", "navigation", "topbar", "header", "appbar", "titlebar")):
                nav_score += 15

            if any(term in rel_lower for term in ("layout", "shell", "frame")):
                nav_score += 10

            for s in fi.symbols:
                s_low = s.name.lower()
                if any(term in s_low for term in ("nav", "header", "topbar", "titlebar", "appbar")):
                    nav_score += 10
                    nav_elements.append(s.name)
                elif any(term in s_low for term in ("layout", "shell", "frame")):
                    nav_score += 8
                    nav_elements.append(s.name)
                if any(term in s_low for term in ("brand", "logo")):
                    nav_elements.append(s.name)

            if nav_score >= 15:
                nav_candidates.append((
                    rel,
                    nav_score,
                    nav_line_range,
                    sorted(list(set(nav_elements))),
                    f"Top navigation / header component ({', '.join(nav_elements[:3])})"
                ))

            # Footer / Status bar detection
            footer_score = 0
            footer_elements: list[str] = []
            footer_line_range = "1-100"

            for idx, l in enumerate(lines, 1):
                l_strip = l.strip().lower()
                if l_strip.startswith("<footer") or " <footer" in l_strip:
                    footer_score += 25
                    footer_elements.append("<footer>")
                    footer_line_range = f"{max(1, idx - 2)}-{min(len(lines), idx + 30)}"
                    break

            if any(term in fname for term in ("statusbar", "status_bar", "status-bar")):
                footer_score += 25
                footer_elements.append("statusbar")
            elif any(term in rel_lower for term in ("statusbar", "status_bar", "status-bar", "bottombar")):
                footer_score += 15
                footer_elements.append("statusbar")

            for s in fi.symbols:
                s_low = s.name.lower()
                if s_low in ("statusbar", "bottombar", "footer"):
                    footer_score += 20
                    footer_elements.append(s.name)
                elif any(term in s_low for term in ("status", "footer", "bottombar")):
                    footer_score += 5
                    footer_elements.append(s.name)

            if footer_score >= 15:
                footer_candidates.append((
                    rel,
                    footer_score,
                    footer_line_range,
                    sorted(list(set(footer_elements))),
                    f"Status / footer bar component ({', '.join(footer_elements[:3])})"
                ))

        # 3. Routing detection
        if any(r in rel_lower for r in ("route", "router", "urls.py", "controllers/", "api/")) or \
           any(imp in content for imp in ("react-router", "next/navigation", "vue-router", "express", "fastapi")) or \
           any(s.kind == "endpoint" for s in fi.symbols):
            landmarks["routing"].append({
                "file": rel,
                "symbols": [s.name for s in fi.symbols if s.kind in ("endpoint", "function")][:4],
                "description": "Routing / API endpoints"
            })

        # 4. State & Data Models detection
        if any(sm in rel_lower for sm in ("store", "state", "models/", "schemas/")) or \
           any(term in content for term in ("create(", "createStore", "defineStore", "Base = declarative_base", "prisma")):
            landmarks["state_data"].append({
                "file": rel,
                "symbols": [s.name for s in fi.symbols if s.kind in ("class", "function")][:4],
                "description": "State management store or data model"
            })

        # 5. Views & Panels
        if any(vp in rel_lower for vp in ("views/", "pages/", "panels/", "dashboards/", "editor/")):
            landmarks["views_panels"].append({
                "file": rel,
                "symbols": [s.name for s in fi.symbols if s.kind == "component"][:3],
                "description": "View / Dashboard / Editor Panel"
            })

    if nav_candidates:
        nav_candidates.sort(key=lambda x: x[1], reverse=True)
        top_nav = nav_candidates[0]
        landmarks["navigation"] = {
            "file": top_nav[0],
            "score": top_nav[1],
            "line_range": top_nav[2],
            "elements": top_nav[3],
            "description": top_nav[4],
        }

    if footer_candidates:
        footer_candidates.sort(key=lambda x: x[1], reverse=True)
        top_foot = footer_candidates[0]
        landmarks["footer_status"] = {
            "file": top_foot[0],
            "score": top_foot[1],
            "line_range": top_foot[2],
            "elements": top_foot[3],
            "description": top_foot[4],
        }

    landmarks["routing"] = landmarks["routing"][:8]
    landmarks["state_data"] = landmarks["state_data"][:8]
    landmarks["views_panels"] = landmarks["views_panels"][:8]

    return landmarks


_JS_EXTENSIONS = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts")
_OTHER_EXTENSIONS = (".json", ".css", ".scss", ".vue", ".svelte", ".md", ".py")
_ALL_IMPORT_EXTENSIONS = _JS_EXTENSIONS + _OTHER_EXTENSIONS

_BARE_MODULE_RE = re.compile(r"^[A-Za-z_][\w.]*$")
_JS_SUFFIX_RE = re.compile(r"\.(js|jsx|mjs|cjs)$")


def _normalize_relative(dir_parts: list[str], spec: str) -> str:
    """Joins a relative specifier onto dir_parts, collapsing '.' and '..'."""
    parts = list(dir_parts)
    for segment in spec.split("/"):
        if not segment or segment == ".":
            continue
        if segment == "..":
            if parts:
                parts.pop()
        else:
            parts.append(segment)
    return "/".join(parts)


def resolve_local_import(
    spec: str, from_path: str, known_paths: set[str]
) -> Optional[str]:
    """Resolve a module specifier to another indexed project file, or None.

    Only project-local imports resolve: relative specifiers (``./x``, ``../x``)
    and Python bare modules that match an indexed sibling. Third-party packages
    return None, so they never create phantom file→file edges.
    """
    if not spec:
        return None
    posix_from = from_path.replace("\\", "/")
    dir_parts = posix_from.split("/")[:-1]

    if spec.startswith("."):
        base = _normalize_relative(dir_parts, spec)
        # TS/ESM writes ``./foo.js`` to mean ``./foo.ts``; try both forms.
        stripped = _JS_SUFFIX_RE.sub("", base)
        bases = [base, stripped] if stripped != base else [base]
        for candidate_base in bases:
            for ext in _ALL_IMPORT_EXTENSIONS:
                candidate = f"{candidate_base}{ext}"
                if candidate in known_paths:
                    return candidate
        for candidate_base in bases:
            for ext in _ALL_IMPORT_EXTENSIONS:
                candidate = f"{candidate_base}/index{ext}"
                if candidate in known_paths:
                    return candidate
        return None

    if _BARE_MODULE_RE.match(spec):
        module_path = spec.replace(".", "/")
        prefix = "/".join(dir_parts)
        candidates = [
            f"{prefix}/{module_path}.py" if prefix else f"{module_path}.py",
            f"{module_path}.py",
            f"{prefix}/{module_path}/__init__.py" if prefix else f"{module_path}/__init__.py",
        ]
        for candidate in candidates:
            if candidate in known_paths:
                return candidate
    return None


def build_dependency_graph(
    file_indices: list[FileIndex],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build graph nodes/edges, including resolved file→file import edges."""
    known_paths = {fi.relative_path for fi in file_indices}
    graph_nodes: list[dict[str, Any]] = []
    graph_edges: list[dict[str, Any]] = []

    for fi in file_indices:
        file_node_id = f"file:{fi.relative_path}"
        graph_nodes.append(
            {
                "id": file_node_id,
                "type": "file",
                "filePath": fi.relative_path,
                "meta": {"lineCount": fi.line_count, "language": fi.language},
            }
        )

        for sym in fi.symbols:
            sym_id = f"{fi.relative_path}::{sym.name}"
            graph_nodes.append(
                {
                    "id": sym_id,
                    "type": sym.kind,
                    "filePath": fi.relative_path,
                    "startLine": sym.start_line,
                    "endLine": sym.end_line,
                    "signatureHash": compute_file_hash(sym.signature),
                    "meta": asdict(sym),
                }
            )
            graph_edges.append(
                {
                    "source": file_node_id,
                    "target": sym_id,
                    "type": "structural_import",
                }
            )

        for imp in fi.imports:
            graph_edges.append(
                {
                    "source": file_node_id,
                    "target": f"import:{imp}",
                    "type": "import_reference",
                }
            )
            target_file = resolve_local_import(imp, fi.relative_path, known_paths)
            if target_file and target_file != fi.relative_path:
                graph_edges.append(
                    {
                        "source": file_node_id,
                        "target": f"file:{target_file}",
                        "type": "file_import",
                    }
                )

    return graph_nodes, graph_edges


def index_entire_project(project_root_str: str) -> dict[str, Any]:
    """Walk the project tree and index all supported source files."""
    start_time = time.monotonic()
    project_root = Path(project_root_str).resolve()
    if not project_root.is_dir():
        raise ValueError(f"Project root is not a directory: {project_root_str}")

    file_indices: list[FileIndex] = []

    for root, dirs, files in os.walk(project_root):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS and not d.startswith(".")]

        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext in INDEXABLE_EXTENSIONS:
                full_path = Path(root) / filename
                idx = index_single_file(full_path, project_root)
                if idx is not None:
                    file_indices.append(idx)

    symbols_map: dict[str, list[dict[str, Any]]] = {}

    total_symbols = 0
    for fi in file_indices:
        for sym in fi.symbols:
            total_symbols += 1
            sym_dict = asdict(sym)

            if sym.name not in symbols_map:
                symbols_map[sym.name] = []
            symbols_map[sym.name].append(sym_dict)

    graph_nodes, graph_edges = build_dependency_graph(file_indices)

    profile = detect_project_profile(project_root, file_indices)
    landmarks = extract_architectural_landmarks(project_root, file_indices)
    architecture = {
        "archetype": profile.get("archetype", "Generic Software Project"),
        "mode": profile.get("mode", "brownfield"),
        "ecosystems": profile.get("ecosystems", []),
        "frameworks": profile.get("frameworks", []),
        "entrypoints": [ep["file"] for ep in landmarks.get("entrypoints", [])],
        "landmarks_summary": {
            k: (v["file"] if isinstance(v, dict) else [x["file"] for x in v[:3]])
            for k, v in landmarks.items() if v
        },
    }
    elapsed_ms = (time.monotonic() - start_time) * 1000

    logger.info(
        "Indexed %d files (%d symbols) in %.1fms. Archetype: %s, Frameworks: %s",
        len(file_indices),
        total_symbols,
        elapsed_ms,
        profile["archetype"],
        ", ".join(profile["frameworks"]) or "None",
    )

    index_data = {
        "version": "1.0.0",
        "updated_at": time.time(),
        "elapsed_ms": round(elapsed_ms, 2),
        "profile": profile,
        "architecture": architecture,
        "landmarks": landmarks,
        "total_symbols": total_symbols,
        "files": {fi.relative_path: asdict(fi) for fi in file_indices},
        "symbols": symbols_map,
        "graph": {
            "nodes": graph_nodes,
            "edges": graph_edges,
        },
    }

    try:
        acsa_dir = prepare_state_dir(project_root)
        write_json_atomic(acsa_dir / "index.json", index_data)
        logger.info("Saved index to %s", acsa_dir / "index.json")
    except Exception as exc:
        logger.warning("Failed to save .acsa/index.json: %s", exc)

    return index_data


def update_file_incremental(project_root_str: str, relative_path: str) -> Optional[dict[str, Any]]:
    """Update a single modified file in the index."""
    project_root = Path(project_root_str).resolve()
    full_path = project_root / relative_path

    index_file = project_root / ".acsa" / "index.json"
    if not index_file.exists():
        return index_entire_project(project_root_str)

    try:
        existing_index = json.loads(index_file.read_text(encoding="utf-8"))
    except Exception:
        return index_entire_project(project_root_str)

    if not full_path.exists():
        if relative_path in existing_index.get("files", {}):
            del existing_index["files"][relative_path]
    else:
        new_file_index = index_single_file(full_path, project_root)
        if new_file_index:
            existing_index["files"][relative_path] = asdict(new_file_index)

    symbols_map: dict[str, list[dict[str, Any]]] = {}
    total_symbols = 0
    file_indices = []
    for rel_p, file_dict in existing_index.get("files", {}).items():
        sym_objs = []
        for sym in file_dict.get("symbols", []):
            total_symbols += 1
            name = sym["name"]
            if name not in symbols_map:
                symbols_map[name] = []
            symbols_map[name].append(sym)
            sym_objs.append(SymbolEntry(
                name=sym.get("name", ""),
                kind=sym.get("kind", "function"),
                file_path=rel_p,
                start_line=sym.get("start_line", 1),
                end_line=sym.get("end_line", 1),
                signature=sym.get("signature", ""),
            ))
        file_indices.append(FileIndex(
            relative_path=rel_p,
            language=file_dict.get("language", "unknown"),
            size_bytes=file_dict.get("size_bytes", 0),
            line_count=file_dict.get("line_count", 0),
            content_hash=file_dict.get("content_hash", ""),
            symbols=sym_objs,
            imports=file_dict.get("imports", []),
        ))

    existing_index["updated_at"] = time.time()
    existing_index["total_symbols"] = total_symbols
    existing_index["symbols"] = symbols_map
    # Rebuild the graph so incremental saves do not leave it stale (the graph
    # previously kept whatever the last full index produced, so new symbols and
    # imports were invisible to blast-radius / dependency queries).
    graph_nodes, graph_edges = build_dependency_graph(file_indices)
    existing_index["graph"] = {"nodes": graph_nodes, "edges": graph_edges}
    existing_index["profile"] = detect_project_profile(project_root, file_indices)
    existing_index["landmarks"] = existing_index.get("landmarks", {})
    existing_index["architecture"] = {
        "archetype": existing_index["profile"].get("archetype", "Generic Software Project"),
        "mode": existing_index["profile"].get("mode", "brownfield"),
        "ecosystems": existing_index["profile"].get("ecosystems", []),
        "frameworks": existing_index["profile"].get("frameworks", []),
        "entrypoints": [ep["file"] for ep in existing_index["landmarks"].get("entrypoints", [])],
        "landmarks_summary": {
            k: (v["file"] if isinstance(v, dict) else [x["file"] for x in v[:3]])
            for k, v in existing_index["landmarks"].items() if v
        },
    }

    try:
        prepare_state_dir(project_root)
        write_json_atomic(index_file, existing_index)
        logger.info("Incrementally updated %s in index", relative_path)
    except Exception as exc:
        logger.warning("Failed to save incremental index: %s", exc)

    return existing_index


def main() -> int:
    parser = argparse.ArgumentParser(description="ACSA Code Project Indexer")
    parser.add_argument("--project-root", required=True, help="Path to project root")
    parser.add_argument("--file", help="Incremental single file to re-index")
    parser.add_argument("--query", help="Query symbol name across index")
    parser.add_argument("--outline", help="Get symbol outline for specific file")
    parser.add_argument("--json", action="store_true", help="Output result as JSON to stdout")

    args = parser.parse_args()

    if args.file:
        res = update_file_incremental(args.project_root, args.file)
        if args.json and res:
            print(json.dumps({"success": True, "updated": args.file, "total_symbols": res.get("total_symbols", 0)}))
        return 0

    if args.query:
        index_path = Path(args.project_root) / ".acsa" / "index.json"
        if not index_path.exists():
            index_entire_project(args.project_root)
        try:
            data = json.loads(index_path.read_text(encoding="utf-8"))
            matches = data.get("symbols", {}).get(args.query, [])
            print(json.dumps(matches, indent=2))
            return 0
        except Exception as exc:
            print(json.dumps({"error": str(exc)}), file=sys.stderr)
            return 1

    if args.outline:
        index_path = Path(args.project_root) / ".acsa" / "index.json"
        if not index_path.exists():
            index_entire_project(args.project_root)
        try:
            data = json.loads(index_path.read_text(encoding="utf-8"))
            file_data = data.get("files", {}).get(args.outline, {})
            print(json.dumps(file_data.get("symbols", []), indent=2))
            return 0
        except Exception as exc:
            print(json.dumps({"error": str(exc)}), file=sys.stderr)
            return 1

    res = index_entire_project(args.project_root)
    if args.json:
        summary = {
            "success": True,
            "profile": res["profile"],
            "total_symbols": res["total_symbols"],
            "elapsed_ms": res["elapsed_ms"],
        }
        print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
