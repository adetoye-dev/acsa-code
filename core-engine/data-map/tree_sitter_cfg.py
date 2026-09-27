#!/usr/bin/env python3
"""
tree_sitter_cfg.py — Tree-sitter Language Parser Configuration

Provides AST parsing for Python and TypeScript source files using
tree-sitter bindings. Extracts function signatures, parameter types,
return types, and precise line boundaries to feed project_indexer and
the dependency graph.

Stdlib only for the wrapper; tree-sitter is the single required
external package (installed alongside the IDE, not via pip at runtime).
Falls back to a regex-based extractor if tree-sitter is not installed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Optional

# ── Logging ──────────────────────────────────────────────────────────────────

# One shared setup: the same JSON line to stdout and to a rotating file in the
# data directory, with the component taken from the logger name rather than
# written into a format string per module. See core-engine/log_setup.py.
from log_setup import configure

logger = configure("TreeSitterCfg")


# ── Data Structures ──────────────────────────────────────────────────────────


class SupportedLanguage(str, Enum):
    PYTHON = "python"
    TYPESCRIPT = "typescript"
    JAVASCRIPT = "javascript"
    GO = "go"
    RUST = "rust"


class ParamKind(str, Enum):
    POSITIONAL = "positional"
    KEYWORD = "keyword"
    REST = "rest"
    KEYWORD_REST = "keyword_rest"


@dataclass
class ParameterInfo:
    """Describes a single function parameter."""

    name: str
    type_annotation: Optional[str] = None
    default_value: Optional[str] = None
    kind: ParamKind = ParamKind.POSITIONAL

    def to_dict(self) -> dict:
        d = {"name": self.name, "kind": self.kind.value}
        if self.type_annotation:
            d["type"] = self.type_annotation
        if self.default_value:
            d["default"] = self.default_value
        return d


@dataclass
class FunctionSignature:
    """Complete function signature extracted from source code."""

    name: str
    parameters: list[ParameterInfo] = field(default_factory=list)
    return_type: Optional[str] = None
    start_line: int = 0  # 1-indexed
    end_line: int = 0  # 1-indexed, inclusive
    is_async: bool = False
    is_method: bool = False
    decorators: list[str] = field(default_factory=list)
    docstring: Optional[str] = None
    language: str = "python"

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "parameters": [p.to_dict() for p in self.parameters],
            "return_type": self.return_type,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "is_async": self.is_async,
            "is_method": self.is_method,
            "decorators": self.decorators,
            "docstring": self.docstring,
            "language": self.language,
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)


@dataclass
class ParseResult:
    """Result of parsing a source file for function signatures."""

    file_path: str
    language: str
    functions: list[FunctionSignature] = field(default_factory=list)
    parse_errors: list[str] = field(default_factory=list)
    used_fallback: bool = False

    def to_dict(self) -> dict:
        return {
            "file_path": self.file_path,
            "language": self.language,
            "functions": [f.to_dict() for f in self.functions],
            "parse_errors": self.parse_errors,
            "used_fallback": self.used_fallback,
        }


# ── Language Detection ───────────────────────────────────────────────────────


def detect_language(file_path: str) -> Optional[SupportedLanguage]:
    """Detect programming language from file extension."""
    ext_map = {
        ".py": SupportedLanguage.PYTHON,
        ".ts": SupportedLanguage.TYPESCRIPT,
        ".tsx": SupportedLanguage.TYPESCRIPT,
        ".js": SupportedLanguage.JAVASCRIPT,
        ".jsx": SupportedLanguage.JAVASCRIPT,
        ".go": SupportedLanguage.GO,
        ".rs": SupportedLanguage.RUST,
    }
    ext = Path(file_path).suffix.lower()
    return ext_map.get(ext)


# ── Tree-sitter Parser Backend ───────────────────────────────────────────────


_TS_AVAILABLE = False
_ts_parsers: dict[str, object] = {}

try:
    from tree_sitter import Language, Parser  # type: ignore[import-untyped]

    _TS_AVAILABLE = True
    logger.info("tree-sitter bindings available")
except ImportError:
    logger.info("tree-sitter not installed — using regex fallback parser")


def _get_ts_language(lang: SupportedLanguage) -> Optional[object]:
    """Load the tree-sitter language grammar."""
    if not _TS_AVAILABLE:
        return None

    lang_packages = {
        SupportedLanguage.PYTHON: "tree_sitter_python",
        SupportedLanguage.TYPESCRIPT: "tree_sitter_typescript",
        SupportedLanguage.JAVASCRIPT: "tree_sitter_javascript",
    }

    pkg_name = lang_packages.get(lang)
    if not pkg_name:
        return None

    try:
        mod = __import__(pkg_name)
        if lang == SupportedLanguage.TYPESCRIPT:
            return Language(mod.language_typescript())
        return Language(mod.language())
    except (ImportError, AttributeError, Exception) as exc:
        logger.warning("Failed to load %s grammar: %s", pkg_name, exc)
        return None


def _get_ts_parser(lang: SupportedLanguage) -> Optional[object]:
    """Get or create a tree-sitter parser for the given language."""
    if not _TS_AVAILABLE:
        return None

    cache_key = lang.value
    if cache_key in _ts_parsers:
        return _ts_parsers[cache_key]

    language = _get_ts_language(lang)
    if language is None:
        return None

    parser = Parser(language)
    _ts_parsers[cache_key] = parser
    return parser


def _extract_ts_python_functions(
    source: bytes, file_path: str, parser: object
) -> list[FunctionSignature]:
    """Extract function signatures from Python using tree-sitter."""
    tree = parser.parse(source)
    root = tree.root_node
    functions: list[FunctionSignature] = []

    def _visit(node, is_class_body: bool = False):
        if node.type in ("function_definition", "decorated_definition"):
            fn_node = node
            decorators: list[str] = []

            if node.type == "decorated_definition":
                for child in node.children:
                    if child.type == "decorator":
                        decorators.append(
                            source[child.start_byte : child.end_byte].decode("utf-8")
                        )
                    elif child.type == "function_definition":
                        fn_node = child
                        break

            if fn_node.type != "function_definition":
                return

            sig = _parse_python_fn_node(
                fn_node, source, file_path, is_class_body, decorators
            )
            if sig:
                # Use the decorated_definition's line span if present
                sig.start_line = node.start_point[0] + 1
                sig.end_line = node.end_point[0] + 1
                functions.append(sig)

        elif node.type == "class_definition":
            for child in node.children:
                if child.type == "block":
                    for stmt in child.children:
                        _visit(stmt, is_class_body=True)

        else:
            for child in node.children:
                _visit(child, is_class_body)

    _visit(root)
    return functions


def _parse_python_fn_node(
    node, source: bytes, file_path: str,
    is_method: bool, decorators: list[str]
) -> Optional[FunctionSignature]:
    """Parse a single Python function_definition node."""
    name_node = None
    params_node = None
    return_type_node = None

    for child in node.children:
        if child.type == "identifier" and name_node is None:
            name_node = child
        elif child.type == "parameters":
            params_node = child
        elif child.type == "type" or (
            child.type == "->" or
            source[child.start_byte : child.end_byte].decode("utf-8").strip() == "->"
        ):
            # Return type follows the -> token
            pass

    if name_node is None:
        return None

    func_name = source[name_node.start_byte : name_node.end_byte].decode("utf-8")

    # Check for async
    is_async = any(
        source[c.start_byte : c.end_byte].decode("utf-8") == "async"
        for c in node.children
        if c.type == "async"
    )

    # Extract parameters
    parameters: list[ParameterInfo] = []
    if params_node:
        for param in params_node.children:
            if param.type in ("identifier", "typed_parameter",
                              "default_parameter", "typed_default_parameter",
                              "list_splat_pattern", "dictionary_splat_pattern"):
                pinfo = _parse_python_param(param, source)
                if pinfo and pinfo.name != "self" and pinfo.name != "cls":
                    parameters.append(pinfo)

    # Extract return type
    return_type = None
    fn_text = source[node.start_byte : node.end_byte].decode("utf-8")
    rt_match = re.search(r"->\s*(.+?):", fn_text.split("\n")[0])
    if rt_match:
        return_type = rt_match.group(1).strip()

    # Extract docstring
    docstring = None
    for child in node.children:
        if child.type == "block":
            for stmt in child.children:
                if stmt.type == "expression_statement":
                    for expr in stmt.children:
                        if expr.type == "string":
                            raw = source[expr.start_byte : expr.end_byte].decode("utf-8")
                            docstring = raw.strip("\"'").strip()
                            break
                break

    return FunctionSignature(
        name=func_name,
        parameters=parameters,
        return_type=return_type,
        start_line=node.start_point[0] + 1,
        end_line=node.end_point[0] + 1,
        is_async=is_async,
        is_method=is_method,
        decorators=decorators,
        docstring=docstring,
        language="python",
    )


def _parse_python_param(node, source: bytes) -> Optional[ParameterInfo]:
    """Parse a single Python parameter node."""
    text = source[node.start_byte : node.end_byte].decode("utf-8")

    if node.type == "identifier":
        return ParameterInfo(name=text, kind=ParamKind.POSITIONAL)

    if node.type == "typed_parameter":
        parts = text.split(":", 1)
        name = parts[0].strip()
        type_ann = parts[1].strip() if len(parts) > 1 else None
        kind = ParamKind.REST if name.startswith("*") else ParamKind.POSITIONAL
        name = name.lstrip("*")
        return ParameterInfo(name=name, type_annotation=type_ann, kind=kind)

    if node.type in ("default_parameter", "typed_default_parameter"):
        eq_idx = text.find("=")
        if eq_idx > 0:
            left = text[:eq_idx].strip()
            default = text[eq_idx + 1 :].strip()
            colon_idx = left.find(":")
            if colon_idx > 0:
                name = left[:colon_idx].strip()
                type_ann = left[colon_idx + 1 :].strip()
            else:
                name = left
                type_ann = None
            return ParameterInfo(
                name=name, type_annotation=type_ann,
                default_value=default, kind=ParamKind.KEYWORD,
            )

    if node.type == "list_splat_pattern":
        name = text.lstrip("*")
        return ParameterInfo(name=name, kind=ParamKind.REST)

    if node.type == "dictionary_splat_pattern":
        name = text.lstrip("*")
        return ParameterInfo(name=name, kind=ParamKind.KEYWORD_REST)

    return None


def _extract_ts_typescript_functions(
    source: bytes, file_path: str, parser: object
) -> list[FunctionSignature]:
    """Extract function signatures from TypeScript/JavaScript using tree-sitter."""
    tree = parser.parse(source)
    root = tree.root_node
    functions: list[FunctionSignature] = []

    lang = "typescript" if file_path.endswith((".ts", ".tsx")) else "javascript"

    def _visit(node, is_class_body: bool = False):
        if node.type in ("function_declaration", "method_definition",
                         "arrow_function", "function"):
            sig = _parse_ts_fn_node(node, source, file_path, is_class_body, lang)
            if sig:
                functions.append(sig)

        elif node.type == "variable_declarator":
            # const foo = (params) => { ... }
            for child in node.children:
                if child.type == "arrow_function":
                    sig = _parse_ts_fn_node(
                        child, source, file_path, is_class_body, lang
                    )
                    if sig:
                        # Get the name from the variable declarator
                        for sib in node.children:
                            if sib.type == "identifier":
                                sig.name = source[
                                    sib.start_byte : sib.end_byte
                                ].decode("utf-8")
                                break
                        functions.append(sig)

        elif node.type == "export_statement":
            for child in node.children:
                _visit(child, is_class_body)

        elif node.type == "class_declaration":
            for child in node.children:
                if child.type == "class_body":
                    for stmt in child.children:
                        _visit(stmt, is_class_body=True)

        else:
            for child in node.children:
                _visit(child, is_class_body)

    _visit(root)
    return functions


def _parse_ts_fn_node(
    node, source: bytes, file_path: str,
    is_method: bool, lang: str
) -> Optional[FunctionSignature]:
    """Parse a TypeScript/JavaScript function node."""
    text = source[node.start_byte : node.end_byte].decode("utf-8")
    first_line = text.split("\n")[0]

    name = "<anonymous>"
    for child in node.children:
        if child.type == "identifier" or child.type == "property_identifier":
            name = source[child.start_byte : child.end_byte].decode("utf-8")
            break

    is_async = "async" in first_line.split("(")[0]

    # Extract return type
    return_type = None
    rt_match = re.search(r"\)\s*:\s*([^{]+)", first_line)
    if rt_match:
        return_type = rt_match.group(1).strip().rstrip("{").strip()

    # Extract parameters
    parameters: list[ParameterInfo] = []
    for child in node.children:
        if child.type == "formal_parameters":
            params_text = source[child.start_byte : child.end_byte].decode("utf-8")
            # Strip parens
            inner = params_text.strip("()")
            if inner.strip():
                for param_str in _split_params(inner):
                    pinfo = _parse_ts_param(param_str.strip())
                    if pinfo:
                        parameters.append(pinfo)

    return FunctionSignature(
        name=name,
        parameters=parameters,
        return_type=return_type,
        start_line=node.start_point[0] + 1,
        end_line=node.end_point[0] + 1,
        is_async=is_async,
        is_method=is_method,
        language=lang,
    )


def _split_params(text: str) -> list[str]:
    """Split parameter text respecting nested angle brackets and braces."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []

    for ch in text:
        if ch in "<({[":
            depth += 1
            current.append(ch)
        elif ch in ">)}]":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)

    if current:
        parts.append("".join(current))

    return parts


def _parse_ts_param(text: str) -> Optional[ParameterInfo]:
    """Parse a single TypeScript parameter string."""
    text = text.strip()
    if not text:
        return None

    kind = ParamKind.POSITIONAL
    if text.startswith("..."):
        kind = ParamKind.REST
        text = text[3:]

    # Check for default
    default = None
    eq_idx = text.find("=")
    if eq_idx > 0:
        default = text[eq_idx + 1 :].strip()
        text = text[:eq_idx].strip()
        kind = ParamKind.KEYWORD

    # Check for optional marker
    text = text.rstrip("?")

    # Split name: type
    colon_idx = text.find(":")
    if colon_idx > 0:
        name = text[:colon_idx].strip()
        type_ann = text[colon_idx + 1 :].strip()
    else:
        name = text.strip()
        type_ann = None

    if not name:
        return None

    return ParameterInfo(
        name=name, type_annotation=type_ann,
        default_value=default, kind=kind,
    )


# ── Regex Fallback Parser ────────────────────────────────────────────────────


def _extract_python_functions_regex(
    source: str, file_path: str
) -> list[FunctionSignature]:
    """Regex-based fallback Python function extractor."""
    functions: list[FunctionSignature] = []
    lines = source.splitlines()

    # Match function definitions — each def on its own line
    pattern = re.compile(
        r"^([ \t]*)(async[ \t]+)?def[ \t]+(\w+)\s*\(([^)]*)\)"
        r"(?:\s*->\s*(.+?))?\s*:",
        re.MULTILINE,
    )

    for match in pattern.finditer(source):
        indent = len(match.group(1).replace("\t", "    "))
        is_async = match.group(2) is not None
        func_name = match.group(3)
        params_str = match.group(4)
        return_type = match.group(5).strip() if match.group(5) else None

        # Calculate 1-indexed line of the def statement
        def_line_num = source[: match.start()].count("\n")
        start_line = def_line_num + 1  # 1-indexed

        # Look backward for decorators attached to this function
        decorators: list[str] = []
        dec_line = def_line_num - 1
        while dec_line >= 0:
            stripped = lines[dec_line].strip()
            if stripped.startswith("@"):
                decorators.insert(0, stripped)
                dec_line -= 1
            elif stripped == "":
                break
            else:
                break

        if decorators:
            start_line = dec_line + 2  # 1-indexed line of first decorator

        # Find end: next line at same or lesser indentation (non-blank, non-comment)
        end_line = len(lines)  # default: extends to end of file
        for i in range(def_line_num + 1, len(lines)):
            line = lines[i]
            stripped = line.lstrip()
            if stripped and not stripped.startswith("#"):
                line_indent = len(line) - len(stripped)
                if line_indent <= indent:
                    end_line = i  # 0-indexed, exclusive
                    break

        # Parse parameters
        first_param = params_str.split(",")[0].strip().split(":")[0].strip()
        is_method = first_param in ("self", "cls")
        parameters = _parse_params_regex(params_str, is_method)

        # Extract docstring from the line(s) right after the def line
        docstring = None
        for i in range(def_line_num + 1, min(def_line_num + 5, len(lines))):
            stripped = lines[i].strip()
            if stripped.startswith('"""') or stripped.startswith("'''"):
                doc_lines: list[str] = [stripped]
                quote = stripped[:3]
                if stripped.count(quote) >= 2 and len(stripped) > 3:
                    docstring = stripped[3:-3].strip()
                    break
                for j in range(i + 1, min(i + 20, len(lines))):
                    doc_lines.append(lines[j].strip())
                    if quote in lines[j]:
                        docstring = " ".join(doc_lines)
                        # Strip the triple quotes from first and last
                        docstring = docstring.replace(quote, "").strip()
                        break
                break
            elif stripped and not stripped.startswith("#"):
                break

        functions.append(
            FunctionSignature(
                name=func_name,
                parameters=parameters,
                return_type=return_type,
                start_line=start_line,
                end_line=end_line,
                is_async=is_async,
                is_method=is_method,
                decorators=decorators,
                docstring=docstring,
                language="python",
            )
        )

    return functions


def _extract_typescript_functions_regex(
    source: str, file_path: str
) -> list[FunctionSignature]:
    """Regex-based fallback TypeScript/JavaScript function extractor."""
    functions: list[FunctionSignature] = []
    lang = "typescript" if file_path.endswith((".ts", ".tsx")) else "javascript"

    # Match function declarations and exported functions
    patterns = [
        # function foo(params): RetType {
        re.compile(
            r"^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*"
            r"\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{",
            re.MULTILINE,
        ),
        # const foo = (params): RetType => { OR const foo = useCallback((params) => {
        re.compile(
            r"^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*"
            r"(?:useCallback\s*\(\s*)?(?:async\s+)?(?:\(([^)]*)\)|(\w+))(?:\s*:\s*([^=>{]+))?\s*=>",
            re.MULTILINE,
        ),
        # Method: foo(params): RetType {
        re.compile(
            r"^(\s+)(?:async\s+)?"
            r"(?!if\b|for\b|while\b|switch\b|catch\b|do\b|return\b|with\b)"
            r"(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{",
            re.MULTILINE,
        ),
    ]

    lines = source.splitlines()

    for pattern in patterns:
        for match in pattern.finditer(source):
            indent = len(match.group(1))
            func_name = match.group(2)
            params_str = match.group(3) if match.group(3) is not None else (match.group(4) or "")
            return_type = None
            if match.lastindex and match.lastindex >= 5 and match.group(5):
                return_type = match.group(5).strip()
            elif match.lastindex and match.lastindex >= 4 and match.group(4) and match.group(3) is not None:
                return_type = match.group(4).strip()

            is_async = "async" in source[
                match.start() : match.start() + match.end() - match.start()
            ][:50]

            start_line = source[: match.start()].count("\n") + 1

            # Find the matching closing brace
            brace_depth = 0
            end_line = len(lines)
            started = False
            for i in range(start_line - 1, len(lines)):
                for ch in lines[i]:
                    if ch == "{":
                        brace_depth += 1
                        started = True
                    elif ch == "}":
                        brace_depth -= 1
                if started and brace_depth == 0:
                    end_line = i + 1
                    break

            is_method = indent > 0
            parameters = _parse_ts_params_regex(params_str)

            # Skip duplicates
            if any(f.name == func_name and f.start_line == start_line
                   for f in functions):
                continue

            functions.append(
                FunctionSignature(
                    name=func_name,
                    parameters=parameters,
                    return_type=return_type,
                    start_line=start_line,
                    end_line=end_line,
                    is_async=is_async,
                    is_method=is_method,
                    language=lang,
                )
            )

    return functions


def _parse_params_regex(params_str: str, is_method: bool) -> list[ParameterInfo]:
    """Parse Python parameter string via regex."""
    params: list[ParameterInfo] = []
    if not params_str.strip():
        return params

    for raw in _split_params(params_str):
        raw = raw.strip()
        if not raw or raw in ("self", "cls"):
            continue

        kind = ParamKind.POSITIONAL
        if raw.startswith("**"):
            kind = ParamKind.KEYWORD_REST
            raw = raw[2:]
        elif raw.startswith("*"):
            kind = ParamKind.REST
            raw = raw[1:]

        default = None
        eq_idx = raw.find("=")
        if eq_idx > 0:
            default = raw[eq_idx + 1 :].strip()
            raw = raw[:eq_idx].strip()
            if kind == ParamKind.POSITIONAL:
                kind = ParamKind.KEYWORD

        colon_idx = raw.find(":")
        if colon_idx > 0:
            name = raw[:colon_idx].strip()
            type_ann = raw[colon_idx + 1 :].strip()
        else:
            name = raw.strip()
            type_ann = None

        if name:
            params.append(
                ParameterInfo(
                    name=name, type_annotation=type_ann,
                    default_value=default, kind=kind,
                )
            )

    return params


def _parse_ts_params_regex(params_str: str) -> list[ParameterInfo]:
    """Parse TypeScript parameter string via regex."""
    params: list[ParameterInfo] = []
    if not params_str.strip():
        return params

    for raw in _split_params(params_str):
        pinfo = _parse_ts_param(raw)
        if pinfo:
            params.append(pinfo)

def _extract_go_functions_regex(source: str, file_path: str) -> list[FunctionSignature]:
    """Regex fallback for Go functions with multiline signatures and real spans."""
    return _extract_c_like_functions(source, "go", re.compile(
        r"(?m)^[ \t]*func[ \t]+(?:\([^\n{}]*\)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\((.*?)\)(?:[ \t]+([^\n{]+))?[ \t]*\{",
        re.DOTALL,
    ))


def _extract_rust_functions_regex(source: str, file_path: str) -> list[FunctionSignature]:
    """Regex fallback for Rust functions with multiline signatures and real spans."""
    return _extract_c_like_functions(source, "rust", re.compile(
        r"(?m)^[ \t]*(?:pub[ \t]+)?(?:async[ \t]+)?fn[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\((.*?)\)(?:[ \t]*->[ \t]*([^\{]+?))?[ \t]*\{",
        re.DOTALL,
    ))


def _extract_c_like_functions(source: str, language: str, pattern: re.Pattern[str]) -> list[FunctionSignature]:
    """Extract anchored Go/Rust declarations while ignoring comments and finding body ends."""
    masked = re.sub(r"//[^\n]*|/\*.*?\*/", lambda match: "\n" * match.group(0).count("\n"), source, flags=re.DOTALL)
    lines = source.splitlines()
    functions: list[FunctionSignature] = []
    for match in pattern.finditer(masked):
        start_line = masked.count("\n", 0, match.start()) + 1
        params = [ParameterInfo(name=part.strip()) for part in _split_params(match.group(2).strip()) if part.strip()]
        depth = 0
        body_end = match.end() - 1
        for index in range(match.end() - 1, len(masked)):
            if masked[index] == "{":
                depth += 1
            elif masked[index] == "}":
                depth -= 1
                if depth == 0:
                    body_end = index
                    break
        end_line = min(len(lines), masked.count("\n", 0, body_end) + 1)
        functions.append(FunctionSignature(
            name=match.group(1), parameters=params, language=language,
            start_line=max(1, min(start_line, len(lines) or 1)),
            end_line=max(start_line, end_line),
            return_type=(match.group(3) or "").strip() or None,
        ))
    return functions


# ── Public API ───────────────────────────────────────────────────────────────


def parse_file(file_path: str) -> ParseResult:
    """Parse a source file and extract all function signatures.

    Uses tree-sitter if available, falls back to regex-based extraction.
    Returns a ParseResult with all discovered functions and any errors.
    """
    result = ParseResult(file_path=file_path, language="unknown")

    path = Path(file_path)
    if not path.exists():
        result.parse_errors.append(f"File not found: {file_path}")
        logger.error("File not found: %s", file_path)
        return result

    lang = detect_language(file_path)
    if lang is None:
        result.parse_errors.append(f"Unsupported file type: {path.suffix}")
        logger.warning("Unsupported file type: %s", path.suffix)
        return result

    result.language = lang.value

    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        result.parse_errors.append(f"Failed to read file: {exc}")
        logger.error("Failed to read %s: %s", file_path, exc)
        return result

    if not source.strip():
        logger.info("Empty file: %s", file_path)
        return result

    # Try tree-sitter first
    ts_parser = _get_ts_parser(lang)
    if ts_parser is not None:
        try:
            source_bytes = source.encode("utf-8")
            if lang == SupportedLanguage.PYTHON:
                result.functions = _extract_ts_python_functions(
                    source_bytes, file_path, ts_parser
                )
            else:
                result.functions = _extract_ts_typescript_functions(
                    source_bytes, file_path, ts_parser
                )
            logger.info(
                "Parsed %s with tree-sitter: %d functions",
                file_path, len(result.functions),
            )
            return result
        except Exception as exc:
            result.parse_errors.append(f"tree-sitter parse error: {exc}")
            logger.warning("tree-sitter failed for %s, falling back: %s", file_path, exc)

    # Regex fallback
    result.used_fallback = True
    try:
        if lang == SupportedLanguage.PYTHON:
            result.functions = _extract_python_functions_regex(source, file_path)
        elif lang == SupportedLanguage.GO:
            result.functions = _extract_go_functions_regex(source, file_path)
        elif lang == SupportedLanguage.RUST:
            result.functions = _extract_rust_functions_regex(source, file_path)
        else:
            result.functions = _extract_typescript_functions_regex(source, file_path)
        logger.info(
            "Parsed %s with regex fallback: %d functions",
            file_path, len(result.functions),
        )
    except Exception as exc:
        result.parse_errors.append(f"Regex parse error: {exc}")
        logger.error("Regex parser failed for %s: %s", file_path, exc)

    return result


def extract_function_signature(
    file_path: str, function_name: str
) -> Optional[FunctionSignature]:
    """Parse a file and return the signature for a specific named function.

    Returns None if the file cannot be parsed or the function is not found.
    """
    result = parse_file(file_path)

    for fn in result.functions:
        if fn.name == function_name:
            logger.info(
                "Found function '%s' in %s (lines %d-%d)",
                function_name, file_path, fn.start_line, fn.end_line,
            )
            return fn

    logger.warning("Function '%s' not found in %s", function_name, file_path)
    return None


def extract_all_signatures(file_path: str) -> list[FunctionSignature]:
    """Parse a file and return all function signatures."""
    result = parse_file(file_path)
    return result.functions


# ── CLI Entry Point ──────────────────────────────────────────────────────────


def main() -> int:
    """CLI entry point for testing: python tree_sitter_cfg.py <file> [function]"""
    import sys as _sys

    if len(_sys.argv) < 2:
        print("Usage: python tree_sitter_cfg.py <file_path> [function_name]")
        return 1

    file_path = _sys.argv[1]
    func_name = _sys.argv[2] if len(_sys.argv) > 2 else None

    if func_name:
        sig = extract_function_signature(file_path, func_name)
        if sig:
            print(sig.to_json())
            return 0
        else:
            print(f"Function '{func_name}' not found.", file=_sys.stderr)
            return 1
    else:
        result = parse_file(file_path)
        print(json.dumps(result.to_dict(), indent=2))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
