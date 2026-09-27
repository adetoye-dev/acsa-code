"""app_db.py — the workbench's own database (SQLite, stdlib only).

Why this exists
───────────────
The app kept its real state in browser `localStorage`: the provider registry
*including API keys*, chat history, recent projects and assorted settings. That
is the wrong home for any of it — it is per-browser, invisible to the engine,
lost when the webview clears storage, and plaintext credentials sitting in a
web-accessible store. This module is the single owner of that state so both the
development bridge and the packaged app read the same rows.

Design notes
────────────
* **One owner.** Earlier iterations read the project index through a single-slot
  cache and answered with the previous project's data. There is one schema and
  one migration path here, and every reader goes through it.
* **Location.** A per-user data directory (see `data_dir`), overridable with
  `ACSA_DATA_DIR` so tests and portable installs do not touch the real one.
* **Secrets.** In the packaged app the UI never writes a credential here: the
  Rust shell keeps it in the OS keychain (`.tauri/src/main.rs`, `secrets_set`)
  and hands it to this process in the environment, which `resolve_api_key` reads
  first. This table is the **fallback** — a keychain that is not usable (a
  headless Linux box, a locked keyring, or a build the OS will not trust, where
  `secrets_set` answers `stored: "file"` with the reason) — and the store the
  dev bridge uses. Either way: a 0600 file rather than a browser store, never
  sent back to the UI in raw form (see `set_secret` / `has_secret`), and always
  overridden by the environment when one is set. No encryption at rest — the
  standard library has no authenticated cipher, and hand-rolling one would be
  worse than the file permissions.
"""

from __future__ import annotations

import datetime
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterable, Optional

SCHEMA_VERSION = 1

# How long a model call stays in the ledger. Far wider than the fourteen days the
# Performance page draws, so nothing on screen changes; the point is that the table
# has a ceiling at all. See `prune_usage`.
USAGE_RETENTION_DAYS = 90

# ── Location ────────────────────────────────────────────────────────────────


def data_dir() -> Path:
    """Directory holding the app's own state (database, logs, caches).

    Overridable with `ACSA_DATA_DIR`. Follows each platform's convention so a
    packaged build writes somewhere a user's backup tooling already covers.
    """
    override = (os.environ.get("ACSA_DATA_DIR") or "").strip()
    if override:
        path = Path(override).expanduser()
    elif os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        path = Path(base) / "ACSA Code"
    elif sys_platform() == "darwin":
        path = Path.home() / "Library" / "Application Support" / "ACSA Code"
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        path = Path(base) / "acsa-code"

    path.mkdir(parents=True, exist_ok=True)
    _restrict(path, 0o700)
    return path


def sys_platform() -> str:
    import sys

    return sys.platform


def db_path() -> Path:
    return data_dir() / "acsa.db"


def _restrict(path: Path, mode: int) -> None:
    """Best-effort chmod; Windows has no POSIX modes and that is fine."""
    try:
        os.chmod(path, mode)
    except OSError:
        pass


# ── Connection & migrations ──────────────────────────────────────────────────

MIGRATIONS: list[tuple[int, str]] = [
    (
        1,
        """
        -- Non-secret key/value settings (selected provider, onboarding flags,
        -- UI preferences). Previously scattered across localStorage keys.
        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at REAL NOT NULL
        );

        -- Provider configuration without credentials.
        CREATE TABLE IF NOT EXISTS providers (
            id               TEXT PRIMARY KEY,
            base_url         TEXT,
            selected_model   TEXT,
            available_models TEXT,
            updated_at       REAL NOT NULL
        );

        -- Credentials, write-mostly: the UI can set/clear and ask whether one is
        -- set, but never reads the value back.
        CREATE TABLE IF NOT EXISTS secrets (
            name       TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at REAL NOT NULL
        );

        -- Project registry (replaces the "recent projects" localStorage list) and
        -- the pointer to the project the workbench should reopen.
        CREATE TABLE IF NOT EXISTS projects (
            path           TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            last_opened_at REAL NOT NULL,
            is_active      INTEGER NOT NULL DEFAULT 0
        );

        -- Chat history, scoped per project (replaces the per-project
        -- localStorage blob).
        CREATE TABLE IF NOT EXISTS chat_messages (
            project_path TEXT NOT NULL,
            message_id   TEXT NOT NULL,
            role         TEXT NOT NULL,
            content      TEXT NOT NULL,
            provider     TEXT,
            model        TEXT,
            is_error     INTEGER NOT NULL DEFAULT 0,
            created_at   REAL NOT NULL,
            -- The full message object, so UI-only fields (attached images, step
            -- telemetry) survive a round trip. The columns above are the
            -- queryable projection of it.
            payload      TEXT,
            PRIMARY KEY (project_path, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_project_time
            ON chat_messages (project_path, created_at);

        -- Model usage ledger for the Performance page.
        CREATE TABLE IF NOT EXISTS usage_events (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            ts                REAL NOT NULL,
            project_path      TEXT,
            provider          TEXT,
            model             TEXT,
            prompt_tokens     INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            latency_ms        REAL NOT NULL DEFAULT 0,
            cost_usd          REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts);

        """,
    ),
]


# Secrets that are provided by the environment rather than the database.
_ENV_GENERIC_KEYS = ("ACSA_API_KEY", "AIDE_API_KEY")


def env_var_for_secret(name: str) -> str:
    """Map a secret name to its environment variable, e.g.
    `deepseek_api_key` → `ACSA_SECRET_DEEPSEEK_API_KEY`."""
    cleaned = "".join(ch if ch.isalnum() else "_" for ch in name).upper()
    return f"ACSA_SECRET_{cleaned}"


class _ScopedConnection(sqlite3.Connection):
    """A connection that closes when its `with` block ends.

    `with sqlite3.connect(...) as conn` only commits — it does **not** close the
    connection. Every reader here uses that form for a scoped read, so each one
    left an open handle until the garbage collector happened to reach it; Python
    3.14 says so out loud ("unclosed database") dozens of times per test run.
    Closing on exit is what the callers already mean, so say it once here rather
    than add a `finally: conn.close()` to thirty call sites.
    """

    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def connect() -> sqlite3.Connection:
    """Open the database with the pragmas this app relies on."""
    init_db()
    # umask so the database, its WAL and its SHM are created owner-only rather
    # than inheriting a permissive default.
    previous = os.umask(0o077)
    try:
        conn = sqlite3.connect(str(db_path()), timeout=10, factory=_ScopedConnection)
    finally:
        os.umask(previous)
    _restrict(db_path(), 0o600)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.DatabaseError:
        pass
    conn.execute("PRAGMA busy_timeout = 5000")
    for suffix in ("-wal", "-shm"):
        _restrict(Path(str(db_path()) + suffix), 0o600)
    return conn


def init_db() -> None:
    """Create or migrate the schema. Safe to call repeatedly and concurrently."""
    path = db_path()
    previous = os.umask(0o077)
    try:
        conn = sqlite3.connect(str(path), timeout=10)
    finally:
        os.umask(previous)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " version INTEGER PRIMARY KEY, applied_at REAL NOT NULL)"
        )
        applied = {
            row[0]
            for row in conn.execute("SELECT version FROM schema_migrations").fetchall()
        }
        for version, script in MIGRATIONS:
            if version in applied:
                continue
            conn.executescript(script)
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (version, time.time()),
            )
        conn.commit()
    finally:
        conn.close()
        _restrict(path, 0o600)


# ── Settings ────────────────────────────────────────────────────────────────


def get_settings() -> dict[str, Any]:
    with connect() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    out: dict[str, Any] = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except json.JSONDecodeError:
            out[row["key"]] = row["value"]
    return out


def set_setting(key: str, value: Any) -> None:
    if not key:
        raise ValueError("setting key cannot be empty")
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, json.dumps(value), time.time()),
        )


def delete_setting(key: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM settings WHERE key = ?", (key,))


# ── Providers (never includes credentials) ───────────────────────────────────


def get_providers() -> dict[str, dict[str, Any]]:
    providers: dict[str, dict[str, Any]] = {}
    with connect() as conn:
        for row in conn.execute("SELECT * FROM providers").fetchall():
            try:
                models = json.loads(row["available_models"] or "[]")
            except json.JSONDecodeError:
                models = []
            providers[row["id"]] = {
                "baseUrl": row["base_url"] or "",
                "selectedModel": row["selected_model"] or "",
                "availableModels": models,
                # Surfaced so the UI can show "key configured" without the key.
                # Read inside the block: the connection is scoped to it, and
                # reading it afterwards only ever worked while the connection
                # was leaking.
                "hasApiKey": has_secret(secret_name_for_provider(row["id"]), conn=conn),
            }
    return providers


def upsert_provider(
    provider_id: str,
    base_url: Optional[str] = None,
    selected_model: Optional[str] = None,
    available_models: Optional[Iterable[str]] = None,
) -> None:
    if not provider_id:
        raise ValueError("provider id cannot be empty")
    models_json = None if available_models is None else json.dumps(list(available_models))
    with connect() as conn:
        conn.execute(
            "INSERT INTO providers (id, base_url, selected_model, available_models, updated_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            "   base_url = COALESCE(excluded.base_url, providers.base_url),"
            "   selected_model = COALESCE(excluded.selected_model, providers.selected_model),"
            "   available_models = COALESCE(excluded.available_models, providers.available_models),"
            "   updated_at = excluded.updated_at",
            (provider_id, base_url, selected_model, models_json, time.time()),
        )


def secret_name_for_provider(provider_id: str) -> str:
    return f"{provider_id}_api_key"


# ── Secrets ─────────────────────────────────────────────────────────────────


def set_secret(name: str, value: str, conn: Optional[sqlite3.Connection] = None) -> None:
    """Store a credential. An empty value clears it."""
    if not name:
        raise ValueError("secret name cannot be empty")
    if not value:
        delete_secret(name, conn=conn)
        return
    own = conn is None
    conn = conn or connect()
    try:
        conn.execute(
            "INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (name, value, time.time()),
        )
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def delete_secret(name: str, conn: Optional[sqlite3.Connection] = None) -> None:
    own = conn is None
    conn = conn or connect()
    try:
        conn.execute("DELETE FROM secrets WHERE name = ?", (name,))
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def has_secret(name: str, conn: Optional[sqlite3.Connection] = None) -> bool:
    if os.environ.get(env_var_for_secret(name)):
        return True
    own = conn is None
    conn = conn or connect()
    try:
        row = conn.execute("SELECT 1 FROM secrets WHERE name = ?", (name,)).fetchone()
    finally:
        if own:
            conn.close()
    return row is not None


def get_secret(name: str) -> Optional[str]:
    """Raw credential for engine use. Never expose this through the UI layer."""
    env_value = os.environ.get(env_var_for_secret(name))
    if env_value:
        return env_value
    with connect() as conn:
        row = conn.execute("SELECT value FROM secrets WHERE name = ?", (name,)).fetchone()
    return row["value"] if row else None


def list_secret_names() -> list[str]:
    with connect() as conn:
        rows = conn.execute("SELECT name FROM secrets ORDER BY name").fetchall()
    names = [row["name"] for row in rows]
    for name in _env_secret_names():
        if name not in names:
            names.append(name)
    return sorted(names)


def _env_secret_names() -> list[str]:
    out = []
    for key in os.environ:
        if key.startswith("ACSA_SECRET_"):
            out.append(key[len("ACSA_SECRET_") :].lower())
    return out


def resolve_api_key(provider_id: str) -> Optional[str]:
    """Credential for a provider: environment first, then the database.

    Environment wins so CI, containers and headless runs never need a database,
    and so an operator can override a stored key without editing app state.
    """
    specific = f"ACSA_{provider_id.upper().replace('-', '_')}_API_KEY"
    for key in (specific, *_ENV_GENERIC_KEYS):
        value = (os.environ.get(key) or "").strip()
        if value:
            return value
    return get_secret(secret_name_for_provider(provider_id))


# ── Projects ────────────────────────────────────────────────────────────────


def touch_project(path: str, name: str, make_active: bool = True) -> None:
    if not path:
        raise ValueError("project path cannot be empty")
    now = time.time()
    with connect() as conn:
        if make_active:
            conn.execute("UPDATE projects SET is_active = 0 WHERE is_active = 1")
        conn.execute(
            "INSERT INTO projects (path, name, last_opened_at, is_active) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(path) DO UPDATE SET name = excluded.name,"
            "   last_opened_at = excluded.last_opened_at, is_active = excluded.is_active",
            (path, name or Path(path).name, now, 1 if make_active else 0),
        )


def list_projects(limit: int = 10) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT path, name, last_opened_at, is_active FROM projects"
            " ORDER BY last_opened_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    return [_flag_missing(dict(row)) for row in rows]


def _flag_missing(project: dict[str, Any]) -> dict[str, Any]:
    """Mark a remembered project whose folder is no longer on disk.

    A project row outlives its folder: the folder gets deleted, moved or renamed
    between sessions and the row stays. The switcher offers the three most recent,
    so a handful of dead rows can hide every project that still exists — eight
    deleted test projects sat above the two real ones, and "my recent projects
    don't appear in the switcher" was literally true.

    Flagged rather than deleted: a folder can come back (an unmounted volume, a
    rename), and dropping a user's history is not this function's call. The UI
    decides what to show; nothing is destroyed here.
    """
    path = str(project.get("path") or "")
    project["missing"] = not path or not os.path.isdir(path)
    return project


def forget_project(path: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM projects WHERE path = ?", (path,))
        conn.execute("DELETE FROM chat_messages WHERE project_path = ?", (path,))


def get_active_project() -> Optional[dict[str, Any]]:
    with connect() as conn:
        row = conn.execute(
            "SELECT path, name FROM projects WHERE is_active = 1 LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


def clear_active_project() -> None:
    with connect() as conn:
        conn.execute("UPDATE projects SET is_active = 0 WHERE is_active = 1")


# ── Chat history ────────────────────────────────────────────────────────────


def load_chat(project_path: str, limit: int = 200) -> list[dict[str, Any]]:
    if not project_path:
        return []
    with connect() as conn:
        rows = conn.execute(
            "SELECT message_id, role, content, provider, model, is_error, created_at, payload"
            " FROM chat_messages WHERE project_path = ? ORDER BY created_at ASC, rowid ASC"
            " LIMIT ?",
            (project_path, int(limit)),
        ).fetchall()
    messages: list[dict[str, Any]] = []
    for row in rows:
        message: dict[str, Any] = {
            "id": row["message_id"],
            "role": row["role"],
            "content": row["content"],
            "provider": row["provider"],
            "model": row["model"],
            "error": bool(row["is_error"]),
            "timestamp": int(row["created_at"] * 1000),
        }
        if row["payload"]:
            try:
                extra = json.loads(row["payload"])
                if isinstance(extra, dict):
                    # The stored object is authoritative; the columns above are a
                    # projection kept for querying.
                    message = {**message, **extra}
            except json.JSONDecodeError:
                pass
        messages.append(message)
    return messages


def save_chat(project_path: str, messages: list[dict[str, Any]]) -> None:
    """Replace this project's transcript with `messages` (last 200 kept)."""
    if not project_path:
        return
    trimmed = messages[-200:]
    with connect() as conn:
        conn.execute("DELETE FROM chat_messages WHERE project_path = ?", (project_path,))
        conn.executemany(
            "INSERT INTO chat_messages"
            " (project_path, message_id, role, content, provider, model, is_error, created_at, payload)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    project_path,
                    str(m.get("id") or f"msg-{index}"),
                    str(m.get("role") or "assistant"),
                    str(m.get("content") or ""),
                    m.get("provider"),
                    m.get("model"),
                    1 if m.get("error") else 0,
                    float(m.get("timestamp") or 0) / 1000.0 or time.time(),
                    json.dumps({k: v for k, v in m.items() if k != "isStreaming"}),
                )
                for index, m in enumerate(trimmed)
            ],
        )


def clear_chat(project_path: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM chat_messages WHERE project_path = ?", (project_path,))


# ── Usage ledger ────────────────────────────────────────────────────────────


# ── Usage & cost ledger ─────────────────────────────────────────────────────

# Approximate USD per 1M tokens: (input, output). Local models bill nothing, so
# an unknown provider is priced at zero rather than guessed at.
_PRICING: dict[str, tuple[float, float]] = {
    "openai": (2.50, 10.00),
    "anthropic": (3.00, 15.00),
    "google": (1.25, 5.00),
    "groq": (0.79, 0.79),
    "deepseek": (0.27, 1.10),
    "mistral": (0.20, 0.60),
    "moonshot": (0.60, 0.60),
    "xai": (2.00, 8.00),
    "together": (0.88, 0.88),
    "perplexity": (1.00, 1.00),
    "openrouter": (1.00, 3.00),
}


def estimate_cost_usd(
    provider: Optional[str], prompt_tokens: int, completion_tokens: int
) -> float:
    """Estimated USD for one call. Local and unknown providers cost 0."""
    price = _PRICING.get((provider or "").lower())
    if not price:
        return 0.0
    return (int(prompt_tokens or 0) / 1_000_000) * price[0] + (
        int(completion_tokens or 0) / 1_000_000
    ) * price[1]


def record_usage(
    provider: str,
    model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    latency_ms: float = 0.0,
    cost_usd: Optional[float] = None,
    project_path: Optional[str] = None,
) -> None:
    """Append one call. Cost is derived from the pricing table when not given.

    Callers were passing `cost_usd=0` for every hosted provider, which made the
    cost panel read `$0.00` while real money was being spent. Deriving it here
    means a caller cannot forget.
    """
    if cost_usd is None:
        cost_usd = estimate_cost_usd(provider, prompt_tokens, completion_tokens)
    with connect() as conn:
        conn.execute(
            "INSERT INTO usage_events"
            " (ts, project_path, provider, model, prompt_tokens, completion_tokens,"
            "  latency_ms, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                time.time(),
                project_path,
                provider,
                model,
                int(prompt_tokens or 0),
                int(completion_tokens or 0),
                float(latency_ms or 0.0),
                float(cost_usd or 0.0),
            ),
        )
        prune_usage(conn=conn)


def prune_usage(
    retention_days: int = USAGE_RETENTION_DAYS,
    conn: Optional[sqlite3.Connection] = None,
) -> int:
    """Drop ledger rows older than the retention window. Returns how many went.

    The ledger is append-only and was the one table nothing bounded — the chat is
    trimmed to its most recent messages, but every call ever made stayed here
    forever, at a row per model call, each with a project path and a model name.
    That is a slow leak rather than a bug, which is why it survived: nothing breaks
    until a database nobody looks at is large.

    Pruned on write rather than on a schedule or on read: there is no scheduler
    here, and a read that deletes is a read with a surprising side effect. The
    `ts` index makes it a range delete, and the window is far wider than the
    fourteen days the Performance page shows.
    """
    cutoff = time.time() - max(0, int(retention_days)) * 86_400
    own = conn is None
    conn = conn or connect()
    try:
        cursor = conn.execute("DELETE FROM usage_events WHERE ts < ?", (cutoff,))
        if own:
            conn.commit()
        return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    finally:
        if own:
            conn.close()


def usage_summary(
    project_path: Optional[str] = None, since_ts: float = 0.0, days: int = 14
) -> dict[str, Any]:
    """Totals, a per-model breakdown, a filled daily window and the latest rows.

    One shape serves the Performance page directly, so the UI does no arithmetic
    and there is no second aggregation to drift from this one.
    """
    clauses = ["ts >= ?"]
    params: list[Any] = [float(since_ts)]
    if project_path:
        clauses.append("project_path = ?")
        params.append(project_path)
    where = " AND ".join(clauses)
    with connect() as conn:
        totals = conn.execute(
            f"SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,"
            f" COALESCE(SUM(completion_tokens),0) AS completion_tokens,"
            f" COALESCE(SUM(cost_usd),0) AS cost_usd,"
            f" COALESCE(SUM(latency_ms),0) AS total_latency_ms"
            f" FROM usage_events WHERE {where}",
            params,
        ).fetchone()
        by_model = conn.execute(
            f"SELECT provider, model, COUNT(*) AS calls,"
            f" COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,"
            f" COALESCE(SUM(completion_tokens),0) AS completion_tokens,"
            f" COALESCE(SUM(cost_usd),0) AS cost_usd,"
            f" COALESCE(SUM(latency_ms),0) AS latency_ms"
            f" FROM usage_events WHERE {where} GROUP BY provider, model ORDER BY calls DESC",
            params,
        ).fetchall()
        daily_rows = conn.execute(
            f"SELECT ts, prompt_tokens, completion_tokens, cost_usd"
            f" FROM usage_events WHERE {where}",
            params,
        ).fetchall()
        recent = conn.execute(
            f"SELECT ts, provider, model, prompt_tokens, completion_tokens, latency_ms, cost_usd,"
            f" project_path FROM usage_events WHERE {where} ORDER BY ts DESC LIMIT 20",
            params,
        ).fetchall()

    # A complete window, so one busy day is a bar among quiet ones instead of
    # the whole chart.
    today = datetime.date.today()
    buckets: dict[str, dict[str, Any]] = {
        (today - datetime.timedelta(days=offset)).isoformat(): {
            "date": (today - datetime.timedelta(days=offset)).isoformat(),
            "calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "cost_usd": 0.0,
        }
        for offset in range(max(1, days) - 1, -1, -1)
    }
    for row in daily_rows:
        key = datetime.datetime.fromtimestamp(row["ts"]).date().isoformat()
        bucket = buckets.get(key)
        if bucket is None:
            continue
        bucket["calls"] += 1
        bucket["prompt_tokens"] += int(row["prompt_tokens"] or 0)
        bucket["completion_tokens"] += int(row["completion_tokens"] or 0)
        bucket["cost_usd"] = round(bucket["cost_usd"] + float(row["cost_usd"] or 0.0), 6)

    return {
        "total_calls": totals["calls"],
        "prompt_tokens": totals["prompt_tokens"],
        "completion_tokens": totals["completion_tokens"],
        "total_tokens": totals["prompt_tokens"] + totals["completion_tokens"],
        "cost_usd": round(totals["cost_usd"], 6),
        "total_latency_ms": round(totals["total_latency_ms"], 1),
        "by_model": [
            {**dict(row), "cost_usd": round(row["cost_usd"], 6), "latency_ms": round(row["latency_ms"], 1)}
            for row in by_model
        ],
        "daily": list(buckets.values()),
        "recent": [
            {**dict(row), "cost_usd": round(row["cost_usd"], 6)}
            for row in recent
        ],
    }
