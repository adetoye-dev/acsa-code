//! main.rs — Tauri Native Desktop Entry Point
//!
//! Launches the ACSA Code desktop application. The Python engine is the
//! backend: the frontend talks to it over IPC via `engine_call`, and the
//! Rust layer only owns host-level concerns such as windowing, the engine
//! sidecar, and local credential storage.
//!
//! 1. `engine_call` — Invokes a Python engine subcommand and returns its result.
//! 2. `fetch_system_metrics` — Samples host CPU/memory usage via the `sysinfo`
//!    crate to guard against thermal throttling during sandbox stress tests.

// Prevent the console window from appearing on Windows release builds
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex};
use sysinfo::System;
use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem};
use tauri::{Emitter, Manager, State};

// ── Data Structures ─────────────────────────────────────────────────────────



/// Single line of output from the orchestrator, streamed to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineOutputLine {
    pub line_number: usize,
    pub content: String,
    pub stream: String, // "stdout" or "stderr"
    pub is_json: bool,
}


/// Host system metrics snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct SystemMetrics {
    /// The host, as the Performance panel names it: `ACSA Local Engine (macos
    /// aarch64)`. The page has read `platform` and `architecture` since it was
    /// written and this struct never sent them, so that line read
    /// `(unknown unknown)` on every machine. Optional in the type, which is why
    /// nothing failed — see `tests/test_wire_contract.py`.
    pub platform: String,
    pub architecture: String,
    /// Logical cores. The page asks for `cpu_count`; this struct sent only
    /// `cpu_count_physical` and `cpu_count_logical`.
    pub cpu_count: usize,
    pub cpu_usage_percent: f32,
    pub cpu_count_physical: usize,
    pub cpu_count_logical: usize,
    pub memory_total_mb: f64,
    pub memory_used_mb: f64,
    pub memory_usage_percent: f64,
    /// Free/total/used for the volume the app is running from. The status bar
    /// showed `Disk: --` because nothing ever filled these in.
    pub disk_usage_percent: f64,
    pub disk_used_gb: f64,
    pub disk_total_gb: f64,
    pub disk_free_gb: f64,
    pub is_thermal_risk: bool,
    pub thermal_warning: String,
    pub timestamp_ms: u64,
}

/// Managed state: wraps sysinfo::System behind a mutex.
pub struct AppState {
    sys: Mutex<System>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    /// Last write time, ms since the epoch.
    ///
    /// The editor mirrors project files into Monaco's TypeScript worker and skips
    /// the ones it already has. Size alone cannot see an edit that kept the same
    /// length — a rename to an equal-length identifier — so a stale copy of a file
    /// would go on answering imports. Zero when the platform cannot say.
    pub modified_ms: u64,
    pub children: Option<Vec<FileNode>>,
}

/// How deep the tree walk goes.
///
/// It was 5, which is under `apps/api/migrations/app/<migration>/` — so a real
/// project's migration folders rendered as "(empty folder)" while every other
/// editor listed their contents, and the user's report was exactly that: "we stop
/// reading into those multi-level folders".
///
/// A depth cap cannot be picked well here. Anything shallow enough to bound a
/// pathological tree is shallow enough to hide an ordinary path in a monorepo, and
/// the number says nothing about why it was chosen. 64 is not a policy, it is a
/// backstop for the one case a cycle check cannot see — a filesystem that invents
/// new paths forever. What actually bounds the walk is the ignore list.
const MAX_TREE_DEPTH: usize = 64;

/// Directories the explorer never walks into.
///
/// This used to be "anything whose name starts with a dot", which is how `.env`,
/// `.gitignore`, `.github/` and `.vscode/` became invisible — files a developer
/// opens and edits constantly, hidden to avoid descending into caches. Naming the
/// caches keeps what the rule was for (never walking thousands of generated files)
/// without hiding the dotfiles people actually work in.
///
/// Deliberately not here: `build`, `coverage`, `out`. Every one of those is a
/// plausible *source* directory in some project, and the whole complaint this
/// replaces was a tree that hid things the user could see elsewhere.
const IGNORED_DIRS: [&str; 16] = [
    // Dependencies and build output.
    "node_modules",
    "__pycache__",
    "target",
    "dist",
    "venv",
    ".venv",
    // Version control, package stores and tool caches.
    ".git",
    ".pnpm-store",
    ".cache",
    ".turbo",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".gradle",
    ".dart_tool",
    ".pytest_cache",
];

fn build_file_tree(
    dir: &std::path::Path,
    depth: usize,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Vec<FileNode> {
    if depth == 0 || !dir.is_dir() {
        return Vec::new();
    }

    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            let is_dir = path.is_dir();
            // Directories only, and by name. A *file* called `dist` or a directory
            // called `.config` is something the user put there; hiding entries by
            // name is how `.env` came to be invisible.
            if is_dir && IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }

            let metadata = entry.metadata().ok();
            let size_bytes = if is_dir {
                0
            } else {
                metadata.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            let modified_ms = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let children = if is_dir {
                // A symlink pointing at one of its own ancestors is a cycle. Without
                // this the walk either recurses forever or — with a cap — fills the
                // tree with copies of the same folder. Canonicalising is the only
                // way to see that two paths are one directory; a failure to resolve
                // falls back to the path itself, which is the old behaviour.
                let real = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if visited.insert(real) {
                    Some(build_file_tree(&path, depth - 1, visited))
                } else {
                    Some(Vec::new())
                }
            } else {
                None
            };

            entries.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                size_bytes,
                modified_ms,
                children,
            });
        }
    }

    // Sort: directories first, then alphabetical by name
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}

// ── Tauri Commands: File & Project Management ───────────────────────────────

fn canonicalize_project_root(project_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_root);
    let absolute_root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to resolve current directory: {}", e))?
            .join(root)
    };

    Ok(absolute_root.canonicalize().unwrap_or(absolute_root))
}

fn resolve_project_path(project_root: &str, target_path: &str) -> Result<PathBuf, String> {
    let root = canonicalize_project_root(project_root)?;
    let target = PathBuf::from(target_path);
    let absolute_target = if target.is_absolute() {
        target
    } else {
        root.join(target)
    };

    if absolute_target
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!(
            "Refusing to resolve path outside the active project root: {}",
            target_path
        ));
    }

    let resolved = if absolute_target.exists() {
        absolute_target
            .canonicalize()
            .unwrap_or_else(|_| absolute_target.clone())
    } else {
        // Canonicalize the closest existing ancestor, then re-append the tail.
        let mut existing = absolute_target.clone();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            match existing.file_name() {
                Some(name) => tail.push(name.to_os_string()),
                None => break,
            }
            if !existing.pop() {
                break;
            }
        }
        let mut base = existing.canonicalize().unwrap_or(existing);
        for name in tail.into_iter().rev() {
            base.push(name);
        }
        base
    };

    if !resolved.starts_with(&root) {
        return Err(format!(
            "Refusing to access target outside the active project root: {}",
            target_path
        ));
    }

    Ok(resolved)
}

#[tauri::command]
fn list_project_files(project_path: String) -> Result<Vec<FileNode>, String> {
    let path = canonicalize_project_root(&project_path)?;
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", project_path));
    }
    // The root goes in first, so a link anywhere below that points back at it is
    // recognised rather than walked again.
    let mut visited = std::collections::HashSet::new();
    if let Ok(real) = std::fs::canonicalize(&path) {
        visited.insert(real);
    }
    Ok(build_file_tree(&path, MAX_TREE_DEPTH, &mut visited))
}

#[tauri::command]
fn read_file_content(file_path: String, project_root: String) -> Result<String, String> {
    let path = resolve_project_path(&project_root, &file_path)?;
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    // Cap at 2MB to prevent freezing
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("File exceeds 2MB limit for direct editing".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn write_file_content(file_path: String, content: String, project_root: String) -> Result<(), String> {
    let path = resolve_project_path(&project_root, &file_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn read_file_base64(file_path: String, project_root: String) -> Result<String, String> {
    let path = resolve_project_path(&project_root, &file_path)?;
    if !path.is_file() {
        return Err(format!("File not found: {}", file_path));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        other => match other {
            "ttf" | "otf" | "woff" | "woff2" => "font/ttf",
            _ => "application/octet-stream",
        },
    };
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64_encode(&bytes)
    ))
}

/// Standard base64 decode, the counterpart to `base64_encode`.
///
/// Attachments arrive from the webview as `data:` URLs, and the agent runtime
/// wants files, so this is the bridge. Hand-rolled for the same reason as the
/// encoder: one crate for twenty lines is not worth it, and a wrong decoder
/// would write corrupt images rather than fail loudly.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for ch in input.bytes() {
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err(format!("invalid base64 character: {}", ch as char)),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    Ok(output)
}

/// Write a `data:` URL into the runtime's own home and return the file.
///
/// Kept per app home rather than in the project, so an attachment never becomes
/// an untracked file in the user's repository.
fn write_attachment(codex_home: &Path, data_url: &str, index: usize) -> Option<PathBuf> {
    let (header, payload) = data_url.split_once(',')?;
    if !header.contains("base64") {
        return None;
    }
    let mime = header
        .trim_start_matches("data:")
        .split(';')
        .next()
        .unwrap_or("image/png");
    let extension = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        _ => "png",
    };
    let bytes = base64_decode(payload).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let dir = codex_home.join("attachments");
    std::fs::create_dir_all(&dir).ok()?;

    // A cheap content hash keeps repeat attachments from piling up, and gives the
    // name some stability when the same screenshot is sent twice.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in &bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    let path = dir.join(format!("{:016x}-{}.{}", hash, index, extension));
    if !path.exists() {
        std::fs::write(&path, &bytes).ok()?;
    }
    Some(path)
}

/// Keep the attachments directory bounded: it is screenshots, and they are big.
fn prune_attachments(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// Standard base64. Hand-rolled because the alternative is another crate for
/// twenty lines, and this is only ever used to inline a preview asset.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[tauri::command]
fn create_file_or_folder(path: String, is_dir: bool, project_root: String) -> Result<(), String> {
    let p = resolve_project_path(&project_root, &path)?;
    if is_dir {
        std::fs::create_dir_all(&p).map_err(|e| format!("Failed to create directory: {}", e))
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
        std::fs::write(&p, "").map_err(|e| format!("Failed to create file: {}", e))
    }
}

#[tauri::command]
fn delete_project_file(path: String, project_root: String) -> Result<(), String> {
    let p = resolve_project_path(&project_root, &path)?;
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"Select Project Directory:\")")
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if s.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(s.trim_end_matches('/').to_string()))
                }
            }
            _ => Ok(None),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

/// Escape a string for use inside an AppleScript double-quoted literal.
///
/// Gated to macOS because only macOS speaks AppleScript — but `test` is allowed
/// too, because `open_file_panel_script` below is built and asserted on every
/// platform, and a helper that exists only on the machine that runs the panel
/// leaves the script unbuildable everywhere else.
#[cfg(any(target_os = "macos", test))]
fn applescript_literal(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The user's home directory, read from the same variables the rest of the app
/// uses (`HOME` here, `USERPROFILE` on Windows).
fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Expand a leading `~` to the home directory.
///
/// Rust expands nothing: `~` is a shell feature. But the New Project dialog seeds
/// its destination with `~/AcsaProjects` and its placeholder suggests
/// `~/Desktop`, so without this the default path is read as *relative* to the
/// process working directory — `/` for a bundle launched from Finder — the write
/// is denied, and scaffolding from the default location fails for every user.
fn expand_home(path: &str) -> PathBuf {
    expand_home_against(path, user_home().as_deref())
}

/// `expand_home` with the home directory supplied, so the rules are testable
/// without mutating the process environment (which cargo's parallel test threads
/// would share).
fn expand_home_against(path: &str, home: Option<&Path>) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        if let Some(home) = home {
            return home.to_path_buf();
        }
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = home {
            return home.join(rest);
        }
    }
    // An absolute path, a relative path, and `~someone` are all left alone —
    // expanding another user's home is not ours to guess.
    PathBuf::from(trimmed)
}

/// Ask the user where to write a file that does not exist yet.
///
/// Separate from `pick_folder` because `choose folder` can only ever return a
/// directory, and a backup the user cannot name is a backup they cannot find
/// again. `choose file name` returns the path *without* creating anything, so
/// the write — and its owner-only mode — stays in our hands.
#[tauri::command]
fn pick_save_file(default_name: String, prompt: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        // Start at the Desktop instead of whatever folder the app last touched.
        // The panel otherwise opens inside the project directory, and a backup or
        // support bundle dropped into a repository is a file the user can commit
        // by accident — observed, not hypothetical: the first bundle written
        // through this path landed in a checked-out repo.
        let script = format!(
            "POSIX path of (choose file name with prompt \"{}\" default name \"{}\" default location (path to desktop folder))",
            applescript_literal(&prompt),
            applescript_literal(&default_name)
        );
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                Ok(if s.is_empty() { None } else { Some(s) })
            }
            // Cancelling is a choice, not a failure worth reporting.
            _ => Ok(None),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (default_name, prompt);
        Ok(None)
    }
}

/// The AppleScript that asks for a file, and where its panel opens.
///
/// Its own function because both halves come from the page: an unescaped quote in
/// either turns the script into a different script, which is the same reason
/// `applescript_literal` exists. Testable here, unlike the call itself, because the
/// call opens a window on someone's screen.
#[cfg(any(target_os = "macos", test))]
fn open_file_panel_script(prompt: &str, default_dir: Option<&str>) -> String {
    // Where the panel opens depends on what is being opened. A backup import
    // starts at the Desktop, because a bundle exported there is where the next
    // import should look. Opening a file in the editor starts in the project — a
    // panel that opens at the Desktop for that is a dozen clicks away from the
    // file the reader wants, and anything picked outside the project root comes
    // back as a refusal rather than as a tab.
    let location = match default_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
        Some(dir) => format!(" default location (POSIX file \"{}\")", applescript_literal(dir)),
        None => " default location (path to desktop folder)".to_string(),
    };
    format!(
        "POSIX path of (choose file with prompt \"{}\"{})",
        applescript_literal(prompt),
        location,
    )
}

/// Ask the user for an existing file to read — the import half of a backup, and
/// the editor's File ▸ Open File….
#[tauri::command]
fn pick_open_file(prompt: String, default_dir: Option<String>) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = open_file_panel_script(&prompt, default_dir.as_deref());
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();
        match output {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                Ok(if s.is_empty() { None } else { Some(s) })
            }
            _ => Ok(None),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (prompt, default_dir);
        Ok(None)
    }
}

/// Only http(s) ever reaches the OS opener. This takes a string from the page
/// and hands it to `open`/`explorer`/`xdg-open`, so the scheme is checked here
/// rather than trusted, and the argument is passed after `--` so a URL that
/// begins with a dash cannot become a flag.
fn is_openable_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && !lower.contains('\n')
}

/// Open a link in the user's browser. The webview cannot do this itself: a plain
/// anchor with `target="_blank"` is a dead click in a Tauri window, which is
/// exactly how every marketplace link behaved.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err(format!("refusing to open a non-http(s) url: {}", url));
    }

    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        // `start` is a shell builtin; `explorer` opens a URL without one.
        std::process::Command::new("explorer")
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command.arg("--").arg(url.trim());
    if command.status().is_err() {
        // Some openers reject `--`; retry without it rather than failing the click.
        #[cfg(target_os = "macos")]
        let mut retry = std::process::Command::new("open");
        #[cfg(target_os = "windows")]
        let mut retry = std::process::Command::new("explorer");
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut retry = std::process::Command::new("xdg-open");
        retry
            .arg(url.trim())
            .status()
            .map_err(|error| format!("could not open {}: {}", url, error))?;
    }
    Ok(())
}

/// A skill file with only the two keys the runtime documents. Our loader also
/// writes `triggers`, and an unknown key in someone else's frontmatter parser is
/// a gamble not worth taking with a file the agent has to load.
fn normalise_skill_markdown(raw: &str, fallback_name: &str) -> String {
    let trimmed = raw.trim_start_matches('\u{feff}');
    let mut name = fallback_name.to_string();
    let mut description = format!("Project skill {}", fallback_name);
    let mut body = trimmed.to_string();

    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let front = &rest[..end];
            body = rest[end + 4..].trim_start_matches(['\n', '\r']).to_string();
            for line in front.lines() {
                let Some((key, value)) = line.split_once(':') else { continue };
                let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
                match key.trim() {
                    "name" if !value.is_empty() => name = value,
                    "description" if !value.is_empty() => description = value,
                    _ => {}
                }
            }
        }
    }

    format!("---\nname: {}\ndescription: {}\n---\n\n{}", name, description, body.trim_start_matches(['\n', '\r']))
}

/// Copy the project's installed skills into the runtime's home.
///
/// The marketplace writes `<project>/.acsa/skills/<name>.md` — our loader's shape,
/// one flat file per skill. The runtime reads `<CODEX_HOME>/skills/<name>/SKILL.md`,
/// so a skill installed from the marketplace was invisible to the agent: the file
/// was real, in the wrong shape, in the wrong place. MCP servers are handed over in
/// the config; this is the same job for skills.
///
/// The destination is the app's own home (nothing else writes there), so it is
/// rebuilt from the project each run: that is also what makes uninstalling work.
///
/// Checked against the bundled runtime rather than assumed: with a skill mirrored
/// this way, `codex debug prompt-input` lists it in `<skills_instructions>` beside
/// the host's own skills — `verify-skill: … (file: r0/verify-skill/SKILL.md)`,
/// where `r0` is the CODEX_HOME this function writes into.
fn sync_project_skills(codex_home: &Path, project_root: &Path) -> Result<usize, String> {
    let source = project_root.join(".acsa").join("skills");
    let dest = codex_home.join("skills");
    std::fs::create_dir_all(&dest).map_err(|e| format!("could not create {}: {}", dest.display(), e))?;

    let mut wanted: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&source) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("could not read {}: {}", path.display(), e))?;
            let dir = dest.join(stem);
            std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
            std::fs::write(dir.join("SKILL.md"), normalise_skill_markdown(&raw, stem))
                .map_err(|e| format!("could not write the skill {}: {}", stem, e))?;
            wanted.push(stem.to_string());
        }
    }

    // Anything we wrote last run that is no longer installed goes with it.
    if let Ok(entries) = std::fs::read_dir(&dest) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if !wanted.iter().any(|kept| kept == name) {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }

    Ok(wanted.len())
}

/// Show a file or folder in the OS file manager, so "where is my data?" has an
/// answer that does not require the user to read a path out of a text box.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("no such path: {}", path));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&target);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", target.display()));
        c
    };
    // Linux has no portable "reveal in file manager"; opening the containing
    // directory is the closest honest equivalent.
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let directory = if target.is_dir() {
            target.clone()
        } else {
            target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.clone())
        };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(directory);
        c
    };

    command
        .spawn()
        .map_err(|e| format!("could not open the file manager: {}", e))?;
    Ok(())
}

#[tauri::command]
fn create_project_template(
    name: String,
    template: String,
    parent_dir: Option<String>,
) -> Result<String, String> {
    let clean_name = name.trim().replace(
        |c: char| !c.is_alphanumeric() && c != '-' && c != '_',
        "_",
    );
    if clean_name.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }

    let base = match parent_dir {
        Some(p) if !p.trim().is_empty() => expand_home(&p),
        // Named after the app: this folder is created in the user's home and is
        // the first thing they see if they scaffold without choosing a location.
        _ => match user_home() {
            Some(home) => home.join("ACSA Projects"),
            None => PathBuf::from("projects"),
        },
    };

    // Resolved before anything is created, so an unrecognised id cannot leave a
    // half-built directory behind.
    let files = template_files(&template.to_lowercase()).ok_or_else(|| {
        format!(
            "\"{}\" is not a template this build can scaffold — the New Project dialog and the scaffolder are out of step.",
            template
        )
    })?;

    let project_dir = base.join(&clean_name);
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project directory: {}", e))?;
    write_template_files(&project_dir, files, &clean_name)?;

    Ok(project_dir.to_string_lossy().to_string())
}

// ── Project templates ───────────────────────────────────────────────────────

/// One template's files: `(path relative to the project root, contents)`.
///
/// `__PROJECT_NAME__` is substituted as the files are written. The ids match the
/// ones `src/components/ProjectModal.tsx` offers, and a test below keeps the two
/// in step: every template the dialog advertises must produce the files its badge
/// promises. It did not use to — four of the six fell through to a catch-all that
/// wrote a Python `main.py`, so choosing "Next.js 15 App Router" (the default)
/// produced a Python hello-world.
type TemplateFiles = &'static [(&'static str, &'static str)];

const NEXTJS_TEMPLATE: TemplateFiles = &[
    (
        "package.json",
        r##"{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.1.6",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "^22.10.7",
    "@types/react": "^19.0.7",
    "@types/react-dom": "^19.0.3",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.3"
  }
}
"##,
    ),
    (
        "tsconfig.json",
        r##"{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
"##,
    ),
    (
        "next.config.ts",
        r##"import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
"##,
    ),
    (
        "postcss.config.mjs",
        r##"export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
"##,
    ),
    (
        "app/globals.css",
        r##"@import "tailwindcss";
"##,
    ),
    (
        "app/layout.tsx",
        r##"import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "__PROJECT_NAME__",
  description: "Created with ACSA Code",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
"##,
    ),
    (
        "app/page.tsx",
        r##"export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-2xl font-semibold">__PROJECT_NAME__</h1>
      <p className="text-sm text-zinc-500">
        Created with ACSA Code. Edit <code>app/page.tsx</code> to get started.
      </p>
    </main>
  );
}
"##,
    ),
];

const VITE_REACT_TEMPLATE: TemplateFiles = &[
    (
        "package.json",
        r##"{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.7",
    "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.3",
    "vite": "^6.0.7"
  }
}
"##,
    ),
    (
        "tsconfig.json",
        r##"{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "vite.config.ts"]
}
"##,
    ),
    (
        "vite.config.ts",
        r##"import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
"##,
    ),
    (
        "index.html",
        r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__PROJECT_NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
"##,
    ),
    (
        "src/main.tsx",
        r##"import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
"##,
    ),
    (
        "src/App.tsx",
        r##"import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">__PROJECT_NAME__</h1>
      <p className="text-sm text-zinc-500">
        Created with ACSA Code. Edit src/App.tsx to get started.
      </p>
      <button
        type="button"
        className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-white"
        onClick={() => setCount((value) => value + 1)}
      >
        count is {count}
      </button>
    </main>
  );
}
"##,
    ),
    (
        "src/index.css",
        r##"@import "tailwindcss";
"##,
    ),
];

const FASTAPI_TEMPLATE: TemplateFiles = &[
    (
        "main.py",
        r##"from fastapi import FastAPI

app = FastAPI(title="__PROJECT_NAME__")


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "online", "project": "__PROJECT_NAME__"}
"##,
    ),
    (
        "models.py",
        r##"from pydantic import BaseModel


class Item(BaseModel):
    name: str
    description: str | None = None
"##,
    ),
    ("requirements.txt", "fastapi>=0.110.0\nuvicorn>=0.28.0\npydantic>=2.0.0\n"),
    ("README.md", "# __PROJECT_NAME__\n\nFastAPI service created with ACSA Code.\n"),
];

const EXPRESS_TEMPLATE: TemplateFiles = &[
    (
        "server.js",
        r##"const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'online', project: '__PROJECT_NAME__' });
});

app.listen(port, () => console.log(`Server running on port ${port}`));
"##,
    ),
    (
        "package.json",
        r##"{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
"##,
    ),
    ("README.md", "# __PROJECT_NAME__\n\nExpress service created with ACSA Code.\n"),
];

const NESTJS_TEMPLATE: TemplateFiles = &[
    (
        "package.json",
        r##"{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch"
  },
  "dependencies": {
    "@nestjs/common": "^10.4.15",
    "@nestjs/core": "^10.4.15",
    "@nestjs/platform-express": "^10.4.15",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.9",
    "@nestjs/schematics": "^10.2.3",
    "@types/node": "^22.10.7",
    "typescript": "^5.7.3"
  }
}
"##,
    ),
    (
        "tsconfig.json",
        r##"{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
"##,
    ),
    (
        "nest-cli.json",
        r##"{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
"##,
    ),
    (
        "src/main.ts",
        r##"import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Listening on http://localhost:${port}`);
}

void bootstrap();
"##,
    ),
    (
        "src/app.module.ts",
        r##"import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
"##,
    ),
    (
        "src/app.controller.ts",
        r##"import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getStatus(): { status: string; project: string } {
    return this.appService.status();
  }
}
"##,
    ),
    (
        "src/app.service.ts",
        r##"import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  status(): { status: string; project: string } {
    return { status: "online", project: "__PROJECT_NAME__" };
  }
}
"##,
    ),
];

const SUPABASE_TEMPLATE: TemplateFiles = &[
    (
        "package.json",
        r##"{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.47.10",
    "express": "^4.21.2"
  }
}
"##,
    ),
    (
        ".env.example",
        r##"# Copy to .env and fill in from your Supabase project settings.
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
PORT=3000
"##,
    ),
    (
        "src/supabaseClient.js",
        r##"import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "SUPABASE_URL / SUPABASE_ANON_KEY are unset - copy .env.example to .env first.",
  );
}

// A placeholder keeps the process bootable while the credentials are missing, so
// the first thing the user sees is the warning above rather than a crash.
export const supabase = createClient(
  url ?? "http://localhost:54321",
  anonKey ?? "missing-anon-key",
);
"##,
    ),
    (
        "src/server.js",
        r##"import express from "express";
import { supabase } from "./supabaseClient.js";

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "online", project: "__PROJECT_NAME__" });
});

app.get("/health", async (_req, res) => {
  const { error } = await supabase.auth.getSession();
  res.json({ status: error ? "degraded" : "ok" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
"##,
    ),
];

/// The files a template id produces, or `None` when the id is not one this build
/// can scaffold. `None` is an error, not a default: silently substituting some
/// other project is how the picker came to lie about what it creates.
fn template_files(template: &str) -> Option<TemplateFiles> {
    match template {
        "nextjs" => Some(NEXTJS_TEMPLATE),
        "vite-react" => Some(VITE_REACT_TEMPLATE),
        "nestjs" => Some(NESTJS_TEMPLATE),
        "supabase" => Some(SUPABASE_TEMPLATE),
        "fastapi" => Some(FASTAPI_TEMPLATE),
        "express" => Some(EXPRESS_TEMPLATE),
        _ => None,
    }
}

/// Write a template out, creating directories as needed and reporting the first
/// failure. The previous code discarded every `write` result with `let _ =`, so a
/// template that could not be written still reported success.
fn write_template_files(
    project_dir: &Path,
    files: TemplateFiles,
    name: &str,
) -> Result<(), String> {
    for (relative, body) in files {
        let target = project_dir.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", relative, e))?;
        }
        std::fs::write(&target, body.replace("__PROJECT_NAME__", name))
            .map_err(|e| format!("Failed to write {}: {}", relative, e))?;
    }
    Ok(())
}

// ── Helper: Resolve the core-engine path ────────────────────────────────────

/// Words that introduce a credential. Ordered longest-first so `client_secret`
/// wins over `secret`.
const SECRET_KEYS: &[&str] = &[
    "acsa_codex_api_key",
    "acsa_secret_",
    "client_secret",
    "private_key",
    "access_token",
    "refresh_token",
    "authorization",
    "api_key",
    "api-key",
    "apikey",
    "password",
    "passwd",
    "env_key",
    "secret",
    "bearer",
    "token",
];

/// Shortest value worth masking. Below this, the "value" is prose — `token: 42`.
const MIN_SECRET_LEN: usize = 6;

const MASK: &str = "***";

/// What to do with one line of the child's stderr before the user reads it.
enum AgentLine {
    /// Show it as written (after redaction).
    Keep,
    /// Show this sentence instead.
    Replace(String),
    /// Do not show it at all.
    Hide,
}

/// Rewrite the runtime's internal bookkeeping into something a person can act on.
///
/// The runtime logs to stderr in its own tracing format, and some of that is not
/// news the user can use. The clearest case, measured on a real run of an
/// eight-file task: DeepSeek emits a malformed freeform patch twice, the runtime's
/// patch parser rejects it, and the rejection is handed back to the model as a
/// tool error — which is why the model then fixes it and the files appear. Printed
/// raw, with a tracing prefix and several hundred characters of the parser's own
/// header grammar, that recovered retry reads as "this app is broken", and it is
/// how a working outcome got reported as a defect.
///
/// Only the cause is kept, and the sentence says what is actually happening:
/// rejected before it was applied, and being retried. Nothing is hidden that
/// changes the outcome of the run — if the retry also fails, the agent says so in
/// the transcript like any other failure.
fn friendly_agent_line(line: &str) -> AgentLine {
    if line.contains("apply_patch verification failed") {
        let reason = line
            .split("verification failed:")
            .nth(1)
            .map(|rest| {
                // The parser appends its accepted-header grammar, which is a
                // paragraph. Keep the first clause and drop the rest.
                rest.split(" Valid ").next().unwrap_or(rest).trim()
            })
            .filter(|reason| !reason.is_empty())
            .unwrap_or("the patch did not parse");
        return AgentLine::Replace(format!(
            "patch rejected before it was applied ({reason}) — the agent is retrying with a corrected patch"
        ));
    }
    // The runtime resolves a model for its own internals — `gpt-5.6-luna`, for
    // auto-review and title generation — and warns that it has no metadata for it.
    // That is never the user's model: the app writes every one of the user's
    // models into `model_catalog_json` on each run, so an unknown slug here is
    // always one this app did not ask for, and the fallback metadata it warns
    // about is only that. Verified rather than assumed: auto-review still works
    // on a third-party provider with this warning present (a read-only sandbox
    // forced an approval and the write was approved). It was, however, the line
    // the user read as "the metadata errors".
    if line.contains("codex_models_manager") && line.contains("fallback model metadata") {
        return AgentLine::Hide;
    }
    // A provider that only implements chat completions is the most common way an
    // agent run fails on a non-OpenAI-compatible provider, and the runtime's own
    // words for it are ten lines of noise for one fact: five
    // `WARN ... retrying sampling request` lines, each with a body, and five
    // `ERROR: Reconnecting... n/5` lines. None of it says the useful part — that
    // the endpoint does not exist and retrying cannot help.
    //
    // Measured against the runtime this build ships, on three providers that
    // offer chat completions only, with the same config the app writes:
    //
    //     unexpected status 404 Not Found: Not found, url: https://api.anthropic.com/v1/responses
    //     unexpected status 404 Not Found: { },       url: https://api.mistral.ai/v1/responses
    //     unexpected status 404 Not Found: Unknown error, url: https://generativelanguage.googleapis.com/responses
    //
    // OpenAI and DeepSeek answer on the same path, which is why those two are the
    // providers that work — a property of the provider, not a preference here.
    // The URL is carried through because it is also what names a misconfigured
    // base URL (the `generativelanguage.googleapis.com` case above is exactly
    // that: Gemini's OpenAI-compatible surface lives under `/v1beta/openai`).
    if line.contains("404 Not Found") && line.contains("/responses") {
        let url = line
            .split("url: ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .map(|url| url.trim_end_matches(','))
            .filter(|url| !url.is_empty())
            .unwrap_or("this provider");
        return AgentLine::Replace(format!(
            "{url} answered 404 — this provider does not serve the Responses API the agent runtime \
             requires (it speaks Responses, not chat completions). The model still works in chat; \
             agent runs need a provider that implements Responses, as OpenAI and DeepSeek do."
        ));
    }
    // The retry the runtime prints around that 404 is the same sentence again,
    // with no information the line above does not already carry.
    if line.contains("Reconnecting...") {
        return AgentLine::Hide;
    }
    AgentLine::Keep
}

/// Mask credential-shaped text before it reaches a panel the user may screenshot.
///
/// The runtime's stderr is forwarded verbatim, and on purpose: it is the only
/// window into a failed run. But a runtime that dumps its environment or echoes a
/// header on failure would print a live key into the OUTPUT panel, which is easy
/// to screenshot and easy to paste into a bug report. So free-text channels are
/// masked, and anything we handed the child as a credential is masked wherever it
/// appears, whatever it looks like.
///
/// `agent:event` is deliberately *not* passed through here. It is JSON-RPC the UI
/// parses and answers, and an approval has to show the command it is really
/// approving — a masked command would be worse than a visible one.
fn redact_for_display(line: &str, known: &[String]) -> String {
    let mut out = line.to_string();

    // Whatever we put in the child's environment, wherever it turns up.
    for secret in known {
        if secret.len() >= MIN_SECRET_LEN && out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), MASK);
        }
    }

    let chars: Vec<char> = out.chars().collect();
    let lowered: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    // A value follows a *strong* separator. A plain space is not one, or prose
    // like "reading token counts" gets a hole punched in it.
    let strong_separator = |c: char| matches!(c, ':' | '=' | '"' | '\'');
    let blank = |c: char| matches!(c, ' ' | '\t');
    let ends_value = |c: char| strong_separator(c) || blank(c) || matches!(c, ',' | '}' | ']' | ';');

    let mut result = String::with_capacity(out.len());
    let mut i = 0;
    while i < chars.len() {
        let key = SECRET_KEYS.iter().find(|key| {
            let k: Vec<char> = key.chars().collect();
            i + k.len() <= lowered.len() && lowered[i..i + k.len()] == k[..]
        });

        let Some(key) = key else {
            result.push(chars[i]);
            i += 1;
            continue;
        };

        let klen = key.chars().count();
        let key_end = i + klen;
        let mut j = key_end;
        let mut saw_separator = false;
        while j < chars.len() {
            // `Bearer <token>` is separated by the space, and only by that.
            if strong_separator(chars[j]) || (*key == "bearer" && blank(chars[j])) {
                saw_separator = true;
                j += 1;
            } else if saw_separator && blank(chars[j]) {
                j += 1;
            } else {
                break;
            }
        }

        let value_start = j;
        while j < chars.len() && !ends_value(chars[j]) {
            j += 1;
        }
        let value: String = chars[value_start..j].iter().collect();

        // `Authorization: Bearer <token>` — the scheme is not the credential.
        if saw_separator && matches!(value.to_ascii_lowercase().as_str(), "bearer" | "basic") {
            let mut k = j;
            while k < chars.len() && blank(chars[k]) {
                k += 1;
            }
            let token_start = k;
            while k < chars.len() && !ends_value(chars[k]) {
                k += 1;
            }
            if k - token_start >= MIN_SECRET_LEN {
                result.extend(&chars[i..j]);
                result.extend(&chars[j..token_start]);
                result.push_str(MASK);
                i = k;
                continue;
            }
        }

        if saw_separator && j - value_start >= MIN_SECRET_LEN {
            // Keep the separator, mask only the value, so the line still reads.
            result.extend(&chars[i..value_start]);
            result.push_str(MASK);
            i = j;
            continue;
        }

        result.extend(&chars[i..key_end]);
        i = key_end;
    }
    result
}

/// Name of the frozen engine executable shipped as a Tauri sidecar.
///
/// Tauri strips the target-triple suffix when bundling, so at runtime it sits
/// next to the app executable under this plain name.
const ENGINE_BIN_NAME: &str = "acsa-engine";

/// Locate the frozen engine binary, if this build shipped one.
fn resolve_engine_bin(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Where Tauri places external binaries on macOS and Linux.
            candidates.push(dir.join(ENGINE_BIN_NAME));
        }
    }
    if let Some(resources) = resource_dir {
        // Packaged: the engine ships as a resource directory (`--onedir`), because a
        // onefile sidecar writes a new executable on every launch and macOS scans it
        // again each time — 8.5s per call versus 0.06s for a stable binary.
        candidates.push(
            resources
                .join("engine")
                .join(ENGINE_BIN_NAME)
                .join(ENGINE_BIN_NAME),
        );
        candidates.push(resources.join("engine").join(ENGINE_BIN_NAME));
        candidates.push(resources.join(ENGINE_BIN_NAME));
        candidates.push(resources.join("binaries").join(ENGINE_BIN_NAME));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// How to run an engine subcommand: the frozen binary when present, otherwise
/// the source tree through the system interpreter.
///
/// Returning `(program, leading_args)` keeps both paths identical at the call
/// site — the fallback simply prepends `python3 <entry point>`.
fn engine_invocation(resource_dir: Option<&Path>, subcommand: &str) -> (PathBuf, Vec<String>) {
    if let Some(bin) = resolve_engine_bin(resource_dir) {
        return (bin, vec![subcommand.to_string()]);
    }
    let entry = resolve_engine_dir(resource_dir).join("acsa_engine.py");
    (
        PathBuf::from("python3"),
        vec![entry.to_string_lossy().to_string(), subcommand.to_string()],
    )
}

/// Locate the bundled Python engine.
///
/// Order matters: a packaged app must read the copy shipped in its own resource
/// directory. The previous candidates were all build-machine paths
/// (`CARGO_MANIFEST_DIR`, a CWD-relative `core-engine`, an exe-relative dir),
/// none of which exist on a user's machine — so an installed build could not
/// find the engine at all and every AI action failed.
fn resolve_engine_dir(resource_dir: Option<&Path>) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Production: bundled as a Tauri resource.
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("core-engine"));
    }

    // 2. Development: from .tauri/src/ → ../../core-engine
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("core-engine"),
    );
    // 3. Development: relative to the working directory.
    candidates.push(PathBuf::from("core-engine"));
    // 4. Last resort: next to the executable.
    candidates.push(
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(&PathBuf::from("."))
            .join("core-engine"),
    );

    for candidate in &candidates {
        let manager = candidate.join("manager.py");
        if manager.exists() {
            return candidate.canonicalize().unwrap_or(candidate.clone());
        }
    }

    // Return the first candidate as default (will produce a clear error downstream)
    candidates[0].clone()
}

// ── Tauri Command: fetch_system_metrics ─────────────────────────────────────

/// Samples current host CPU and memory usage to detect thermal throttling.
/// Should be polled periodically by the frontend during sandbox stress tests.
#[tauri::command]
fn fetch_system_metrics(state: State<'_, AppState>) -> Result<SystemMetrics, String> {
    let mut sys = state
        .sys
        .lock()
        .map_err(|e| format!("Failed to acquire system lock: {}", e))?;

    // Refresh CPU and memory data
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let cpu_count_logical = cpus.len();

    // Calculate average CPU usage across all cores
    let cpu_usage: f32 = if cpu_count_logical > 0 {
        cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpu_count_logical as f32
    } else {
        0.0
    };

    let physical_cores = sys.physical_core_count().unwrap_or(cpu_count_logical);
    let mem_total = sys.total_memory() as f64 / (1024.0 * 1024.0);
    let mem_used = sys.used_memory() as f64 / (1024.0 * 1024.0);
    let mem_percent = if mem_total > 0.0 {
        (mem_used / mem_total) * 100.0
    } else {
        0.0
    };

    // Thermal risk heuristic: CPU > 85% sustained OR memory > 90%
    let is_thermal_risk = cpu_usage > 85.0 || mem_percent > 90.0;
    let thermal_warning = if cpu_usage > 85.0 {
        format!(
            "CPU usage at {:.1}% — risk of thermal throttling. Consider reducing concurrency.",
            cpu_usage
        )
    } else if mem_percent > 90.0 {
        format!(
            "Memory usage at {:.1}% — risk of OOM. Consider closing other applications.",
            mem_percent
        )
    } else {
        String::new()
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // The boot volume: what "Disk:" in a status bar means to a reader.
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let (disk_total, disk_free) = disks
        .list()
        .first()
        .map(|d| (d.total_space(), d.available_space()))
        .unwrap_or((0, 0));
    let gib = 1024.0 * 1024.0 * 1024.0;
    let disk_total_gb = round1(disk_total as f64 / gib);
    let disk_free_gb = round1(disk_free as f64 / gib);
    let disk_used_gb = round1(disk_total_gb - disk_free_gb);
    let disk_usage_percent = if disk_total_gb > 0.0 {
        round1((disk_used_gb / disk_total_gb) * 100.0)
    } else {
        0.0
    };

    Ok(SystemMetrics {
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        cpu_count: cpu_count_logical,
        cpu_usage_percent: (cpu_usage * 10.0).round() / 10.0,
        cpu_count_physical: physical_cores,
        cpu_count_logical,
        memory_total_mb: (mem_total * 10.0).round() / 10.0,
        memory_used_mb: (mem_used * 10.0).round() / 10.0,
        memory_usage_percent: (mem_percent * 10.0).round() / 10.0,
        disk_usage_percent,
        disk_used_gb,
        disk_total_gb,
        disk_free_gb,
        is_thermal_risk,
        thermal_warning,
        timestamp_ms: timestamp,
    })
}

// ── Tauri Commands: storage, processes, cleanup ─────────────────────────────
//
// These lived only in `vite-fs-bridge.ts`, so the Health & Performance page
// showed its defaults in a packaged build. Worse, its process list was
// hardcoded — invented CPU and memory numbers, including a row for a gauntlet
// that no longer exists. Real numbers come from `sysinfo` instead.

const MB: f64 = 1024.0 * 1024.0;

/// Total bytes under a directory, skipping the trees that must never be walked.
fn dir_size_bytes(dir: &Path) -> u64 {
    // `node_modules` and `.git` are huge and are never what is being cleaned;
    // walking them made the storage panel take seconds on a real project.
    let skip = ["node_modules", ".git", "target"];
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if skip.contains(&name.as_ref()) {
                    continue;
                }
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// Every directory named in `names` under `dir`, and what they add up to.
fn scan_named_dirs(dir: &Path, names: &[&str]) -> (usize, u64) {
    let mut count = 0usize;
    let mut size = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if names.contains(&name.as_ref()) {
                count += 1;
                size += dir_size_bytes(&path);
            } else if name != "node_modules" && name != ".git" {
                stack.push(path);
            }
        }
    }
    (count, size)
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Serialised as camelCase because the page reads `cpuPercent`/`memoryMb`: without
/// it serde writes `cpu_percent`/`memory_mb`, the fields arrive `undefined`, and the
/// row renders the unit with no number in front of it — which is how this was
/// reported. These three are the structs whose frontend types are camelCase; the
/// others across this boundary (`FileNode`, `SystemMetrics`, `PipelineOutputLine`)
/// are snake_case on both sides and agree. `tests/test_wire_contract.py` compares
/// all of them, because "the two sides agree" is not a thing to check by eye.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategory {
    pub id: String,
    pub name: String,
    pub objects: usize,
    pub size_mb: f64,
    pub reclaimable_mb: f64,
}

/// Serialised as camelCase because the page reads `cpuPercent`/`memoryMb`: without
/// it serde writes `cpu_percent`/`memory_mb`, the fields arrive `undefined`, and the
/// row renders the unit with no number in front of it — which is how this was
/// reported. These three are the structs whose frontend types are camelCase; the
/// others across this boundary (`FileNode`, `SystemMetrics`, `PipelineOutputLine`)
/// are snake_case on both sides and agree. `tests/test_wire_contract.py` compares
/// all of them, because "the two sides agree" is not a thing to check by eye.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMetrics {
    pub total_gb: f64,
    pub free_gb: f64,
    pub used_gb: f64,
    pub used_percent: f64,
    pub build_artifacts_mb: f64,
    pub cache_reclaimable_mb: f64,
    pub categories: Vec<StorageCategory>,
}

/// Serialised as camelCase because the page reads `cpuPercent`/`memoryMb`: without
/// it serde writes `cpu_percent`/`memory_mb`, the fields arrive `undefined`, and the
/// row renders the unit with no number in front of it — which is how this was
/// reported. These three are the structs whose frontend types are camelCase; the
/// others across this boundary (`FileNode`, `SystemMetrics`, `PipelineOutputLine`)
/// are snake_case on both sides and agree. `tests/test_wire_contract.py` compares
/// all of them, because "the two sides agree" is not a thing to check by eye.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningProcessItem {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_mb: f64,
    pub status: String,
    /// True for processes this app owns, so the panel can separate "what this
    /// app costs me" from whatever else the machine is doing.
    pub is_ours: bool,
}

/// Disk usage for the volume holding the project, plus what its caches occupy.
#[tauri::command]
fn fetch_system_storage(project_root: String) -> Result<StorageMetrics, String> {
    let root = PathBuf::from(if project_root.trim().is_empty() {
        ".".to_string()
    } else {
        project_root
    });
    let root = root.canonicalize().unwrap_or(root);

    let disks = sysinfo::Disks::new_with_refreshed_list();
    // The volume the project lives on, not simply the boot disk — they differ
    // whenever someone works from an external drive.
    let disk = disks
        .list()
        .iter()
        .filter(|d| root.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .or_else(|| disks.list().first());
    let (total_bytes, free_bytes) = disk
        .map(|d| (d.total_space(), d.available_space()))
        .unwrap_or((0, 0));
    let total_gb = round1(total_bytes as f64 / (1024.0 * 1024.0 * 1024.0));
    let free_gb = round1(free_bytes as f64 / (1024.0 * 1024.0 * 1024.0));
    let used_gb = round1(total_gb - free_gb);
    let used_percent = if total_gb > 0.0 {
        round1((used_gb / total_gb) * 100.0)
    } else {
        0.0
    };

    let dist = root.join("dist");
    let vite_cache = root.join("node_modules").join(".vite");
    let logs_temp = root.join("logs-temp");
    let (pycache_count, pycache_bytes) =
        scan_named_dirs(&root, &["__pycache__", ".pytest_cache", ".mypy_cache"]);

    let dist_bytes = if dist.is_dir() { dir_size_bytes(&dist) } else { 0 };
    let vite_bytes = if vite_cache.is_dir() {
        dir_size_bytes(&vite_cache)
    } else {
        0
    };
    let logs_bytes = if logs_temp.is_dir() {
        dir_size_bytes(&logs_temp)
    } else {
        0
    };
    let dist_objects = std::fs::read_dir(&dist).map(|it| it.count()).unwrap_or(0);

    let categories = vec![
        StorageCategory {
            id: "build-artifacts".into(),
            name: "Build Output (dist)".into(),
            objects: dist_objects,
            size_mb: round1(dist_bytes as f64 / MB),
            reclaimable_mb: round1(dist_bytes as f64 / MB),
        },
        StorageCategory {
            id: "vite-cache".into(),
            name: "Vite Cache".into(),
            objects: usize::from(vite_bytes > 0),
            size_mb: round1(vite_bytes as f64 / MB),
            reclaimable_mb: round1(vite_bytes as f64 / MB),
        },
        StorageCategory {
            id: "pycache".into(),
            name: "Python Bytecode (__pycache__)".into(),
            objects: pycache_count,
            size_mb: round1(pycache_bytes as f64 / MB),
            reclaimable_mb: round1(pycache_bytes as f64 / MB),
        },
        StorageCategory {
            id: "logs-temp".into(),
            name: "Logs & Temp Buffers".into(),
            objects: 0,
            size_mb: round1(logs_bytes as f64 / MB),
            reclaimable_mb: round1(logs_bytes as f64 / MB),
        },
    ];

    Ok(StorageMetrics {
        total_gb,
        free_gb,
        used_gb,
        used_percent,
        build_artifacts_mb: round1(dist_bytes as f64 / MB),
        cache_reclaimable_mb: round1(
            (dist_bytes + vite_bytes + pycache_bytes + logs_bytes) as f64 / MB,
        ),
        categories,
    })
}

/// The heaviest processes on the host, with this app's own children marked.
#[tauri::command]
fn fetch_system_processes(state: State<'_, AppState>) -> Result<Vec<RunningProcessItem>, String> {
    let mut sys = state
        .sys
        .lock()
        .map_err(|e| format!("Failed to acquire system lock: {}", e))?;
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut items: Vec<RunningProcessItem> = sys
        .processes()
        .values()
        .map(|p| {
            let cmdline = p
                .cmd()
                .iter()
                .map(|c| c.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            let exe = p
                .exe()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default();
            let haystack = format!("{} {}", exe, cmdline);
            let name = p.name().to_string_lossy().to_string();
            RunningProcessItem {
                pid: p.pid().as_u32(),
                name: if name.is_empty() {
                    cmdline.chars().take(40).collect()
                } else {
                    name
                },
                cpu_percent: round1(f64::from(p.cpu_usage())),
                memory_mb: round1(p.memory() as f64 / MB),
                status: p.status().to_string(),
                is_ours: haystack.contains("acsa-engine")
                    || haystack.contains("engine-codex")
                    || haystack.contains("pty_bridge")
                    || haystack.contains("ACSA Code"),
            }
        })
        .collect();

    // Ours first, then the machine's heaviest.
    items.sort_by(|a, b| {
        b.is_ours.cmp(&a.is_ours).then(
            b.memory_mb
                .partial_cmp(&a.memory_mb)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    items.truncate(10);
    Ok(items)
}

/// Delete regenerable caches inside the project and report what came back.
#[tauri::command]
fn system_cleanup(project_root: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(project_root.trim());
    if !root.is_dir() {
        return Err("The project folder is not open, so there is nothing to clean.".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    // Refuse a filesystem root: this deletes directories, and "clean everything
    // under /" is not a thing anyone means.
    if root.parent().is_none() {
        return Err("Refusing to clean a filesystem root.".into());
    }

    let mut reclaimed = 0u64;
    let mut removed: Vec<String> = Vec::new();
    for (label, path) in [
        ("dist", root.join("dist")),
        ("node_modules/.vite", root.join("node_modules").join(".vite")),
        ("logs-temp", root.join("logs-temp")),
    ] {
        if path.is_dir() {
            let size = dir_size_bytes(&path);
            if std::fs::remove_dir_all(&path).is_ok() {
                reclaimed += size;
                removed.push(label.to_string());
            }
        }
    }

    // `__pycache__` has no single parent, so it is cleared by walking. Anything
    // else under the root is left exactly where it is.
    let mut stack = vec![root.clone()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if matches!(name.as_ref(), "__pycache__" | ".pytest_cache" | ".mypy_cache") {
                let size = dir_size_bytes(&path);
                if std::fs::remove_dir_all(&path).is_ok() {
                    reclaimed += size;
                    removed.push(name.to_string());
                }
            } else if name != "node_modules" && name != ".git" && name != "target" {
                stack.push(path);
            }
        }
    }

    let reclaimed_mb = round1(reclaimed as f64 / MB);
    Ok(serde_json::json!({
        "success": true,
        "reclaimedMb": reclaimed_mb,
        "removed": removed,
        "message": format!(
            "Reclaimed {:.1} MB of regenerable caches — build output, bytecode and temporary buffers only.",
            reclaimed_mb
        ),
    }))
}

// ── Tauri Command: engine_call ──────────────────────────────────────────────

/// Run an engine subcommand and return its JSON envelope.
///
/// Everything the UI read from `/api/app/*` and `/api/ollama/*` was implemented
/// in `vite-fs-bridge.ts`, a Vite dev-server middleware. `configureServer` never
/// runs in a build, so a packaged app had no way to reach the database or Ollama
/// at all — it fell back to built-in defaults, which showed up as an unconfigured
/// provider list and "Ollama is not installed" on a machine where Ollama was
/// running. This exposes the same engine surface over IPC instead.
///
/// Whitelisted on purpose: this is a bridge to the bundled engine, not a general
/// command runner.
/// How long an engine subcommand may run before it is treated as wedged.
///
/// Generous on purpose: a full index of a large project and a cloud model call
/// both legitimately take a while. What this bounds is the case with no upper
/// bound at all — verified on a real machine: with a macOS file-access prompt
/// waiting to be answered, the engine sat inside a single `open()` syscall for
/// minutes, so the UI spun forever and every hanging call left a live process
/// behind it.
const ENGINE_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Run a command to completion, draining both pipes, or kill it at the deadline.
///
/// The pipes are drained on their own threads rather than polled: several
/// subcommands emit more than a pipe buffer's worth of JSON (`index` returns the
/// whole symbol table), and a child blocked writing to a full pipe looks exactly
/// like a hung one if nobody is reading.
/// `run_with_timeout`, with environment variables for the child.
///
/// A separate function rather than a parameter on every caller: most of them want
/// a clean environment, and the one that does not is handing over credentials.
fn run_with_timeout_env(
    program: &Path,
    args: &[String],
    envs: &[(String, String)],
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    use std::io::Read;

    let mut child = Command::new(program)
        .args(args)
        .envs(envs.iter().map(|(key, value)| (key.as_str(), value.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run the engine: {}", e))?;

    let stdout = child.stdout.take().ok_or("could not capture engine output")?;
    let stderr = child.stderr.take().ok_or("could not capture engine errors")?;
    let stdout_thread = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::BufReader::new(stdout).read_to_end(&mut buffer);
        buffer
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = std::io::BufReader::new(stderr).read_to_end(&mut buffer);
        buffer
    });

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "the engine did not respond within {}s and was stopped",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(format!("could not wait for the engine: {}", e)),
        }
    };

    Ok(std::process::Output {
        status,
        stdout: stdout_thread.join().unwrap_or_default(),
        stderr: stderr_thread.join().unwrap_or_default(),
    })
}

/// Engine subcommands the renderer is allowed to reach over IPC.
///
/// This is a security boundary rather than a convenience list: every entry is a
/// subcommand the *page* chooses, so everything here is reachable even if the
/// page is compromised. `pty` and `adapter` are deliberately absent — the
/// terminal and the local-model adapter are spawned by Rust with arguments Rust
/// picked, not with arguments the webview supplies.
const ALLOWED_ENGINE_SUBCOMMANDS: [&str; 15] = [
    "db", "ollama", "index", "git", "gh", "indexer", "skills", "mcp", "ai", "project", "fs",
    "backup", "support", "snapshot", "crash",
];

fn engine_subcommand_allowed(subcommand: &str) -> bool {
    ALLOWED_ENGINE_SUBCOMMANDS.contains(&subcommand)
}

#[tauri::command]
async fn engine_call(
    app_handle: tauri::AppHandle,
    subcommand: String,
    args: Vec<String>,
) -> Result<String, String> {
    if !engine_subcommand_allowed(&subcommand) {
        return Err(format!("engine subcommand not allowed: {}", subcommand));
    }

    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), &subcommand);
    argv.extend(args);

    // Any credential the keychain holds, for the engine's own lookups. The engine
    // resolves secrets environment-first, which is what lets a keychain-only
    // credential reach it without the sidecar knowing anything about keychains.
    let secrets = engine_env_secrets(&app_handle);
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_with_timeout_env(&program, &argv, &secrets, ENGINE_CALL_TIMEOUT)
    })
    .await
    .map_err(|e| format!("engine task failed: {}", e))?
    ?;

    // The engine writes structured log lines before its result, so the envelope
    // is the last non-empty line — the same rule the dev bridge uses.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::to_string);

    match last {
        Some(line) => Ok(line),
        None => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(if stderr.trim().is_empty() {
                format!("engine {} produced no output", subcommand)
            } else {
                stderr.trim().to_string()
            })
        }
    }
}

// ── Interactive terminal (PTY) ──────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct TerminalChunk {
    /// Which shell this came from. Restarting kills the previous child, whose reader
    /// thread then reports exit — without this the new session is marked dead by the
    /// old one's parting message, and the terminal only works after a full reload.
    pid: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    pid: u32,
}

/// The PTY child backing the integrated terminal.
///
/// The dev bridge owned this: it spawned `scripts/pty_bridge.py` and pushed the
/// byte stream to the browser over server-sent events. A packaged app has no Node
/// process, so the child is spawned here and its output is emitted as Tauri
/// events instead. `pty_bridge.py` itself is unchanged — it already speaks
/// newline-delimited JSON on stdin and a raw byte stream on stdout.
pub struct TerminalState {
    child: Mutex<Option<std::process::Child>>,
}

impl TerminalState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// Minimal JSON string escaping for the PTY control channel. Keeps the terminal
/// off a JSON dependency for one small message shape.
fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn pty_send(child: &mut std::process::Child, message: &str) -> Result<(), String> {
    use std::io::Write;
    let stdin = child.stdin.as_mut().ok_or("terminal stdin is closed")?;
    stdin
        .write_all(format!("{}\n", message).as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("could not write to the terminal: {}", e))
}

/// Start (or restart) the shell. Mirrors `/api/terminal/spawn`.
#[tauri::command]
fn terminal_spawn(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,
    cols: u32,
    rows: u32,
) -> Result<u32, String> {
    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        if let Some(mut previous) = guard.take() {
            let _ = pty_send(&mut previous, "{\"action\":\"kill\"}");
            let _ = previous.kill();
        }
    }

    let working_dir = if Path::new(&cwd).is_dir() {
        cwd
    } else {
        std::env::var("HOME").unwrap_or_else(|_| ".".to_string())
    };

    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), "pty");
    argv.extend([
        "--cwd".to_string(),
        working_dir,
        "--cols".to_string(),
        cols.max(10).to_string(),
        "--rows".to_string(),
        rows.max(4).to_string(),
    ]);

    let mut child = Command::new(&program)
        .args(&argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the terminal: {}", e))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture terminal output".to_string())?;

    let pid = child.id();
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

    // Raw PTY bytes are forwarded as they arrive; the reader thread owns stdout.
    let app_for_reader = app_handle.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let _ = app_for_reader.emit("terminal:data", TerminalChunk { pid, data });
                }
            }
        }
        let _ = app_for_reader.emit("terminal:exit", TerminalExit { pid });
    });

    let _ = app_handle.emit(
        "terminal:data",
        TerminalChunk {
            pid,
            data: "\r\n\u{1b}[38;5;39m[Interactive PTY Shell Connected]\u{1b}[0m\r\n".to_string(),
        },
    );

    Ok(pid)
}

/// Forward keystrokes. Mirrors `/api/terminal/input`; a missing shell is not an
/// error, because the client fires these optimistically while a shell is starting.
#[tauri::command]
fn terminal_input(state: State<'_, TerminalState>, data: String) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let Some(child) = guard.as_mut() else {
        return Ok(());
    };
    let message = format!("{{\"action\":\"stdin\",\"data\":\"{}\"}}", json_escape(&data));
    pty_send(child, &message)
}

/// Forward a window resize. Mirrors `/api/terminal/resize`.
#[tauri::command]
fn terminal_resize(state: State<'_, TerminalState>, cols: u32, rows: u32) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let Some(child) = guard.as_mut() else {
        return Ok(());
    };
    let message = format!(
        "{{\"action\":\"resize\",\"cols\":{},\"rows\":{}}}",
        cols.max(10),
        rows.max(4)
    );
    pty_send(child, &message)
}

// ── Streaming chat ──────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct AiFrame {
    line: String,
}

/// The in-flight chat child, so a stream can actually be cancelled.
///
/// The dev bridge owned this and streamed server-sent events. A packaged app has no
/// server, so the engine's NDJSON frames are forwarded as Tauri events instead —
/// the same move the terminal made. Frames go out raw and the frontend parses them,
/// which keeps this side free of a JSON dependency for one message shape.
pub struct ChatState {
    child: Mutex<Option<std::process::Child>>,
}

impl ChatState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

#[tauri::command]
async fn chat_stream(
    app_handle: tauri::AppHandle,
    state: State<'_, ChatState>,
    payload: String,
) -> Result<(), String> {
    if let Some(mut previous) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = previous.kill();
    }

    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), "ai");
    argv.push("chat".to_string());
    argv.push(payload);

    let mut child = Command::new(&program)
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        // Name the path: if resolution is what failed, that is the whole diagnosis.
        .map_err(|e| format!("could not start the assistant ({}): {}", program.display(), e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture assistant output".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "could not capture assistant errors".to_string())?;

    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

    let app_for_reader = app_handle.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Read};
        let app_for_stderr = app_for_reader.clone();
        // Errors first: a failed run prints nothing useful on stdout, and that
        // message is what the user needs to see.
        let stderr_thread = std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = stderr.read_to_string(&mut buffer);
            buffer
        });

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_for_reader.emit("ai:frame", AiFrame { line });
        }

        let stderr_text = stderr_thread.join().unwrap_or_default();
        let _ = app_for_stderr.emit("ai:exit", stderr_text.trim().to_string());
    });

    Ok(())
}

#[tauri::command]
fn chat_cancel(state: State<'_, ChatState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = child.kill();
    }
    Ok(())
}

// ── Ollama model downloads ──────────────────────────────────────────────────

/// Its own slot, not the chat's: cancelling a chat must not kill a model
/// download, and cancelling a download must not kill a chat.
pub struct OllamaState {
    child: Mutex<Option<std::process::Child>>,
}

impl OllamaState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

/// Run an engine `ollama` subcommand and forward its NDJSON frames as
/// `ollama:frame` events.
///
/// One helper for both heavy local-engine jobs — pulling a model and installing
/// the engine — because a download that takes minutes and can fail halfway
/// needs the same streaming treatment either way, and they report the same
/// frame shape. They also share the one cancellation slot: an install and a pull
/// are both multi-hundred-megabyte transfers, and running two at once is not
/// something a user wants to discover.
fn spawn_ollama_stream(
    app_handle: &tauri::AppHandle,
    state: &OllamaState,
    args: &[String],
) -> Result<(), String> {
    if let Some(mut previous) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = previous.kill();
    }

    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), "ollama");
    argv.extend(args.iter().cloned());

    let mut child = Command::new(&program)
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {} ({}): {}", argv.join(" "), program.display(), e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture engine output".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "could not capture engine errors".to_string())?;
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

    let app_for_reader = app_handle.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Read};
        let stderr_handle = app_for_reader.clone();
        let stderr_thread = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_for_reader.emit("ollama:frame", AiFrame { line });
        }
        let stderr_text = stderr_thread.join().unwrap_or_default();
        let _ = stderr_handle.emit("ollama:exit", stderr_text.trim().to_string());
    });

    Ok(())
}

/// Download a model, streaming progress as `ollama:frame` events.
///
/// The engine talks to Ollama's own `/api/pull`; this only forwards its frames.
#[tauri::command]
async fn ollama_pull(
    app_handle: tauri::AppHandle,
    state: State<'_, OllamaState>,
    model: String,
) -> Result<(), String> {
    spawn_ollama_stream(
        &app_handle,
        &state,
        &["pull".to_string(), format!("{{\"model\":\"{}\"}}", model)],
    )
}

/// Fetch Ollama itself and unpack it into the app's own data directory.
///
/// The user should never have to leave the app, find the right build for their
/// chip and drag it somewhere — that was the old behaviour, and it read as the
/// app refusing to do its job. The engine downloads Ollama's own published
/// release and unpacks it; no administrator password, nothing written outside
/// the app's folder.
#[tauri::command]
async fn ollama_install(
    app_handle: tauri::AppHandle,
    state: State<'_, OllamaState>,
) -> Result<(), String> {
    spawn_ollama_stream(&app_handle, &state, &["install".to_string(), "{}".to_string()])
}

#[tauri::command]
fn ollama_cancel(state: State<'_, OllamaState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = child.kill();
    }
    Ok(())
}

// ── Codex agent runtime ─────────────────────────────────────────────────────

const CODEX_BIN_NAME: &str = "codex";

/// Locate the Codex CLI fetched by `scripts/fetch_codex_sidecar.sh`.
///
/// Packaged builds read it from their own resources; a source checkout reads the
/// git-ignored `.tauri/engine-codex/` copy, the same arrangement as the engine.
fn resolve_codex_bin(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("engine-codex").join(CODEX_BIN_NAME));
        candidates.push(resources.join(CODEX_BIN_NAME));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("engine-codex")
            .join(CODEX_BIN_NAME),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(CODEX_BIN_NAME));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Resolve a provider credential through the engine.
///
/// The key must not travel over IPC: passing it down from the frontend would undo the
/// write-only property the credential migration established, and it is already in the
/// engine's database. Same server-side resolution the review and inline-edit paths use.
/// The keychain service these credentials are grouped under.
const KEYCHAIN_SERVICE: &str = "ACSA Code";

/// Where a provider credential is kept.
///
/// A trait rather than a direct call so the migration below can be tested without
/// touching the real keychain — and not with the crate's own mock, which keeps its
/// data *inside* each credential object: a freshly built `Entry` starts empty, so
/// it cannot exercise a write-then-read-back, which is the one thing worth proving.
trait SecretStore {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    /// Remove a credential. Used when the *user* removes one — the migration's own
    /// delete is a separate, deferred step.
    fn delete(&self, name: &str) -> Result<(), String>;
}

struct KeychainStore;

impl SecretStore for KeychainStore {
    fn get(&self, name: &str) -> Option<String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).ok()?;
        entry.get_password().ok().filter(|value| !value.trim().is_empty())
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())?;
        // Read it back through a *fresh* entry before reporting success. A store
        // that accepts a write and cannot return it is worse than one that
        // refused, because the caller's next step is to delete its own copy.
        let check = keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())?;
        match check.get_password() {
            Ok(readback) if readback == value => Ok(()),
            Ok(_) => Err("the keychain returned a different value than it was given".to_string()),
            Err(e) => Err(format!("the keychain accepted the write but could not read it back: {e}")),
        }
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Already gone is the outcome the caller wanted.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

}

/// The engine spells a provider's credential `{provider}_api_key`; this is that
/// name, in one place so the two sides cannot drift.
fn secret_name_for_provider(provider: &str) -> String {
    format!("{provider}_api_key")
}

/// Where the *names* of keychain-held credentials are kept.
///
/// An OS keychain cannot be enumerated — a property of the API, not of this code —
/// so "which providers are connected?" needs a list somewhere. This is names only:
/// nothing here is sensitive, and the credential itself never appears.
const SECRET_NAMES_SETTING: &str = "secret_names";

/// Call the engine and return its `data`, or `None` for any failure.
///
/// Every caller of this has somewhere else to look, so a failed call is not an
/// error to propagate — it is a missing answer.
fn engine_json(
    app_handle: &tauri::AppHandle,
    subcommand: &str,
    args: &[String],
) -> Option<serde_json::Value> {
    if !engine_subcommand_allowed(subcommand) {
        return None;
    }
    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), subcommand);
    argv.extend(args.iter().cloned());
    let output = Command::new(&program).args(&argv).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout.lines().rev().find(|line| !line.trim().is_empty())?;
    let parsed: serde_json::Value = serde_json::from_str(last).ok()?;
    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        parsed.get("data").cloned()
    } else {
        None
    }
}

fn read_secret_names(app_handle: &tauri::AppHandle) -> Vec<String> {
    engine_json(app_handle, "db", &["settings.get".to_string(), "{}".to_string()])
        .and_then(|settings| settings.get(SECRET_NAMES_SETTING).cloned())
        .and_then(|value| value.as_array().cloned())
        .map(|list| {
            list.iter()
                .filter_map(|name| name.as_str().map(str::to_string))
                .filter(|name| !name.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn write_secret_names(app_handle: &tauri::AppHandle, names: &[String]) -> Result<(), String> {
    let payload = serde_json::json!({ "key": SECRET_NAMES_SETTING, "value": names }).to_string();
    engine_json(app_handle, "db", &["settings.set".to_string(), payload])
        .map(|_| ())
        .ok_or_else(|| "could not record which credential names are stored".to_string())
}

/// The environment variable an engine-side lookup reads for a given name.
///
/// The engine resolves `ACSA_SECRET_<NAME>` case-insensitively by lowercasing the
/// suffix (`app_db._env_secret_names`), so the variable has to be the upper-cased
/// name: `deepseek_api_key` -> `ACSA_SECRET_DEEPSEEK_API_KEY`.
fn secret_env_var(name: &str) -> String {
    format!("ACSA_SECRET_{}", name.to_ascii_uppercase())
}

/// Every credential the keychain holds, as environment for the engine.
///
/// This is how a keychain-only credential reaches the engine at all: it already
/// resolves secrets environment-first (`get_secret` checks `ACSA_SECRET_*` before
/// the database), so the stdlib-only, frozen sidecar needs no change.
fn engine_env_secrets(app_handle: &tauri::AppHandle) -> Vec<(String, String)> {
    secret_env_pairs(&KeychainStore, &read_secret_names(app_handle))
}

/// The environment pairs for the names that actually resolve.
///
/// Split out from the handle so it can be tested: a name with no value is left out
/// rather than injected as empty, because an empty `ACSA_SECRET_*` reads as "not
/// set" in the engine and there is no reason to say that out loud.
fn secret_env_pairs(store: &dyn SecretStore, names: &[String]) -> Vec<(String, String)> {
    names
        .iter()
        .filter_map(|name| store.get(name).map(|value| (secret_env_var(name), value)))
        .collect()
}

/// Store a credential in the OS keychain.
///
/// Deliberately **not** written to the engine's database: new credentials never
/// reach the plaintext file. The engine is handed them through `ACSA_SECRET_*` at
/// spawn instead. An empty value clears the credential.
#[tauri::command]
async fn secrets_set(
    app_handle: tauri::AppHandle,
    name: String,
    value: String,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a credential name cannot be empty".to_string());
    }
    if value.is_empty() {
        return secrets_forget(&app_handle, &name).map(|_| serde_json::json!({ "stored": "removed" }));
    }
    // The keychain first, and it verifies its own write: if it cannot hold the
    // value, the caller is told which store took it rather than being left to
    // believe it is encrypted.
    match KeychainStore.set(&name, &value) {
        Ok(()) => {
            let mut names = read_secret_names(&app_handle);
            if !names.iter().any(|existing| existing == &name) {
                names.push(name);
            }
            write_secret_names(&app_handle, &names)?;
            Ok(serde_json::json!({ "stored": "keychain" }))
        }
        Err(keychain_error) => {
            // The keychain is not usable here — no Secret Service on a headless
            // Linux box, a locked keyring, or a build the OS refuses to recognise
            // (measured: an ad-hoc-signed binary is told the write succeeded and
            // then cannot read it back). Refusing the credential would break
            // provider setup on those machines, so it goes where it went before and
            // the caller is told which happened. This is not a fake encryption: the
            // value is stored as it always was, in the `0600` file.
            let payload = serde_json::json!({ "name": name, "value": value }).to_string();
            engine_json(&app_handle, "db", &["secrets.set".to_string(), payload])
                // The reason travels with the answer. Without it this fallback is
                // invisible: the settings page said the key was in the keychain
                // while every key sat in the database, and the cause — a `keyring`
                // built with no platform backend — took a `cargo tree` and a
                // signed rebuild to find. A user hitting this deserves the sentence.
                .map(|_| serde_json::json!({ "stored": "file", "reason": keychain_error }))
                .ok_or_else(|| format!("could not store the credential: {keychain_error}"))
        }
    }
}

/// Forget a credential everywhere it might be.
#[tauri::command]
async fn secrets_delete(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
    secrets_forget(&app_handle, name.trim())
}

fn secrets_forget(app_handle: &tauri::AppHandle, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("a credential name cannot be empty".to_string());
    }
    KeychainStore.delete(name)?;
    // The engine's copy as well. The migration's own delete is deferred, so an old
    // row would otherwise still resolve the credential the user just removed.
    let payload = serde_json::json!({ "name": name }).to_string();
    let _ = engine_json(app_handle, "db", &["secrets.delete".to_string(), payload]);
    let remaining: Vec<String> = read_secret_names(app_handle)
        .into_iter()
        .filter(|existing| existing != name)
        .collect();
    write_secret_names(app_handle, &remaining)
}

/// The names this app can currently resolve a credential for.
///
/// The union of what the engine still holds (its rows, plus anything from a real
/// `ACSA_SECRET_*` in the environment) and what the keychain actually returns for
/// the names on the index. A keychain that will not answer contributes nothing,
/// which is the honest answer rather than an optimistic one.
#[tauri::command]
async fn secrets_list(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut names: Vec<String> =
        engine_json(&app_handle, "db", &["secrets.list".to_string(), "{}".to_string()])
            .and_then(|value| value.as_array().cloned())
            .map(|list| {
                list.iter()
                    .filter_map(|name| name.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

    let store = KeychainStore;
    for name in read_secret_names(&app_handle) {
        if store.get(&name).is_some() && !names.contains(&name) {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// Resolve a provider credential, preferring the OS keychain.
///
/// A value found only in the old store is *copied* into the keychain, read back
/// through a fresh entry to prove it landed, and only then is `after_copy` allowed
/// to let the plaintext original go. That gate is the whole reason the delete waited:
/// a copy that cannot be read back is not a copy, and deleting on that evidence would
/// lose a key while looking successful. It was held open until a *hardened,
/// Developer-ID-signed* build demonstrated the round trip — measured on one
/// (`flags=0x10000(runtime)`, `TeamIdentifier=TFNTZSW82U`), which is the execution
/// context the app actually runs in. See the encryption-at-rest row in
/// `docs/PRODUCTION_CHECKLIST.md`.
///
/// Copying is best effort in the other direction too: a keychain that refuses — a
/// headless Linux box with no Secret Service, a locked keyring — must not stop a run
/// we already have a credential for. The failure is silent here on purpose; the read
/// path is what matters, and the old copy survives precisely because the copy failed.
fn resolve_provider_key(
    store: &dyn SecretStore,
    provider: &str,
    from_old_store: impl FnOnce() -> Option<String>,
    after_copy: impl FnOnce(&str),
) -> Option<String> {
    let name = secret_name_for_provider(provider);
    if let Some(key) = store.get(&name) {
        return Some(key);
    }
    let key = from_old_store()?;
    if store.set(&name, &key).is_ok() && store.get(&name).as_deref() == Some(key.as_str()) {
        after_copy(&name);
    }
    Some(key)
}

fn engine_resolve_key(app_handle: &tauri::AppHandle, provider: &str) -> Option<String> {
    resolve_provider_key(
        &KeychainStore,
        provider,
        || engine_resolve_key_from_old_store(app_handle, provider),
        |name| engine_forget_old_store(app_handle, name),
    )
}

/// Drop the engine's plaintext copy of a credential the keychain now holds.
///
/// Best effort, and only ever reached once the keychain has been shown to return the
/// value: if this fails the key simply stays in both places and the next run tries
/// again, which is the state every release before this one shipped in.
fn engine_forget_old_store(app_handle: &tauri::AppHandle, name: &str) {
    // The name has to be indexed *before* the plaintext copy goes.
    //
    // `engine_env_secrets` resolves credentials by name from this index, and a
    // keychain entry no name points at cannot be found again — there is no way to
    // enumerate a keychain (that is a property of the API, not of this code). The
    // first build that deleted the old copy skipped this step and orphaned the
    // two credentials of the machine it ran on: present in the Keychain, invisible
    // to the app, which then reported no key and failed provider calls. Copying
    // *and* indexing is the migration; deleting without indexing is data loss that
    // looks like success.
    let mut names = read_secret_names(app_handle);
    if !names.iter().any(|existing| existing == name) {
        names.push(name.to_string());
        let _ = write_secret_names(app_handle, &names);
    }

    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), "db");
    argv.push("secrets.delete".to_string());
    argv.push(format!("{{\"name\":\"{}\"}}", name));
    let _ = Command::new(&program).args(&argv).output();
}

/// The database-backed lookup this replaces. Kept as the fallback until the
/// keychain has been proven from a signed build, and as the reading half of the
/// migration above.
fn engine_resolve_key_from_old_store(
    app_handle: &tauri::AppHandle,
    provider: &str,
) -> Option<String> {
    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut argv) = engine_invocation(resource_dir.as_deref(), "db");
    argv.push("providers.resolveKey".to_string());
    argv.push(format!("{{\"id\":\"{}\"}}", provider));

    let output = Command::new(&program).args(&argv).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let last = stdout.lines().rev().find(|l| !l.trim().is_empty())?;
    let parsed: serde_json::Value = serde_json::from_str(last).ok()?;
    let key = parsed.get("data")?.as_str()?.trim().to_string();
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// Run Codex as the agent and forward its JSON stream to the UI.
///
/// This is the replacement for our own agent loop. That loop could not do native
/// tool calling: the model narrated `read_file` in prose and the harness answered
/// with a guard message, so nothing was ever edited. Codex does emit real tool
/// calls — verified by driving it headlessly against the user's provider, where it
/// edited a file correctly in ~14s and streamed `thread`/`turn`/`item` events.
///
/// The runtime binary and its private home, with our config and model catalog in place.
///
/// Shared by both transports: `exec` and `app-server` read the same home, so the
/// provider, the model catalog, the approval policy and the MCP servers are
/// configured once and behave identically either way.
fn prepare_agent_home(
    app_handle: &tauri::AppHandle,
    config_toml: &str,
    provider_id: &str,
    catalog_json: &str,
    project_root: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app_handle.path().resource_dir().ok();
    let program = resolve_codex_bin(resource_dir.as_deref()).ok_or_else(|| {
        "The agent runtime is not installed. Run scripts/fetch_codex_sidecar.sh.".to_string()
    })?;

    // Its own home, beside our data: config and auth stay ours, not the user's CLI setup.
    let codex_home = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {}", e))?
        .join("codex");
    std::fs::create_dir_all(&codex_home)
        .map_err(|e| format!("could not create {}: {}", codex_home.display(), e))?;

    if !config_toml.trim().is_empty() {
        // `model_catalog_json` is a *path* to a catalog file, not inline JSON — verified
        // against a working Codex install, after an inline attempt parsed without error and
        // silently did nothing. Without the catalog Codex warns that it is "defaulting to
        // fallback metadata" for our provider's models, which is the error the UI showed.
        let config = if catalog_json.trim().is_empty() {
            config_toml.to_string()
        } else {
            let dir = codex_home.join("model-catalogs");
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("could not create {}: {}", dir.display(), e))?;
            let path = dir.join(format!("{}.json", provider_id));
            std::fs::write(&path, catalog_json)
                .map_err(|e| format!("could not write the model catalog: {}", e))?;
            // Prepended, because TOML tables come last — a top-level key written after the
            // provider table would land inside it and be rejected.
            format!("model_catalog_json = \"{}\"\n{}", path.to_string_lossy(), config_toml)
        };
        std::fs::write(codex_home.join("config.toml"), config)
            .map_err(|e| format!("could not write Codex config: {}", e))?;
    }

    if Path::new(project_root).is_dir() {
        match sync_project_skills(&codex_home, &PathBuf::from(project_root)) {
            Ok(count) if count > 0 => {
                eprintln!("[ACSA Code] agent: {} project skill(s) mirrored for the runtime", count);
            }
            Ok(_) => {}
            Err(error) => eprintln!("[ACSA Code] agent: could not mirror project skills: {}", error),
        }
    }

    Ok((program, codex_home))
}

/// A live `codex app-server` process.
///
/// The alternative is one `exec` process per turn, which cannot do the things
/// this can: answer an approval request (there is no channel to answer on), steer
/// a turn that is already running, or stream the answer token by token. The cost
/// is that the process outlives a turn, so its lifecycle is ours to manage.
///
/// Where a session's events go. Production emits Tauri events for the UI; a test
/// collects them. Being able to drive the session without an `AppHandle` is the
/// point: this layer was only reachable through the GUI, which is why its bugs
/// took a rebuild-and-click cycle to find and I could not reproduce the failure
/// that mattered.
pub type AgentEmitter = std::sync::Arc<dyn Fn(&str, String) + Send + Sync + 'static>;

pub struct AgentSession {
    child: std::process::Child,
    emitter: AgentEmitter,
    stdin: std::sync::Mutex<std::process::ChildStdin>,
    next_id: std::sync::atomic::AtomicU64,
    /// Replies waiting to arrive, keyed by the request id we sent. Shared with
    /// the reader thread, which is the only thing that can complete them.
    pending: std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<serde_json::Value>>>,
    >,
    thread_id: std::sync::Mutex<Option<String>>,
    /// The turn currently running.
    ///
    /// `turn/interrupt` requires `threadId` *and* `turnId` (the schema marks both
    /// as required), so an interrupt that names only the thread is rejected. The
    /// id arrives in the `turn/start` reply and again in the `turn/started`
    /// notification; the reply is stored synchronously, the notification by the
    /// reader thread, so a turn that is running is always nameable.
    turn_id: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl AgentSession {
    /// Spawn a runtime and start reading it.
    ///
    /// Everything after this is transport: `request` writes a line and waits for
    /// the reply with the same id, and anything that is not a reply is forwarded
    /// to the emitter for the UI (or a test) to interpret.
    ///
    /// `env` carries the provider credential. It has to: `exec` resolves the key
    /// and puts it in the child's environment, and the first version of this did
    /// not, so every turn died on "Missing environment variable:
    /// `ACSA_CODEX_API_KEY`" — a run that reported success having done nothing.
    pub fn spawn(
        program: &Path,
        codex_home: &Path,
        working_dir: &str,
        env: &[(String, String)],
        emitter: AgentEmitter,
    ) -> Result<AgentSession, String> {
        let mut child = Command::new(program)
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .current_dir(working_dir)
            .env("CODEX_HOME", codex_home)
            .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start the agent runtime ({}): {}", program.display(), e))?;

        let stdin = child.stdin.take().ok_or("could not open the agent's input")?;
        let stdout = child.stdout.take().ok_or("could not capture agent output")?;
        let stderr = child.stderr.take().ok_or("could not capture agent errors")?;

        let pending: std::sync::Arc<
            std::sync::Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<serde_json::Value>>>,
        > = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let turn_id: std::sync::Arc<std::sync::Mutex<Option<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));

        // The session id marks this session as current; a superseded one stays
        // quiet rather than announcing its shutdown into the next run.
        let session_id = SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

        let reader_pending = pending.clone();
        let reader_emitter = emitter.clone();
        let reader_turn = turn_id.clone();
        // Whatever we are about to hand the child as a credential, masked if it
        // comes back out. Built here because `env` does not outlive the spawn.
        let known_secrets: Vec<String> = env
            .iter()
            .map(|(_, value)| value.clone())
            .filter(|value| value.len() >= MIN_SECRET_LEN)
            .collect();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};

            let stderr_emitter = reader_emitter.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        let shown = match friendly_agent_line(&line) {
                            AgentLine::Replace(message) => message,
                            AgentLine::Keep => line.clone(),
                            AgentLine::Hide => continue,
                        };
                        stderr_emitter("agent:stderr", redact_for_display(&shown, &known_secrets));
                    }
                }
            });

            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                // A reply to something we asked: hand it to the waiting caller.
                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                    if let Some(tx) = reader_pending.lock().ok().and_then(|mut p| p.remove(&id)) {
                        let _ = tx.send(value);
                        continue;
                    }
                }
                // Remember the live turn, so an interrupt can name it. The
                // `turn/start` reply sets this synchronously too; this covers a
                // turn that was started by someone else (a steered or resumed
                // one) and keeps the two paths from disagreeing.
                if value.get("method").and_then(|m| m.as_str()) == Some("turn/started") {
                    if let Some(id) = value.pointer("/params/turn/id").and_then(|v| v.as_str()) {
                        if let Ok(mut slot) = reader_turn.lock() {
                            *slot = Some(id.to_string());
                        }
                    }
                }
                // Everything else is for the UI: notifications, and the requests
                // the runtime sends *us* (approvals), which the UI answers.
                reader_emitter("agent:event", line);
            }
            // stdout reached EOF: the process is gone. The real exit signal —
            // but only while this session is still the current one.
            if SESSION_SEQ.load(std::sync::atomic::Ordering::SeqCst) == session_id {
                reader_emitter("agent:exit", String::new());
            }
        });

        Ok(AgentSession {
            child,
            emitter,
            stdin: std::sync::Mutex::new(stdin),
            next_id: std::sync::atomic::AtomicU64::new(1),
            pending,
            thread_id: std::sync::Mutex::new(None),
            turn_id,
        })
    }

    /// Send one JSON-RPC request and wait for its reply.
    fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, String> {
        use std::io::Write;

        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);

        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        {
            let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
            writeln!(stdin, "{}", message).map_err(|e| format!("could not write to the agent: {}", e))?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        (self.emitter)("agent:request", message.to_string());

        match rx.recv_timeout(timeout) {
            Ok(reply) => {
                if let Some(error) = reply.get("error") {
                    return Err(format!("{}: {}", method, error));
                }
                Ok(reply)
            }
            Err(_) => {
                let _ = self
                    .pending
                    .lock()
                    .map(|mut p| p.remove(&id));
                Err(format!("{} did not answer in time", method))
            }
        }
    }

    /// Answer a request the runtime sent *us* — an approval, in practice.
    ///
    /// The decision is the runtime's own vocabulary and is written through as-is;
    /// see `ApprovalDecision` on the TypeScript side for the values the schema
    /// accepts. Kept here rather than only in the Tauri command so the same path
    /// the UI uses is the one a test drives.
    fn respond(
        &self,
        request_id: serde_json::Value,
        decision: serde_json::Value,
    ) -> Result<(), String> {
        use std::io::Write;
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": decision,
        });
        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        writeln!(stdin, "{}", message).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())
    }
}

/// Managed state: the live app-server session, if one is running.
#[derive(Default)]
pub struct AgentState {
    session: std::sync::Mutex<Option<AgentSession>>,
}

/// Which session is current.
///
/// Events are emitted on one channel with no identity, so a replaced session's
/// stdout EOF announced itself into the *next* run's listener and ended it the
/// moment it started — a run that reported success and did nothing. The counter
/// lets a dying session stay quiet once it has been superseded.
static SESSION_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Start (or restart) the app-server session and open a thread.
///
/// Returns the thread id. `resume_thread_id` continues an existing one.
#[tauri::command]
async fn agent_start(
    app_handle: tauri::AppHandle,
    state: State<'_, AgentState>,
    project_root: String,
    config_toml: String,
    provider_id: String,
    // The id the runtime routes with, which is not always the provider's own name.
    // `openai` is built into the runtime and cannot be overridden — offering a
    // `[model_providers.openai]` table is a hard config error, so the caller
    // namespaces it. `provider_id` stays the real name because that is what the
    // credential lookup and the catalog file are keyed by.
    runtime_provider_id: String,
    catalog_json: String,
    model: String,
    resume_thread_id: Option<String>,
    approval_policy: String,
    approvals_reviewer: String,
    sandbox_mode: String,
) -> Result<String, String> {
    let (program, codex_home) =
        prepare_agent_home(&app_handle, &config_toml, &provider_id, &catalog_json, &project_root)?;

    let working_dir = if Path::new(&project_root).is_dir() {
        project_root.clone()
    } else {
        ".".to_string()
    };

    // One session at a time; a second run replaces the first the way the exec
    // path always has.
    //
    // Supersede *before* killing. `spawn` also bumps the counter, but it runs
    // after this: in between, the outgoing process is dead and still counts as
    // current, so its stdout EOF would be emitted as *this* run's exit. The
    // listener is already attached by now, so the new run ended the moment it
    // began — "turn finished in 0s", an empty answer, on the second message of
    // every session and never the first. Superseding first closes the window.
    SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        if let Some(mut previous) = guard.take() {
            let _ = previous.child.kill();
        }
    }

    let app_for_events = app_handle.clone();
    let emitter: AgentEmitter = std::sync::Arc::new(move |event: &str, line: String| {
        let _ = app_for_events.emit(event, AiFrame { line });
    });

    // Same server-side resolution the exec path uses, so the credential never
    // travels over IPC and the runtime gets it the way its config expects.
    let mut env: Vec<(String, String)> = Vec::new();
    if !provider_id.trim().is_empty() {
        if let Some(key) = engine_resolve_key(&app_handle, provider_id.trim()) {
            env.push(("ACSA_CODEX_API_KEY".to_string(), key));
        }
    }
    let session = AgentSession::spawn(&program, &codex_home, &working_dir, &env, emitter)?;

    {
        let mut guard = state.session.lock().map_err(|e| e.to_string())?;
        *guard = Some(session);
    }

    // Hold the reader's pending map for the lifetime of the session.
    let session_guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = session_guard.as_ref().ok_or("session vanished")?;

    session.request(
        "initialize",
        serde_json::json!({
            "clientInfo": { "name": "acsa-code", "version": env!("CARGO_PKG_VERSION") }
        }),
        std::time::Duration::from_secs(20),
    )?;

    let resuming = resume_thread_id.as_deref().map(str::trim).unwrap_or("").to_string();
    let mut thread_params = serde_json::json!({
        "model": model,
        "modelProvider": runtime_provider_id,
        "cwd": working_dir,
        "approvalPolicy": approval_policy,
        "approvalsReviewer": approvals_reviewer,
        "sandbox": sandbox_mode,
    });
    let method = if resuming.is_empty() {
        "thread/start"
    } else {
        // `thread/resume` takes the id; the rest of the context carries over.
        thread_params["threadId"] = serde_json::Value::String(resuming.clone());
        "thread/resume"
    };
    let reply = session.request(
        method,
        thread_params,
        std::time::Duration::from_secs(60),
    )?;

    let thread_id = reply
        .get("result")
        .and_then(|r| r.get("thread"))
        .and_then(|t| t.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("thread/start answered without a thread id: {}", reply))?
        .to_string();
    if let Ok(mut slot) = session.thread_id.lock() {
        *slot = Some(thread_id.clone());
    }
    Ok(thread_id)
}

/// Send one turn to the open thread. Events stream as `agent:event`.
/// The model-visible input for one turn: the text, then any images.
///
/// Shape taken from the app-server itself rather than from documentation. Sending
/// it a variant with no fields names what that variant needs:
///
///     turn/start: {"code":-32600,"message":"Invalid request: missing field `path`"}
///
/// and the accepted enums are `text`, `image`, `localImage`, `audio`, `localAudio`,
/// `skill`, `mention` — note that there is no `input_image`, which is the
/// *model-visible* shape `codex debug prompt-input` renders for the Responses API.
/// Trusting that renderer produced this, from a real run:
///
///     unknown variant `input_image`, expected one of `text`, `image`, `localImage`, …
///
/// The runtime rejected the turn, the app fell back to one-shot exec, and the user
/// got "Task completed. No files were added, removed or resized" for a request with
/// two screenshots attached.
///
/// `localImage` takes a path, so the attachments go to disk exactly as the exec
/// path writes them for `--image=` — one file, two transports, no base64 in the
/// protocol.
fn turn_input(text: &str, images: &[PathBuf]) -> Vec<serde_json::Value> {
    let mut input = vec![serde_json::json!({ "type": "text", "text": text })];
    for path in images {
        input.push(serde_json::json!({
            "type": "localImage",
            "path": path.to_string_lossy(),
        }));
    }
    input
}

/// Write the composer's data URLs to files, the way the exec path does.
///
/// Returns the paths that were written; an image that could not be written is left
/// out rather than sent as a broken reference.
fn write_turn_attachments(app_handle: &tauri::AppHandle, images: &[String]) -> Vec<PathBuf> {
    if images.is_empty() {
        return Vec::new();
    }
    let Ok(codex_home) = app_handle.path().app_data_dir().map(|dir| dir.join("codex")) else {
        return Vec::new();
    };
    let mut written = Vec::new();
    for (index, data_url) in images.iter().enumerate() {
        if let Some(path) = write_attachment(&codex_home, data_url, index) {
            written.push(path);
        }
    }
    if !written.is_empty() {
        prune_attachments(&codex_home.join("attachments"), 20);
    }
    written
}

#[tauri::command]
async fn agent_turn(
    app_handle: tauri::AppHandle,
    state: State<'_, AgentState>,
    text: String,
    images: Vec<String>,
) -> Result<(), String> {
    let attachment_paths = write_turn_attachments(&app_handle, &images);
    let guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("no agent session is running")?;
    let thread_id = session
        .thread_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("no thread is open")?;

    let reply = session.request(
        "turn/start",
        serde_json::json!({
            "threadId": thread_id,
            "input": turn_input(&text, &attachment_paths),
        }),
        std::time::Duration::from_secs(30),
    )?;
    // The reply names the turn it just started. Storing it here is synchronous,
    // so an interrupt issued the instant the turn begins still has an id to name
    // — waiting for the `turn/started` notification would race that.
    if let Some(id) = reply.pointer("/result/turn/id").and_then(|v| v.as_str()) {
        if let Ok(mut slot) = session.turn_id.lock() {
            *slot = Some(id.to_string());
        }
    }
    Ok(())
}

/// Answer a request the runtime sent us — an approval, in practice.
#[tauri::command]
async fn agent_respond(
    app_handle: tauri::AppHandle,
    request_id: serde_json::Value,
    decision: serde_json::Value,
) -> Result<(), String> {
    let state = app_handle.state::<AgentState>();
    let guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("no agent session is running")?;
    session.respond(request_id, decision)
}

/// Stop the running turn, keeping the session and its thread.
#[tauri::command]
async fn agent_interrupt(
    state: State<'_, AgentState>,
) -> Result<(), String> {
    let guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("no agent session is running")?;
    let thread_id = session
        .thread_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_default();
    let turn_id = session
        .turn_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .filter(|id| !id.is_empty())
        // The schema requires a turn id, so sending only the thread id would be
        // rejected. Saying so beats sending a request the runtime discards.
        .ok_or("no turn is running to interrupt")?;
    session.request(
        "turn/interrupt",
        serde_json::json!({ "threadId": thread_id, "turnId": turn_id }),
        std::time::Duration::from_secs(10),
    )?;
    Ok(())
}

/// The `turn/steer` params, built in one place.
///
/// `expectedTurnId` is the field worth having a test for: the schema marks it
/// required and calls it a precondition — "the request fails when it does not
/// match the currently active turn" — so a steer is refused rather than silently
/// becoming a new turn when the turn it was aimed at has finished.
fn steer_params(thread_id: &str, turn_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "threadId": thread_id,
        "expectedTurnId": turn_id,
        "input": [{ "type": "text", "text": text }],
    })
}

/// Add a message to the turn that is already running, instead of starting another.
///
/// The schema is read, not inferred (`codex app-server generate-json-schema`):
/// `TurnSteerParams` requires `threadId`, the `input` array, and — the part worth
/// knowing — `expectedTurnId`, described there as a "required active turn id
/// precondition. The request fails when it does not match the currently active
/// turn." So this names the turn it believes is running, and a steer aimed at a
/// turn that has since finished is refused by the runtime rather than silently
/// becoming a new turn.
///
/// It can still be refused for a reason the caller has to show: a turn that cannot
/// accept same-turn steering (`/review`, manual `/compact`) answers
/// `ActiveTurnNotSteerable`. That error travels back to the composer, which says
/// so rather than dropping the message.
#[tauri::command]
async fn agent_steer(
    state: State<'_, AgentState>,
    text: String,
) -> Result<(), String> {
    let guard = state.session.lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("no agent session is running")?;
    let thread_id = session
        .thread_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .filter(|id| !id.is_empty())
        .ok_or("no thread is open")?;
    let turn_id = session
        .turn_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .filter(|id| !id.is_empty())
        // Same reason as the interrupt: the schema marks it required, so a
        // request without it is discarded.
        .ok_or("no turn is running to steer")?;

    let reply = session.request(
        "turn/steer",
        steer_params(&thread_id, &turn_id, &text),
        std::time::Duration::from_secs(30),
    )?;
    // The reply names the turn the message landed in. It should be the same one,
    // and storing it keeps the slot right if the runtime ever reports otherwise.
    if let Some(id) = reply.pointer("/result/turnId").and_then(|v| v.as_str()) {
        if let Ok(mut slot) = session.turn_id.lock() {
            *slot = Some(id.to_string());
        }
    }
    Ok(())
}

/// A local-model tool adapter, if one is running.
///
/// It speaks the Responses API to the runtime and Ollama's native `/api/chat` to
/// the model. That indirection is the whole point: the runtime requires
/// `wire_api = "responses"`, and Ollama's implementation of that accepts `tools`
/// and ignores them — which is why a local model used to read and reply and
/// never act.
#[derive(Default)]
pub struct LocalAdapterState {
    server: std::sync::Mutex<Option<LocalAdapter>>,
}

struct LocalAdapter {
    child: std::process::Child,
    port: u16,
    provider_id: String,
    /// Which upstream shape it was started for, so a provider whose address
    /// changed gets a new adapter instead of the old one answering.
    upstream: String,
    upstream_base: String,
}

/// `host:port` from a base URL.
///
/// The Ollama branch of the adapter takes them as separate flags — that is the
/// shape its CLI already had — while a hosted provider is handed the whole URL.
fn host_and_port(base_url: &str) -> Option<(String, u16)> {
    let rest = base_url.split("://").nth(1).unwrap_or(base_url);
    let hostport = rest.split('/').next().unwrap_or(rest);
    if hostport.is_empty() {
        return None;
    }
    match hostport.rsplit_once(':') {
        Some((host, port)) => port.parse::<u16>().ok().map(|p| (host.to_string(), p)),
        None => Some((
            hostport.to_string(),
            if base_url.starts_with("https") { 443 } else { 80 },
        )),
    }
}

/// A port nothing is listening on, offered by the OS and released for the child.
fn free_local_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

/// Is the local tool adapter on `port` answering?
///
/// A bare TCP connect is not enough. The adapter is reused across runs, and one that
/// has died leaves either nothing listening or — worse — a socket that accepts and
/// then says nothing, which passes a connect test and fails the first real request.
/// So this asks the adapter's own `/health` for a 200, with short timeouts: a wedged
/// process must not be able to hang the start of a run.
fn adapter_alive(port: u16) -> bool {
    use std::io::{Read, Write};

    let timeout = std::time::Duration::from_millis(750);
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    // `Connection: close` means the adapter hangs up, so read to EOF rather than
    // guessing a length — the response is two lines.
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

/// Start (or reuse) the adapter for one provider and return its Responses base URL.
#[tauri::command]
async fn local_adapter_start(
    app_handle: tauri::AppHandle,
    state: State<'_, LocalAdapterState>,
    provider_id: String,
    // `upstream` is `"ollama"` (its own API) or `"openai"` (any
    // `/chat/completions`); `base_url` is the provider's address, so either branch
    // reaches the model the user actually picked — a non-default Ollama port as
    // much as a hosted host.
    upstream: Option<String>,
    base_url: Option<String>,
) -> Result<String, String> {
    let upstream = upstream
        .map(|value| value.trim().to_lowercase())
        .filter(|value| value == "openai")
        .unwrap_or_else(|| "ollama".to_string());
    let upstream_base = base_url.unwrap_or_default().trim().trim_end_matches('/').to_string();
    {
        let guard = state.server.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = guard.as_ref() {
            // Alive as well as matching: this used to return the cached URL on the
            // provider id alone, so an adapter that had died between runs handed the
            // next run a port with nothing behind it, and every tool call in it
            // failed as though the model were at fault. Asking it is cheap and it is
            // the only way to know.
            if existing.provider_id == provider_id
                && existing.upstream == upstream
                && existing.upstream_base == upstream_base
                && adapter_alive(existing.port)
            {
                return Ok(format!("http://127.0.0.1:{}/v1", existing.port));
            }
        }
    }
    {
        let mut guard = state.server.lock().map_err(|e| e.to_string())?;
        if let Some(mut previous) = guard.take() {
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
    }

    let port = free_local_port().ok_or("could not find a free local port")?;
    let resource_dir = app_handle.path().resource_dir().ok();
    let (program, mut args) = engine_invocation(resource_dir.as_deref(), "adapter");
    args.push("--port".to_string());
    args.push(port.to_string());

    // The credential travels in the environment, never in argv: this process's
    // command line is readable by any process running as the user.
    let mut env: Vec<(String, String)> = vec![
        ("ACSA_ADAPTER_UPSTREAM".to_string(), upstream.clone()),
        ("ACSA_ADAPTER_URL".to_string(), upstream_base.clone()),
        // Ties the adapter's lifetime to this process — see the stdin note below.
        ("ACSA_ADAPTER_WATCH_STDIN".to_string(), "1".to_string()),
    ];
    if upstream == "openai" {
        args.push("--upstream".to_string());
        args.push("openai".to_string());
        if !upstream_base.is_empty() {
            args.push("--base-url".to_string());
            args.push(upstream_base.clone());
        }
        // Same resolution the `exec` and app-server paths use, so the adapter
        // reaches the provider with the credential the user configured.
        if let Some(key) = engine_resolve_key(&app_handle, &provider_id) {
            env.push(("ACSA_ADAPTER_KEY".to_string(), key));
        }
    } else if let Some((host, ollama_port)) = host_and_port(&upstream_base) {
        args.push("--ollama-host".to_string());
        args.push(host);
        args.push("--ollama-port".to_string());
        args.push(ollama_port.to_string());
    }

    // Its stderr goes to a file — not to a pipe, and no longer to /dev/null.
    //
    // A pipe was wrong because nothing drains it and a full buffer blocks the
    // adapter mid-turn. Discarding it was wrong too, and less obviously: the
    // adapter is the only component that knows *why* a provider stalled or refused
    // a request, and it was throwing that away. A request to NVIDIA NIM that never
    // answered left no trace anywhere on the machine, which is exactly the kind of
    // failure that needs one.
    let adapter_log = app_handle
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("logs"))
        .and_then(|dir| {
            std::fs::create_dir_all(&dir).ok()?;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("adapter.log"))
                .ok()
        });
    let adapter_stderr = match adapter_log {
        Some(file) => Stdio::from(file),
        None => Stdio::null(),
    };

    let mut child = Command::new(&program)
        .args(&args)
        .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())))
        // A pipe this process holds open and never writes to, so the adapter can
        // tell when we are gone.
        //
        // It is handed the provider's credential in its environment, and it used
        // to outlive us: killing the app left the adapter running with the key
        // until the machine was rebooted (found by reading the environment of an
        // orphan from a killed run). When this pipe closes — on a clean quit, a
        // crash, or `kill -9` — the adapter exits. `Stdio::null()` gave it nothing
        // to notice with.
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(adapter_stderr)
        .spawn()
        .map_err(|e| {
            format!(
                "could not start the local tool adapter ({}): {}",
                program.display(),
                e
            )
        })?;

    // Wait until it accepts connections. Without this the first turn races the
    // listener and dies with a connection error that reads like a provider fault.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        // `/health`, not a bare connect: a socket that accepts and then says nothing
        // passes a connect test and fails the first real request, which is the same
        // race in a different disguise.
        if adapter_alive(port) {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "the local tool adapter exited before it was ready ({})",
                status
            ));
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err("the local tool adapter did not start within 20s".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    let url = format!("http://127.0.0.1:{}/v1", port);
    let mut guard = state.server.lock().map_err(|e| e.to_string())?;
    *guard = Some(LocalAdapter {
        child,
        port,
        provider_id,
        upstream,
        upstream_base,
    });
    Ok(url)
}

/// Stop the adapter. Safe to call when none is running.
#[tauri::command]
fn local_adapter_stop(state: State<'_, LocalAdapterState>) -> Result<(), String> {
    let mut guard = state.server.lock().map_err(|e| e.to_string())?;
    if let Some(mut adapter) = guard.take() {
        let _ = adapter.child.kill();
        let _ = adapter.child.wait();
    }
    Ok(())
}

/// Relaunch the app, so an installed update takes effect.
///
/// `@tauri-apps/plugin-process` exists for this, and pulling in a whole plugin —
/// plus a capability entry — for one call is not worth it, so it is a command.
///
/// It deliberately does not just call `app_handle.restart()`. Tauri relaunches
/// by spawning the bundle's *inner* executable (`Contents/MacOS/acsa-code`) with
/// `Command::new`, and on macOS a GUI app started that way is never registered
/// with LaunchServices: it runs with no window and no Dock item, which from the
/// outside is indistinguishable from a launch that failed. Measured on 0.2.17 —
/// "Restart now" left a live process, no windows in the accessibility tree, and
/// the app only came back when it was launched from the bundle again.
///
/// `open -n` asks LaunchServices to start the bundle instead, which is what
/// produces a real window. The `-n` is load-bearing: without it `open` would just
/// activate the instance that is on its way out, and nothing would relaunch. The
/// exit status is checked, so a bundle path that does not work falls back to
/// Tauri's own restart rather than quitting into nothing.
#[tauri::command]
fn app_restart(app_handle: tauri::AppHandle) {
    if let Some(bundle) = app_handle
        .path()
        .resource_dir()
        .ok()
        .as_deref()
        .and_then(bundle_from_resource_dir)
    {
        let bundle = bundle.to_path_buf();
        if launch_bundle(&bundle) {
            app_handle.exit(0);
            return;
        }
    }

    app_handle.restart();
}

/// The bundle a resource directory belongs to: `<bundle>.app/Contents/Resources`
/// is the shipped layout, `target/debug` is a development one, and anything that
/// is not a `.app` has no bundle to relaunch through LaunchServices.
fn bundle_from_resource_dir(resources: &Path) -> Option<&Path> {
    let bundle = resources.parent()?.parent()?;
    if bundle.extension().map(|extension| extension == "app").unwrap_or(false) {
        Some(bundle)
    } else {
        None
    }
}

/// Start the bundle through LaunchServices. Returns whether `open` accepted it.
#[cfg(target_os = "macos")]
fn launch_bundle(bundle: &Path) -> bool {
    Command::new("open")
        .arg("-n")
        .arg(bundle)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Nothing to launch into: only macOS spawns the inner executable directly.
#[cfg(not(target_os = "macos"))]
fn launch_bundle(_bundle: &Path) -> bool {
    false
}

/// End the session entirely.
#[tauri::command]
fn agent_stop(state: State<'_, AgentState>) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = guard.take() {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// `config_toml` is written to this app's own `CODEX_HOME` before launch, so the
/// provider the user configured in our settings is the one Codex uses, and we never
/// touch their personal Codex configuration.
#[tauri::command]
async fn codex_exec(
    app_handle: tauri::AppHandle,
    state: State<'_, ChatState>,
    prompt: String,
    project_root: String,
    config_toml: String,
    provider_id: String,
    // The id the runtime routes with. Separate from `provider_id` for the same
    // reason as `agent_start`: the reserved built-in names are not ours to use.
    runtime_provider_id: String,
    catalog_json: String,
    // The model the run should use. Needed as a CLI argument for local runs,
    // where `--oss` would otherwise choose (and download) its own default.
    model: String,
    // Continue an existing thread instead of starting a new one. The id comes
    // from the previous run's `thread.started` event; an unknown or stale id
    // fails before any work happens, which is what makes the retry safe.
    resume_thread_id: Option<String>,
    // Attachments as `data:` URLs, straight from the composer. They are written
    // into the runtime's own home and handed over as files, which is what the
    // runtime takes (`-i`).
    images: Vec<String>,
    // Set for a local runtime (Ollama, LM Studio). Codex then talks to it over
    // its own adapter instead of a custom OpenAI-compatible provider — which
    // matters because Ollama does not implement the Responses API, so a
    // `wire_api = "responses"` provider entry simply cannot reach it.
    local_provider: Option<String>,
) -> Result<(), String> {
    let (program, codex_home) = prepare_agent_home(
        &app_handle,
        &config_toml,
        &provider_id,
        &catalog_json,
        &project_root,
    )?;

    if let Some(mut previous) = state.child.lock().map_err(|e| e.to_string())?.take() {
        let _ = previous.kill();
    }

    let working_dir = if Path::new(&project_root).is_dir() {
        project_root.clone()
    } else {
        ".".to_string()
    };

    let mut command = Command::new(&program);
    command.arg("exec");
    // A follow-up continues the same thread, so the agent still has everything it
    // read and did. Without this each turn is a fresh process that only knows
    // what we paste back into the prompt.
    let resuming = resume_thread_id.as_deref().map(str::trim).unwrap_or("");
    if !resuming.is_empty() {
        command.arg("resume");
    }
    command
        .arg("--json")
        // The project may not be a git repo; Codex refuses to start otherwise.
        .arg("--skip-git-repo-check");
    if !resuming.is_empty() {
        // `resume` rejects `--oss` / `--local-provider` ("unexpected argument"),
        // because a resumed thread keeps the model it was created with. The
        // provider still has to be named or it falls back to OpenAI — verified:
        // without this the resumed thread went to api.openai.com and 401'd. A
        // config override is accepted here, and for the cloud providers the same
        // name is already the `[model_providers.*]` table we write.
        command
            .arg("-c")
            .arg(format!("model_provider=\"{}\"", runtime_provider_id.trim()));
    } else if let Some(local) = local_provider.as_deref().filter(|p| !p.trim().is_empty()) {
        // `-m` is not optional here. `--oss` has its own default model and will go
        // and download it — verified the hard way: without this, a run against the
        // installed 1.5b model started fetching a 12.85 GB one instead of using
        // what the user had. Pinning the model makes it run on the chosen model, or
        // fail, rather than quietly pulling gigabytes.
        command
            .arg("--oss")
            .arg("--local-provider")
            .arg(local)
            .arg("-m")
            .arg(&model);
    }
    // Attachments are files to this runtime, so they go in before the prompt.
    //
    // `--image=<path>`, not `-i <path>`: the flag is variadic, so a separate
    // argument form swallows the positional prompt — verified, the run then
    // reported "Reading prompt from stdin... No prompt provided via stdin".
    let attachment_dir = codex_home.join("attachments");
    for (index, image) in images.iter().enumerate() {
        if let Some(path) = write_attachment(&codex_home, image, index) {
            command.arg(format!("--image={}", path.to_string_lossy()));
        }
    }
    prune_attachments(&attachment_dir, 20);
    // `resume [OPTIONS] [SESSION_ID] [PROMPT]`
    if !resuming.is_empty() {
        command.arg(resuming);
    }
    // The prompt is positional, so it goes last.
    command
        .arg(&prompt)
        .current_dir(&working_dir)
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Codex reads the key from the environment named by `env_key`, so it is set here
    // rather than accepted from the caller — the credential stays on this side.
    let mut known_secrets: Vec<String> = Vec::new();
    if !provider_id.trim().is_empty() {
        if let Some(key) = engine_resolve_key(&app_handle, provider_id.trim()) {
            if key.len() >= MIN_SECRET_LEN {
                known_secrets.push(key.clone());
            }
            command.env("ACSA_CODEX_API_KEY", key);
        }
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start the agent ({}): {}", program.display(), e))?;

    let stdout = child.stdout.take().ok_or("could not capture agent output")?;
    let mut stderr = child.stderr.take().ok_or("could not capture agent errors")?;
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

    let app_for_reader = app_handle.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Read};
        let stderr_handle = app_for_reader.clone();
        let stderr_thread = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });

        // Token counts ride on `turn.completed`, one per turn, so a run's total is
        // their sum. Verified against a live run:
        //   {"type":"turn.completed","usage":{"input_tokens":2050,…,"output_tokens":2,…}}
        // They are collected here because the UI is the only other reader of this
        // stream, and it does not need to do arithmetic on tokens.
        let mut prompt_tokens: u64 = 0;
        let mut completion_tokens: u64 = 0;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if line.contains("\"turn.completed\"") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(usage) = value.get("usage") {
                        let field = |key: &str| {
                            usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
                        };
                        prompt_tokens += field("input_tokens");
                        completion_tokens += field("output_tokens");
                    }
                }
            }
            // Each line is one JSON event; the UI decides what to show.
            let _ = app_for_reader.emit("codex:event", AiFrame { line });
        }
        // Emitted before `codex:exit` so the UI has the numbers by the time it
        // considers the run over.
        if prompt_tokens > 0 || completion_tokens > 0 {
            let _ = app_for_reader.emit(
                "codex:usage",
                AiFrame {
                    line: format!(
                        "{{\"promptTokens\":{},\"completionTokens\":{}}}",
                        prompt_tokens, completion_tokens
                    ),
                },
            );
        }
        let stderr_text = stderr_thread.join().unwrap_or_default();
        // The same translation the streaming path applies: this is the same text,
        // joined, and it would otherwise reappear raw in the exit line.
        let shown = stderr_text
            .lines()
            .filter_map(|line| match friendly_agent_line(line) {
                AgentLine::Replace(message) => Some(message),
                AgentLine::Keep => Some(line.to_string()),
                AgentLine::Hide => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let _ = stderr_handle.emit(
            "codex:exit",
            redact_for_display(shown.trim(), &known_secrets),
        );
    });

    Ok(())
}

// ── Application Entry Point ─────────────────────────────────────────────────

/// This build's version, taken from `.tauri/Cargo.toml` — the same value the
/// updater compares against, so a crash report and a release are talking about
/// the same number.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Give the File menu the operations a Mac app is expected to have in it.
///
/// Tauri's default menu is the platform one — the app menu, Edit with its
/// clipboard items, Window, Help — and this app added nothing to it, so File
/// offered "Close Window" and nothing else. Opening a file or a folder from the
/// menu bar is not a nicety on macOS; it is where a reader looks first.
///
/// The default menu is *kept* and these items are inserted at the top of File,
/// rather than a menu being built from scratch: the standard items are not ours to
/// drop, and rebuilding them would be a second place for them to be wrong.
///
/// Each item raises an id the frontend already knows how to act on. That is the
/// point — the menu is a second way into the same functions the command palette
/// calls, not a second implementation of them.
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = Menu::default(app)?;

    let open_file = MenuItemBuilder::with_id("menu.open-file", "Open File…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("menu.open-folder", "Open Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("menu.save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    // Option+Cmd+S, matching the editor convention: Shift+Cmd+S is "Save As"
    // everywhere else, and this app has no Save As.
    let save_all = MenuItemBuilder::with_id("menu.save-all", "Save All")
        .accelerator("CmdOrCtrl+Alt+S")
        .build(app)?;
    let after_open = PredefinedMenuItem::separator(app)?;
    let before_close = PredefinedMenuItem::separator(app)?;

    let file = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some("File") => {
            Some(submenu)
        }
        _ => None,
    });

    if let Some(file) = file {
        file.insert_items(
            &[
                &open_file,
                &open_folder,
                &after_open,
                &save,
                &save_all,
                &before_close,
            ],
            0,
        )?;
    }

    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            sys: Mutex::new(System::new_all()),
        })
        .manage(TerminalState::new())
        .manage(ChatState::new())
        .manage(OllamaState::new())
        .manage(AgentState::default())
        .manage(LocalAdapterState::default())
        // Updates: the app checks a manifest, verifies the artifact against the
        // public key in tauri.conf.json, and installs it on restart. Nothing here
        // talks to a server the user did not ask for — the check is on by default
        // because a security fix nobody receives is worse than a version ping, but
        // it is a visible setting, and the install always waits for a click.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            fetch_system_metrics,
            open_external,
            fetch_system_storage,
            fetch_system_processes,
            system_cleanup,
            list_project_files,
            read_file_content,
            read_file_base64,
            write_file_content,
            create_file_or_folder,
            delete_project_file,
            create_project_template,
            pick_folder,
            pick_save_file,
            pick_open_file,
            reveal_path,
            engine_call,
            terminal_spawn,
            terminal_input,
            terminal_resize,
            chat_stream,
            chat_cancel,
            ollama_pull,
            ollama_install,
            ollama_cancel,
            codex_exec,
            agent_start,
            agent_turn,
            agent_respond,
            agent_interrupt,
            agent_steer,
            secrets_set,
            secrets_delete,
            secrets_list,
            agent_stop,
            local_adapter_start,
            local_adapter_stop,
            app_restart,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            // The engine stamps this into every crash-log entry and support
            // bundle, and nothing ever set it — so every report read
            // `"version": ""`, which is the one field that says whether the bug
            // was fixed three releases ago. Set once here and every child the
            // app spawns inherits it.
            std::env::set_var("ACSA_APP_VERSION", APP_VERSION);
            println!(
                "[ACSA Code] started. Engine dir: {:?}",
                resolve_engine_dir(app.path().resource_dir().ok().as_deref())
            );

            if let Err(error) = install_menu(app.handle()) {
                // A menu that cannot be built is not a reason to refuse to start,
                // but it is a reason to say so rather than to look like this app
                // simply has no menu items.
                eprintln!("[ACSA Code] could not install the application menu: {error}");
            }

            let menu_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let action = match event.id().as_ref() {
                    "menu.open-file" => "open-file",
                    "menu.open-folder" => "open-folder",
                    "menu.save" => "save",
                    "menu.save-all" => "save-all",
                    // Predefined items (Quit, Copy, Close Window) are handled by
                    // the platform and arrive here too; they are not ours to act on.
                    _ => return,
                };
                let _ = menu_handle.emit("acsa:menu", action);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to launch ACSA Code");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "acsa-skills-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn find_by_name<'a>(nodes: &'a [FileNode], name: &str) -> Option<&'a FileNode> {
        for node in nodes {
            if node.name == name {
                return Some(node);
            }
            if let Some(children) = &node.children {
                if let Some(found) = find_by_name(children, name) {
                    return Some(found);
                }
            }
        }
        None
    }

    fn walk(root: &std::path::Path) -> Vec<FileNode> {
        let mut visited = std::collections::HashSet::new();
        if let Ok(real) = std::fs::canonicalize(root) {
            visited.insert(real);
        }
        build_file_tree(root, MAX_TREE_DEPTH, &mut visited)
    }

    /// File ▸ Open File… opens its panel in the project, and a backup import still
    /// opens at the Desktop. The difference is the whole point of the argument, so
    /// both are pinned — along with the escaping, because a quote in either string
    /// would end the AppleScript literal and start another one.
    #[test]
    fn the_open_panel_starts_where_the_thing_being_opened_is() {
        let in_project = open_file_panel_script("Open File:", Some("/Users/me/proj"));
        assert!(in_project.contains("default location (POSIX file \"/Users/me/proj\")"));

        let from_desktop = open_file_panel_script("Import backup:", None);
        assert!(from_desktop.contains("default location (path to desktop folder)"));

        // An empty or whitespace directory is the same as none: a panel told to
        // open at "" would fail rather than fall back.
        assert!(open_file_panel_script("p", Some("  ")).contains("path to desktop folder"));

        let quoted = open_file_panel_script("He said \"hi\"", Some("/tmp/a \"b\""));
        assert!(quoted.contains("prompt \"He said \\\"hi\\\"\""));
        assert!(quoted.contains("POSIX file \"/tmp/a \\\"b\\\"\""));
    }

    /// The editor hands the reader two shapes and both have to work: absolute
    /// paths straight from the file tree, and `node_modules/...` relative to the
    /// project for a dependency's types. What must not change is the boundary —
    /// `resolve_project_path` is what stops the page reading the rest of the disk,
    /// so widening it for either shape would be a hole, not a fix.
    #[test]
    fn the_file_reader_accepts_both_path_shapes_and_still_refuses_to_escape() {
        let root = scratch("resolve-shapes");
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("src.ts"), "export const x = 1;").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.d.ts"), "export {};").unwrap();
        let root_arg = root.to_string_lossy().to_string();

        let absolute = root.join("src.ts").to_string_lossy().to_string();
        assert!(resolve_project_path(&root_arg, &absolute).is_ok());
        assert!(resolve_project_path(&root_arg, "node_modules/pkg/index.d.ts").is_ok());
        assert!(resolve_project_path(&root_arg, "../outside.ts").is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The cap was 5, which is under `apps/api/migrations/app/<migration>/`. A
    /// project laid out like that showed "(empty folder)" for folders every other
    /// editor listed, which is what a user reported — the tree simply stopped.
    #[test]
    fn a_file_below_the_old_depth_cap_is_reached() {
        let root = scratch("tree-depth");
        let mut deep = root.clone();
        for level in 0..8 {
            deep = deep.join(format!("level{level}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("buried.ts"), "export const x = 1;").unwrap();

        let tree = walk(&root);
        assert!(
            find_by_name(&tree, "buried.ts").is_some(),
            "the walk stopped before the file: {tree:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A link back up the tree is a cycle. Without the visited set the walk either
    /// recurses until the stack goes, or fills the tree with copies of itself.
    #[cfg(unix)]
    #[test]
    fn a_symlink_back_up_the_tree_terminates() {
        let root = scratch("tree-cycle");
        let inner = root.join("a").join("b");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("real.ts"), "export const x = 1;").unwrap();
        std::os::unix::fs::symlink(&root, inner.join("back")).unwrap();

        let tree = walk(&root);

        assert!(find_by_name(&tree, "real.ts").is_some());
        // The link is still listed — it is a real entry — but it is not walked into.
        let back = find_by_name(&tree, "back").expect("the link should still be listed");
        assert_eq!(back.children.as_ref().map(|c| c.len()), Some(0));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What actually bounds the walk, now that depth no longer does.
    #[test]
    fn heavy_and_hidden_directories_are_not_walked() {
        let root = scratch("tree-ignore");
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "module.exports = {}").unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/objects/ab12"), "binary").unwrap();
        std::fs::create_dir_all(root.join(".next/server")).unwrap();
        std::fs::write(root.join("visible.ts"), "export const x = 1;").unwrap();

        let tree = walk(&root);

        assert!(find_by_name(&tree, "visible.ts").is_some());
        assert!(find_by_name(&tree, "node_modules").is_none());
        assert!(find_by_name(&tree, "index.js").is_none());
        assert!(find_by_name(&tree, ".git").is_none());
        assert!(find_by_name(&tree, ".next").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The rule was "skip anything starting with a dot", which hid the files a
    /// developer opens most — `.env` above all. Only *named* caches are skipped.
    #[test]
    fn dotfiles_a_user_edits_are_listed() {
        let root = scratch("tree-dotfiles");
        std::fs::write(root.join(".env"), "API_KEY=1").unwrap();
        std::fs::write(root.join(".gitignore"), "node_modules").unwrap();
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::write(root.join(".github/workflows/ci.yml"), "on: push").unwrap();

        let tree = walk(&root);

        assert!(find_by_name(&tree, ".env").is_some(), "a project's .env must be visible");
        assert!(find_by_name(&tree, ".gitignore").is_some());
        assert!(find_by_name(&tree, "ci.yml").is_some(), "nested dot-directories are walked");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The relaunch derives the bundle from the resource directory, and a wrong
    /// derivation has two bad endings: `open` on a path that is not there, or
    /// quitting into nothing because the exit status was never checked. Pinning
    /// the derivation is what keeps that out of a release — the command itself
    /// cannot be exercised end to end until a *later* build is the one running
    /// when an update is installed.
    #[test]
    fn the_bundle_is_derived_from_the_shipped_resource_layout() {
        assert_eq!(
            bundle_from_resource_dir(Path::new("/Applications/ACSA Code.app/Contents/Resources")),
            Some(Path::new("/Applications/ACSA Code.app"))
        );
        // A name that merely contains a dot is not a bundle.
        assert_eq!(
            bundle_from_resource_dir(Path::new("/Applications/Sierra.app.store/Contents/Resources")),
            None
        );
    }

    #[test]
    fn a_development_layout_has_no_bundle_to_relaunch_through() {
        // `tauri dev` runs the binary out of `target/`, where there is no `.app`
        // around it, so the command must fall back to Tauri's own restart — and
        // it must not panic on a path with no parents at all.
        assert_eq!(bundle_from_resource_dir(Path::new("/repo/.tauri/target/debug")), None);
        assert_eq!(bundle_from_resource_dir(Path::new("/Resources")), None);
        assert_eq!(bundle_from_resource_dir(Path::new("")), None);
    }

    #[test]
    fn a_project_skill_reaches_the_runtime_in_the_shape_it_reads() {
        let root = scratch("mirror");
        let project = root.join("project");
        let home = root.join("codex");
        std::fs::create_dir_all(project.join(".acsa/skills")).unwrap();
        // Our loader's shape: a flat file, with a key the runtime does not document.
        std::fs::write(
            project.join(".acsa/skills/code-review.md"),
            "---\nname: code-review\ndescription: Reviews a diff\ntriggers: [\"/code-review\"]\n---\n\n# Steps\nRead it.",
        )
        .unwrap();

        assert_eq!(sync_project_skills(&home, &project).unwrap(), 1);

        let written = std::fs::read_to_string(home.join("skills/code-review/SKILL.md")).unwrap();
        assert!(written.starts_with("---\nname: code-review\ndescription: Reviews a diff\n---"));
        assert!(!written.contains("triggers"));
        assert!(written.contains("# Steps"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_removed_skill_stops_being_offered() {
        let root = scratch("stale");
        let project = root.join("project");
        let home = root.join("codex");
        std::fs::create_dir_all(project.join(".acsa/skills")).unwrap();
        std::fs::write(project.join(".acsa/skills/one.md"), "one").unwrap();
        std::fs::write(project.join(".acsa/skills/two.md"), "two").unwrap();
        assert_eq!(sync_project_skills(&home, &project).unwrap(), 2);

        // Uninstall one, and re-run: the mirrored copy has to go too, or the agent
        // keeps a skill the user removed.
        std::fs::remove_file(project.join(".acsa/skills/two.md")).unwrap();
        assert_eq!(sync_project_skills(&home, &project).unwrap(), 1);
        assert!(home.join("skills/one/SKILL.md").exists());
        assert!(!home.join("skills/two").exists());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_project_with_no_skills_is_not_an_error() {
        let root = scratch("empty");
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(sync_project_skills(&root.join("codex"), &project).unwrap(), 0);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn frontmatter_without_a_description_still_parses() {
        let out = normalise_skill_markdown("---\nname: plain\n---\n\nBody", "plain");
        assert!(out.contains("name: plain"));
        assert!(out.contains("description: Project skill plain"));
        assert!(out.ends_with("Body"));
    }

    #[test]
    fn only_http_urls_are_handed_to_the_os() {
        // This is the whole guard between a page string and the OS opener.
        assert!(is_openable_url("https://example.com/a?b=c"));
        assert!(is_openable_url("http://example.com"));
        assert!(is_openable_url("  https://example.com  "));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("-R /Applications"));
        assert!(!is_openable_url("https://example.com\nrm -rf /"));
        assert!(!is_openable_url(""));
    }

    #[test]
    fn base64_matches_the_reference_encoder() {
        // A preview that decodes wrong is a broken image, so the padding and the
        // partial-chunk cases are the whole point of this test.
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0x00, 0xfe]), "/wD+");
    }

    #[test]
    fn base64_round_trips_through_the_decoder() {
        // Every length mod 3, so each padding case is exercised, including the
        // awkward ones a hand-rolled decoder gets wrong.
        for len in 0..40usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let decoded = base64_decode(&base64_encode(&bytes)).expect("must decode");
            assert_eq!(decoded, bytes, "round trip failed at length {}", len);
        }
        // Known vectors, including the ones with padding.
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("/wD+").unwrap(), &[0xff, 0x00, 0xfe]);
    }

    #[test]
    fn base64_decoder_rejects_junk_and_ignores_whitespace() {
        assert!(base64_decode("not*base64").is_err());
        // A data URL payload wraps at 76 columns in some encoders.
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn attachments_are_written_where_the_runtime_can_read_them() {
        let home = std::env::temp_dir().join("acsa-attach-test");
        let _ = std::fs::remove_dir_all(&home);
        // One pixel PNG, enough to prove the pipeline decodes real image bytes.
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let path = write_attachment(&home, data_url, 0).expect("must write");
        assert!(path.starts_with(home.join("attachments")));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "not a PNG on disk");
        // A non-image or a non-data URL is skipped rather than written blindly.
        assert!(write_attachment(&home, "https://example.com/x.png", 1).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A stand-in for `codex app-server`: JSON-RPC on stdin/stdout, the same
    /// framing the real one uses. Tests the session layer's own behaviour —
    /// id correlation, notification forwarding, approval requests, and the
    /// superseded-session guard — without a network or a model.
    ///
    /// It is executable and shebang-led on purpose: `spawn` takes a program, not
    /// a command line, so the only way to drive it through the real code path is
    /// to run it as a program. A script that is simply written (not chmod'd) made
    /// an earlier version of this test pass while exercising nothing.
    fn fake_app_server() -> PathBuf {
        // One file per call: cargo runs these tests in parallel threads of one
        // process, so a shared name means one test's cleanup deletes another
        // test's runtime mid-run.
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("acsa-fake-appserver-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("fake_app_server_{}.py", n));
        // A permissions probe and a denial are both legal: this is a fake, not a
        // model, so it answers deterministically.
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def note(method, params):
    send({"method": method, "params": params})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    rid = msg.get("id")
    # A reply (no method) is the client answering us. Report the approval answer
    # so a test can prove the decision made it across the pipe intact.
    if method is None:
        if rid == 900:
            note("acsa/test/approvalAnswer", {"result": msg.get("result")})
        continue
    if method == "initialize":
        send({"id": rid, "result": {"userAgent": "fake", "codexHome": "/tmp"}})
    elif method == "thread/start":
        thread = {"id": "fake-thread-1"}
        send({"id": rid, "result": {"thread": thread}})
        note("thread/started", {"thread": thread})
    elif method == "turn/start":
        turn = {"id": "fake-turn-1"}
        send({"id": rid, "result": {"turn": turn}})
        note("turn/started", {"threadId": "fake-thread-1", "turn": turn})
        # A request the client must answer before the turn can continue.
        # The method name is the one the real runtime uses (the schema lists
        # `execCommandApproval` only as a legacy spelling).
        send({"id": 900, "method": "item/commandExecution/requestApproval",
              "params": {"itemId": "c1", "command": "echo hi", "cwd": "/tmp",
                         "threadId": "fake-thread-1", "turnId": "fake-turn-1",
                         "startedAtMs": 0}})
        note("item/completed", {"item": {"type": "agentMessage", "text": "done", "id": "m1"}})
        note("turn/completed", {"threadId": "fake-thread-1", "turn": turn})
    elif method == "turn/steer":
        # Echo the params back, so a test can prove the request carried the
        # thread, the *expected* turn id and the message — the three required
        # fields, one of which is a precondition rather than a name.
        note("acsa/test/steerParams", msg.get("params"))
        send({"id": rid, "result": {"turnId": "fake-turn-1"}})
    elif method == "turn/interrupt":
        send({"id": rid, "result": {}})
"#,
        )
        .expect("write fake server");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&path)
                .expect("stat the fake server")
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).expect("make the fake server runnable");
        }
        path
    }

    #[test]
    fn agent_session_correlates_replies_and_forwards_the_rest() {
        let script = fake_app_server();
        let events: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let emitter: AgentEmitter = std::sync::Arc::new(move |name: &str, line: String| {
            sink.lock().unwrap().push((name.to_string(), line));
        });

        let mut session = AgentSession::spawn(&script, &std::env::temp_dir(), ".", &[], emitter)
            .expect("spawn the fake runtime");

        // A request gets *its own* reply, matched by id. Two in a row proves the
        // ids advance and that a reply is not handed to the wrong caller — the
        // failure mode that made every request look like a timeout.
        let hello = session
            .request("initialize", serde_json::json!({}), std::time::Duration::from_secs(5))
            .expect("initialize answers");
        assert_eq!(hello["result"]["userAgent"], "fake");
        let thread = session
            .request("thread/start", serde_json::json!({}), std::time::Duration::from_secs(5))
            .expect("thread/start answers");
        assert_eq!(thread["result"]["thread"]["id"], "fake-thread-1");

        // `turn/start` makes the server emit a *request* (the approval) and two
        // notifications. The request must reach the UI rather than be mistaken
        // for a reply; the notifications must be forwarded; and the turn id must
        // be remembered so an interrupt can name it.
        session
            .request("turn/start", serde_json::json!({}), std::time::Duration::from_secs(5))
            .expect("turn/start answers");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let saw = |needle: &str| {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|(name, line)| name == "agent:event" && line.contains(needle))
        };
        while !saw("turn/completed") && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(
            saw("item/commandExecution/requestApproval"),
            "the approval request must reach the UI, not be swallowed as a reply"
        );
        assert!(saw("turn/started"), "the turn-start notification is forwarded");
        assert!(saw("turn/completed"), "the turn-complete notification is forwarded");
        assert_eq!(
            session.turn_id.lock().unwrap().clone().as_deref(),
            Some("fake-turn-1"),
            "the live turn id is remembered, so turn/interrupt can name it"
        );

        // The answer travels back over the same pipe. This is the direction that
        // was wrong once — the runtime expects a decision *string*, and an
        // unrecognised value fails its deserialization, hanging the turn.
        session
            .respond(serde_json::json!(900), serde_json::json!({"decision": "accept"}))
            .expect("the answer is written");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !saw("acsa/test/approvalAnswer") && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let answered = events
            .lock()
            .unwrap()
            .iter()
            .find(|(_, line)| line.contains("acsa/test/approvalAnswer"))
            .map(|(_, line)| line.clone())
            .expect("the fake runtime reports the answer it received");
        assert!(
            answered.contains("accept"),
            "the decision reaches the runtime intact: {answered}"
        );

        let _ = session.child.kill();
        let _ = std::fs::remove_file(&script);
    }

    /// The integration test that needs real infrastructure.
    ///
    /// Ignored by default because it needs two things the suite cannot assume: a
    /// reachable model provider (a local Ollama serving `qwen2.5-coder:1.5b`),
    /// and a sandbox that permits localhost. Run it deliberately:
    ///
    /// ```text
    /// cargo test --manifest-path .tauri/Cargo.toml \
    ///   a_turn_completes_over_the_real_runtime -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs a reachable model provider and localhost access"]
    fn a_turn_completes_over_the_real_runtime() {
        // Opt-in by construction: without the fetched runtime there is nothing to
        // test, and the suite should say so rather than fail.
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let program = repo.join(".tauri").join("engine-codex").join("codex");
        if !program.exists() {
            eprintln!("skipping: {} not fetched", program.display());
            return;
        }
        let home = std::env::temp_dir().join("acsa-agent-session-home");
        let _ = std::fs::create_dir_all(&home);
        std::fs::write(
            home.join("config.toml"),
            "approval_policy = \"on-request\"\napprovals_reviewer = \"auto_review\"\nsandbox_mode = \"workspace-write\"\n",
        )
        .unwrap();

        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let emitter: AgentEmitter = std::sync::Arc::new(move |name: &str, line: String| {
            sink.lock().unwrap().push(format!("{} {}", name, line));
        });

        let env: Vec<(String, String)> = match std::env::var("ACSA_CODEX_API_KEY") {
            Ok(key) => vec![("ACSA_CODEX_API_KEY".to_string(), key)],
            Err(_) => Vec::new(),
        };
        let mut session =
            AgentSession::spawn(&program, &home, ".", &env, emitter).expect("spawn runtime");
        session
            .request(
                "initialize",
                serde_json::json!({"clientInfo": {"name": "acsa-test", "version": "0"}}),
                std::time::Duration::from_secs(30),
            )
            .expect("initialize");

        let started = session.request(
            "thread/start",
            serde_json::json!({
                "model": "qwen2.5-coder:1.5b",
                "modelProvider": "ollama",
                "cwd": ".",
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandbox": "workspace-write",
            }),
            std::time::Duration::from_secs(60),
        );
        let started = match started {
            Ok(reply) => reply,
            Err(error) => {
                // No local model running is not a defect in this layer.
                eprintln!("skipping: no local provider ({})", error);
                return;
            }
        };
        let thread_id = started["result"]["thread"]["id"].as_str().unwrap().to_string();

        session
            .request(
                "turn/start",
                serde_json::json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text": "Reply with just: ready"}],
                }),
                std::time::Duration::from_secs(30),
            )
            .expect("turn/start");

        // The whole point: a turn must finish. This is the failure that took a
        // rebuild-and-click cycle to see, and it is invisible to the compiler.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        loop {
            {
                let log = seen.lock().unwrap();
                if log.iter().any(|entry| entry.contains("turn/completed")) {
                    break;
                }
                if log.iter().any(|entry| entry.contains("turn/failed")) {
                    panic!("the runtime reported the turn failed: {:?}", *log);
                }
                // Transport trouble the runtime is retrying — an unreachable
                // provider, or a sandbox that forbids localhost. Neither is a
                // defect in this layer, and paying three minutes to discover it
                // is not useful. Say so and stop.
                if log.iter().any(|entry| entry.contains("\"willRetry\":true")) {
                    eprintln!(
                        "skipping: the model provider is unreachable (is Ollama running, and does this sandbox allow localhost?)"
                    );
                    let _ = session.child.kill();
                    return;
                }
            }
            if std::time::Instant::now() > deadline {
                let log = seen.lock().unwrap().clone();
                panic!("no turn/completed within 180s; events seen: {:#?}", log);
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let _ = session.child.kill();
    }

    /// A replaced session must not announce its own death into the next run.
    ///
    /// This is the ordering bug behind "turn finished in 0s" — an empty answer on
    /// the *second* message of a session and never the first. The outgoing
    /// process was killed before the current-session counter moved, so its dying
    /// stdout EOF was read as the new run's exit and the run ended the moment it
    /// began. The fix is to supersede before killing; this holds it in place.
    #[test]
    fn a_superseded_session_exits_quietly_and_the_current_one_does_not() {
        let script = fake_app_server();
        let events: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let emitter: AgentEmitter = std::sync::Arc::new(move |name: &str, line: String| {
            sink.lock().unwrap().push((name.to_string(), line));
        });
        let exits = || {
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, _)| name == "agent:exit")
                .count()
        };

        let mut superseded = AgentSession::spawn(
            &script,
            &std::env::temp_dir(),
            ".",
            &[],
            emitter.clone(),
        )
        .expect("spawn the outgoing session");
        // The order the fix enforces: mark it superseded first, *then* kill it.
        SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = superseded.child.kill();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(
            exits(),
            0,
            "a superseded session must stay quiet, or the next run ends instantly"
        );

        // The current session is the opposite case: its exit *is* the run's exit.
        let mut current =
            AgentSession::spawn(&script, &std::env::temp_dir(), ".", &[], emitter).expect("spawn");
        let _ = current.child.kill();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while exits() == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(exits() >= 1, "the current session's exit must be emitted");

        let _ = std::fs::remove_file(&script);
    }

    /// The approval round-trip against the real runtime.
    ///
    /// This is the one thing the scripted test cannot prove: that the runtime
    /// *accepts* the decision we send and carries on. `approvals_reviewer =
    /// "user"` makes it ask before it runs anything, so a prompt that asks for a
    /// command produces a real `item/commandExecution/requestApproval`. Ignored
    /// for the same reason as the test above; run it with `--ignored`.
    #[test]
    #[ignore = "needs a reachable model provider and localhost access"]
    fn a_real_approval_is_answered_and_the_turn_continues() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let program = repo.join(".tauri").join("engine-codex").join("codex");
        if !program.exists() {
            eprintln!("skipping: {} not fetched", program.display());
            return;
        }
        let home = std::env::temp_dir().join("acsa-agent-approval-home");
        let _ = std::fs::create_dir_all(&home);
        std::fs::write(
            home.join("config.toml"),
            "approval_policy = \"on-request\"\napprovals_reviewer = \"user\"\nsandbox_mode = \"workspace-write\"\n",
        )
        .unwrap();

        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        let emitter: AgentEmitter = std::sync::Arc::new(move |name: &str, line: String| {
            sink.lock().unwrap().push(format!("{} {}", name, line));
        });
        let env: Vec<(String, String)> = match std::env::var("ACSA_CODEX_API_KEY") {
            Ok(key) => vec![("ACSA_CODEX_API_KEY".to_string(), key)],
            Err(_) => Vec::new(),
        };
        let mut session =
            AgentSession::spawn(&program, &home, ".", &env, emitter).expect("spawn runtime");
        session
            .request(
                "initialize",
                serde_json::json!({"clientInfo": {"name": "acsa-test", "version": "0"}}),
                std::time::Duration::from_secs(30),
            )
            .expect("initialize");

        let started = session.request(
            "thread/start",
            serde_json::json!({
                "model": "qwen2.5-coder:1.5b",
                "modelProvider": "ollama",
                "cwd": ".",
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandbox": "workspace-write",
            }),
            std::time::Duration::from_secs(60),
        );
        let started = match started {
            Ok(reply) => reply,
            Err(error) => {
                eprintln!("skipping: no local provider ({})", error);
                return;
            }
        };
        let thread_id = started["result"]["thread"]["id"].as_str().unwrap().to_string();
        session
            .request(
                "turn/start",
                serde_json::json!({
                    "threadId": thread_id,
                    "input": [{"type": "text", "text":
                        "Use the terminal to run exactly this command: echo acsa-approved"}],
                }),
                std::time::Duration::from_secs(30),
            )
            .expect("turn/start");

        // Walk the stream: answer the first approval with `accept`, then require
        // the turn to reach `turn/completed` — i.e. the runtime accepted the
        // answer and continued rather than stalling on a malformed decision.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(150);
        let mut answered = false;
        while std::time::Instant::now() < deadline {
            // Once answered, stop scanning: the request stays in the log, and
            // answering it twice would be a bug the test caused itself.
            let pending: Option<(serde_json::Value, String)> = if answered {
                None
            } else {
                let log = seen.lock().unwrap();
                if log.iter().any(|e| e.contains("\"willRetry\":true")) {
                    eprintln!("skipping: the model provider is unreachable");
                    let _ = session.child.kill();
                    return;
                }
                if log.iter().any(|e| e.contains("turn/completed")) {
                    // The model chose not to call a tool, so there was nothing to
                    // approve. That is the model, not the transport — say so and
                    // stop rather than pass, which would prove nothing.
                    if !answered {
                        eprintln!(
                            "skipping: the model answered without asking for approval, so the round-trip was not exercised"
                        );
                    }
                    let _ = session.child.kill();
                    return;
                }
                log.iter()
                    .filter(|e| e.contains("requestApproval"))
                    .find_map(|e| {
                        let json = e.split_once('{').map(|(_, rest)| format!("{{{rest}"))?;
                        let value: serde_json::Value = serde_json::from_str(&json).ok()?;
                        Some((value.get("id")?.clone(), e.clone()))
                    })
            };
            if let Some((id, raw)) = pending {
                eprintln!("answering approval: {}", &raw[..raw.len().min(200)]);
                session
                    .respond(id, serde_json::json!({"decision": "accept"}))
                    .expect("the approval answer is written");
                answered = true;
                // Let the runtime act on it and finish.
                std::thread::sleep(std::time::Duration::from_secs(20));
                continue;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let log = seen.lock().unwrap().clone();
        panic!(
            "no turn/completed within 150s (answered={}); events: {:#?}",
            answered, log
        );
    }

    /// The OUTPUT panel is carried verbatim from the runtime, so it is also the
    /// most likely place for a live credential to end up on screen.
    #[test]
    fn credentials_are_masked_before_they_reach_the_panel() {
        let none: Vec<String> = Vec::new();
        let cases = [
            ("Authorization: Bearer sk-live-abcdef123456", "sk-live-abcdef123456"),
            ("api_key=sk-abcdef123456", "sk-abcdef123456"),
            (r#"{"apiKey":"sk-abcdef123456"}"#, "sk-abcdef123456"),
            ("ACSA_CODEX_API_KEY=abcdef123456", "abcdef123456"),
            ("client_secret: abcdef123456", "abcdef123456"),
            ("password=hunter2hunter2", "hunter2hunter2"),
        ];
        for (line, secret) in cases {
            let masked = redact_for_display(line, &none);
            assert!(!masked.contains(secret), "not masked: {masked}");
            assert!(masked.contains(MASK), "nothing masked: {masked}");
        }
    }

    #[test]
    fn a_credential_we_handed_over_is_masked_wherever_it_appears() {
        // Whatever it looks like — a key with no recognisable prefix still goes.
        let known = vec!["zz9-plainvalue-noprefix".to_string()];
        let masked = redact_for_display("failed to authenticate with zz9-plainvalue-noprefix (401)", &known);
        assert!(!masked.contains("zz9-plainvalue-noprefix"), "{masked}");
        assert!(masked.contains("(401)"), "the diagnosis survived: {masked}");
    }

    #[test]
    fn ordinary_log_lines_are_left_alone() {
        // Masking is display-only, so a false positive costs real information:
        // a turn id, a token count and a commit sha all stay readable.
        let none: Vec<String> = Vec::new();
        for line in [
            r#"{"type":"turn.completed","usage":{"input_tokens":2050,"output_tokens":2}}"#,
            r#"{"sha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"}"#,
            "no secrets are logged here",
            "reading token counts from turn.completed",
            "héllo wörld — ünchanged",
        ] {
            assert_eq!(redact_for_display(line, &none), line, "changed: {line}");
        }
    }

    #[test]
    fn redaction_survives_non_ascii_around_the_secret() {
        let none: Vec<String> = Vec::new();
        let masked = redact_for_display("clé — secret: abcdef123456 — fin", &none);
        assert!(masked.contains("clé"), "text before kept: {masked}");
        assert!(masked.contains("fin"), "text after kept: {masked}");
        assert!(!masked.contains("abcdef123456"), "value masked: {masked}");
    }

    #[test]
    fn a_rejected_patch_reads_as_a_retry_not_a_failure() {
        // Copied from a real run: the tracing prefix, the parser's complaint, then
        // a paragraph of the header grammar it will accept.
        let raw = "2026-09-23T13:15:22.927139Z ERROR codex_core::tools::router: \
error=apply_patch verification failed: invalid hunk at line 362, '' is not a valid hunk header. \
Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";
        match friendly_agent_line(raw) {
            AgentLine::Replace(message) => {
                assert!(message.contains("invalid hunk at line 362"), "{message}");
                assert!(!message.contains("Valid hunk headers"), "grammar dropped: {message}");
                assert!(!message.contains("codex_core::tools::router"), "prefix dropped: {message}");
                assert!(message.contains("retrying"), "says what is happening: {message}");
            }
            AgentLine::Keep => panic!("a rejected patch should be translated, not printed raw"),
            AgentLine::Hide => panic!("a rejected patch should be translated, not hidden"),
        }
    }

    #[test]
    fn a_rejected_patch_with_no_cause_still_reads_as_a_retry() {
        // The second shape seen in the same run: no reason after the colon.
        match friendly_agent_line("ERROR codex_core::tools::router: error=apply_patch verification failed") {
            AgentLine::Replace(message) => {
                assert!(message.contains("did not parse"), "{message}");
                assert!(message.contains("retrying"), "{message}");
            }
            AgentLine::Keep => panic!("expected a translation"),
            AgentLine::Hide => panic!("expected a translation, not a hide"),
        }
    }

    /// Captured verbatim from the runtime this build ships, against the three
    /// providers checked with the same config the app writes. Each is a provider
    /// that offers chat completions only — the failure a user hits when they pick
    /// a capable model whose API has no Responses endpoint.
    const CHAT_ONLY_PROVIDER_404S: [&str; 3] = [
        "2026-09-26T23:38:08.762940Z  WARN codex_core::responses_retry: stream disconnected - retrying sampling request (1/5 in 196ms)... turn_id=01a0e015 retries=1 max_retries=5 sampling_error=unexpected status 404 Not Found: Not found, url: https://api.anthropic.com/v1/responses, cf-ray: a41619b98dc11b60-NBO",
        "2026-09-26T23:38:26.461468Z  WARN codex_core::responses_retry: stream disconnected - retrying sampling request (1/5 in 201ms)... sampling_error=unexpected status 404 Not Found: {\n}, url: https://api.mistral.ai/v1/responses, cf-ray: a4161a27fabcb0f0-NBO",
        "2026-09-26T23:38:47.087611Z  WARN codex_core::responses_retry: stream disconnected - retrying sampling request (1/5 in 206ms)... sampling_error=unexpected status 404 Not Found: Unknown error, url: https://generativelanguage.googleapis.com/responses",
    ];

    #[test]
    fn a_provider_without_the_responses_api_says_so_once() {
        for raw in CHAT_ONLY_PROVIDER_404S {
            match friendly_agent_line(raw) {
                AgentLine::Replace(message) => {
                    assert!(message.contains("404"), "{message}");
                    assert!(message.contains("/responses"), "names the endpoint: {message}");
                    assert!(message.contains("chat"), "says where it still works: {message}");
                    assert!(
                        !message.contains("codex_core::responses_retry"),
                        "tracing prefix dropped: {message}"
                    );
                    assert!(
                        !message.contains("retrying sampling request"),
                        "the retry noise is dropped: {message}"
                    );
                }
                AgentLine::Keep => panic!("a chat-only provider must be explained, not printed raw"),
                AgentLine::Hide => panic!("a chat-only provider must be explained, not hidden"),
            }
        }
    }

    #[test]
    fn the_retry_echo_around_that_404_is_dropped() {
        // The runtime prints these beside the warning above; they add nothing.
        for line in ["ERROR: Reconnecting... 1/5", "ERROR: Reconnecting... 5/5"] {
            assert!(matches!(friendly_agent_line(line), AgentLine::Hide), "kept: {line}");
        }
    }

    #[test]
    fn ordinary_stderr_is_not_rewritten() {
        // The translation is display-only and must not swallow a real diagnosis.
        for line in [
            "warning: something the user can act on",
            r#"{"type":"turn.completed","usage":{"input_tokens":10}}"#,
            "apply_patch succeeded",
            "error=apply_patch failed to find the file",
        ] {
            assert!(matches!(friendly_agent_line(line), AgentLine::Keep), "rewrote: {line}");
        }
    }

    #[test]
    fn the_runtimes_own_model_metadata_warning_is_dropped() {
        // The line the user read as "the metadata errors". The app writes every
        // model the user picked into the catalog on each run, so an unknown slug
        // here is always one of the runtime's own internals, and the warning says
        // it falls back to metadata — it is not actionable.
        let raw = "2026-09-23T14:06:26.977051Z  WARN codex_models_manager::model_info: \
Unknown model gpt-5.6-luna is used. This will use fallback model metadata.";
        assert!(matches!(friendly_agent_line(raw), AgentLine::Hide));
    }

    #[test]
    fn a_model_warning_the_user_could_act_on_is_kept() {
        // Anything else from the same logger is left alone, so this does not
        // become a blanket silence on model problems.
        let raw = "WARN codex_models_manager::model_info: model provider timed out";
        assert!(matches!(friendly_agent_line(raw), AgentLine::Keep));
    }

    #[test]
    fn run_with_timeout_kills_a_wedged_child() {
        // The real failure this exists for: the engine sat inside one `open()`
        // for minutes while a permission prompt went unanswered, so the request
        // never returned and the process never exited.
        let started = std::time::Instant::now();
        let result = run_with_timeout_env(
            &PathBuf::from("/bin/sleep"),
            &["30".to_string()],
            &[],
            std::time::Duration::from_millis(300),
        );
        assert!(result.is_err(), "a wedged child must not be reported as success");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the deadline was measured in tenths of a second, not respected"
        );
    }

    #[test]
    fn run_with_timeout_drains_output_larger_than_a_pipe_buffer() {
        // `index` returns the whole symbol table. A child that fills the pipe
        // blocks until someone reads it, which looks identical to a hang.
        let args: Vec<String> = vec![
            "-c".into(),
            "head -c 300000 /dev/zero | tr '\\0' 'x'".into(),
        ];
        let out = run_with_timeout_env(
            &PathBuf::from("/bin/sh"),
            &args,
            &[],
            std::time::Duration::from_secs(20),
        )
        .expect("large output must not time out");
        assert_eq!(out.stdout.len(), 300_000);
    }

    #[test]
    fn run_with_timeout_returns_the_exit_status() {
        let out = run_with_timeout_env(
            &PathBuf::from("/bin/sh"),
            &["-c".into(), "exit 3".into()],
            &[],
            std::time::Duration::from_secs(20),
        )
        .expect("a failing command still runs");
        assert_eq!(out.status.code(), Some(3));
    }

    #[test]
    fn dir_size_skips_node_modules() {
        let root = std::env::temp_dir().join("acsa-dir-size-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("a.txt"), b"12345").unwrap();
        std::fs::write(root.join("node_modules").join("big.bin"), vec![0u8; 4096]).unwrap();
        assert_eq!(dir_size_bytes(&root), 5);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The IPC allowlist is the boundary between "the page can ask the engine
    /// something" and "the page can run anything". It is worth a test because
    /// the failure mode is silent in both directions: an entry that is missing
    /// breaks a feature, and one that should not be there hands a compromised
    /// webview a process spawn.
    #[test]
    fn only_the_intended_engine_subcommands_are_reachable_from_the_page() {
        // Used by the UI, and reached through `engine_call` with page-supplied
        // arguments — including the two added for Data & backups.
        for allowed in [
            "db", "ollama", "index", "git", "indexer", "skills", "mcp", "ai", "project", "fs",
            "backup", "support", "snapshot",
        ] {
            assert!(engine_subcommand_allowed(allowed), "{allowed} must be reachable");
        }

        for blocked in ["pty", "adapter", "selftest", "", "rm -rf"] {
            assert!(
                !engine_subcommand_allowed(blocked),
                "{blocked} must not be reachable from the page"
            );
        }
    }

    /// The New Project dialog hands us `~/AcsaProjects` by default. Rust does not
    /// expand `~`, so until this existed the default destination was a *relative*
    /// path and every scaffold from the default location failed — silently, since
    /// the modal closes before the write is attempted.
    #[test]
    fn a_leading_tilde_expands_to_the_home_directory() {
        let home = Path::new("/Users/example");

        // The dialog's default destination, and the shape its placeholder
        // suggests.
        assert_eq!(
            expand_home_against("~/AcsaProjects", Some(home)),
            PathBuf::from("/Users/example/AcsaProjects")
        );
        assert_eq!(expand_home_against("~", Some(home)), home.to_path_buf());
        assert_eq!(
            expand_home_against("  ~/Desktop  ", Some(home)),
            PathBuf::from("/Users/example/Desktop")
        );

        // Not a home shorthand: left exactly as given.
        assert_eq!(
            expand_home_against("/tmp/absolute", Some(home)),
            PathBuf::from("/tmp/absolute")
        );
        assert_eq!(
            expand_home_against("relative/dir", Some(home)),
            PathBuf::from("relative/dir")
        );
        assert_eq!(
            expand_home_against("~someone-else", Some(home)),
            PathBuf::from("~someone-else")
        );

        // With no home to expand to, the shorthand stays literal instead of
        // quietly becoming a relative path.
        assert_eq!(
            expand_home_against("~/AcsaProjects", None),
            PathBuf::from("~/AcsaProjects")
        );
    }

    /// The half `expand_home` cannot cover: the template really is written out.
    /// Uses an explicit destination, so it never touches a real home directory.
    #[test]
    fn scaffolding_writes_the_template_under_the_given_directory() {
        let root = std::env::temp_dir().join(format!("acsa-scaffold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let created = create_project_template(
            "My Test App!".to_string(),
            "vite-react".to_string(),
            Some(root.to_string_lossy().to_string()),
        )
        .expect("scaffolding should succeed");

        // Spaces and punctuation become `_`; case is left alone here (the dialog
        // lowercases before it calls).
        let project = root.join("My_Test_App_");
        assert_eq!(PathBuf::from(&created), project);
        assert!(project.join("package.json").is_file());
        assert!(project.join("src").join("App.tsx").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every template the New Project dialog offers must produce the files its
    /// badge promises. Four of the six used to fall through to a catch-all and
    /// write a Python `main.py` instead — including the default, so "Next.js 15
    /// App Router" handed the user a Python hello-world.
    ///
    /// The pairs below are copied from `src/components/ProjectModal.tsx`; if that
    /// list and this one ever disagree, this test is the thing that notices.
    #[test]
    fn every_offered_template_scaffolds_its_advertised_files() {
        let offered: [(&str, &[&str]); 6] = [
            ("nextjs", &["app/page.tsx", "app/layout.tsx", "package.json"]),
            ("vite-react", &["src/App.tsx", "vite.config.ts", "package.json"]),
            ("nestjs", &["src/main.ts", "src/app.module.ts", "nest-cli.json"]),
            (
                "supabase",
                &["src/server.js", "src/supabaseClient.js", ".env.example"],
            ),
            ("fastapi", &["main.py", "models.py", "requirements.txt"]),
            ("express", &["server.js", "package.json", "README.md"]),
        ];

        for (id, advertised) in offered {
            let root = std::env::temp_dir().join(format!("acsa-tpl-{}-{}", id, std::process::id()));
            let _ = std::fs::remove_dir_all(&root);

            let created = create_project_template(
                "demo".to_string(),
                id.to_string(),
                Some(root.to_string_lossy().to_string()),
            )
            .unwrap_or_else(|e| panic!("{id} should scaffold: {e}"));
            assert_eq!(PathBuf::from(&created), root.join("demo"));

            for file in advertised {
                let written = root.join("demo").join(file);
                assert!(written.is_file(), "{id} did not write {file}");
                let body = std::fs::read_to_string(&written).unwrap();
                assert!(!body.is_empty(), "{id} wrote an empty {file}");
                // The substitution actually happened.
                assert!(
                    !body.contains("__PROJECT_NAME__"),
                    "{id}/{file} still holds the placeholder"
                );
            }

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn an_unknown_template_is_an_error_and_writes_nothing() {
        let root = std::env::temp_dir().join(format!("acsa-tpl-unknown-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let result = create_project_template(
            "demo".to_string(),
            "definitely-not-a-template".to_string(),
            Some(root.to_string_lossy().to_string()),
        );

        assert!(result.is_err(), "an unknown template must not silently succeed");
        // Nothing half-made left behind, and above all no stray main.py.
        assert!(!root.exists(), "an unknown template created {}", root.display());
    }

    #[test]
    fn a_steer_names_the_turn_it_expects() {
        // The schema marks `expectedTurnId` required and calls it a precondition,
        // so this is the field a wrong guess would silently turn into a second
        // turn. Read from `codex app-server generate-json-schema`, not inferred.
        let params = steer_params("thread-7", "turn-9", "actually, use tabs");
        assert_eq!(params["threadId"], "thread-7");
        assert_eq!(params["expectedTurnId"], "turn-9");
        assert_eq!(params["input"][0]["type"], "text");
        assert_eq!(params["input"][0]["text"], "actually, use tabs");
        // Exactly the three required keys, so nothing is sent that the runtime
        // would have to ignore.
        let keys: Vec<&String> = params.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 3, "unexpected keys: {keys:?}");
    }

    #[test]
    fn a_steer_reaches_the_runtime_and_its_message_survives_the_pipe() {
        let script = fake_app_server();
        let events: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let emitter: AgentEmitter = std::sync::Arc::new(move |name: &str, line: String| {
            sink.lock().unwrap().push((name.to_string(), line));
        });

        let session = AgentSession::spawn(&script, &std::env::temp_dir(), ".", &[], emitter)
            .expect("spawn the fake runtime");
        session
            .request("initialize", serde_json::json!({}), std::time::Duration::from_secs(5))
            .expect("initialize answers");
        session
            .request("thread/start", serde_json::json!({}), std::time::Duration::from_secs(5))
            .expect("thread/start answers");
        let turn = session
            .request("turn/start", serde_json::json!({}), std::time::Duration::from_secs(5))
            .expect("turn/start answers");
        let turn_id = turn["result"]["turn"]["id"].as_str().unwrap().to_string();

        let reply = session
            .request(
                "turn/steer",
                steer_params("fake-thread-1", &turn_id, "stop and do X instead"),
                std::time::Duration::from_secs(5),
            )
            .expect("turn/steer answers");
        // The reply names the turn the message landed in, which is what the command
        // writes back into the session's turn slot.
        assert_eq!(reply["result"]["turnId"], "fake-turn-1");

        // And the runtime saw the message itself, not just the envelope.
        let seen = events.lock().unwrap();
        let echo = seen
            .iter()
            .find(|(name, line)| name == "agent:event" && line.contains("acsa/test/steerParams"))
            .map(|(_, line)| line.clone())
            .expect("the fake echoed the steer params");
        assert!(echo.contains("stop and do X instead"), "{echo}");
        assert!(echo.contains("expectedTurnId"), "{echo}");
    }

    /// A one-shot HTTP server for the adapter's health check: it answers exactly one
    /// connection with `status_line` and then drops it, which is also what makes
    /// `Connection: close` observable.
    fn mock_health_server(status_line: &'static str) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a port");
        let port = listener.local_addr().expect("a local address").port();
        // Not joined, on purpose: if the code under test never connects, joining
        // would hang the suite instead of failing it. The thread dies with the
        // process, and the only thing it owns is a listener on a random port.
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut discard = [0u8; 512];
                let _ = stream.read(&mut discard);
                let _ = stream.write_all(status_line.as_bytes());
            }
        });
        port
    }

    #[test]
    fn a_port_nothing_is_listening_on_is_not_alive() {
        // The case that mattered: an adapter that died between runs left this in the
        // cache, and the next run was handed a URL with nothing behind it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!adapter_alive(port));
    }

    #[test]
    fn a_healthy_adapter_is_alive() {
        let port = mock_health_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
        );
        assert!(adapter_alive(port));
    }

    #[test]
    fn a_socket_that_accepts_but_does_not_answer_health_is_not_alive() {
        // The disguise a bare connect test falls for: the port is open, so `connect`
        // succeeds, and the first real request is the one that fails.
        let port = mock_health_server("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert!(!adapter_alive(port));
    }

    /// An in-memory `SecretStore` for the migration tests.
    ///
    /// Not the crate's `mock`: that keeps its data *inside* the credential object,
    /// so a freshly built entry starts empty and it cannot exercise the one thing
    /// worth proving — that a value written through one entry can be read back
    /// through another.
    #[derive(Default)]
    struct MemoryStore {
        values: std::sync::Mutex<std::collections::HashMap<String, String>>,
        refuse_writes: bool,
        /// Accepts a write and does not keep it — what `keyring` does when no
        /// platform backend is compiled in, and the reason 0.2.6 put every
        /// credential in the database while the page said "keychain".
        lose_writes: bool,
    }

    impl SecretStore for MemoryStore {
        fn get(&self, name: &str) -> Option<String> {
            self.values.lock().unwrap().get(name).cloned()
        }

        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if self.refuse_writes {
                return Err("the keychain is not available".to_string());
            }
            if self.lose_writes {
                return Ok(());
            }
            self.values.lock().unwrap().insert(name.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(name);
            Ok(())
        }
    }

    #[test]
    fn a_keychain_value_wins_and_the_old_store_is_never_asked() {
        let store = MemoryStore::default();
        store.set("deepseek_api_key", "sk-from-keychain").unwrap();
        let mut asked = false;
        let resolved = resolve_provider_key(
            &store,
            "deepseek",
            || {
                asked = true;
                Some("sk-from-the-database".to_string())
            },
            |_| panic!("nothing was copied, so nothing may be deleted"),
        );
        assert_eq!(resolved.as_deref(), Some("sk-from-keychain"));
        // Once the keychain has it, the old store is not consulted at all — which
        // matters because that lookup spawns the engine.
        assert!(!asked, "the fallback should not have been reached");
    }

    #[test]
    fn a_value_from_the_old_store_is_copied_and_only_then_let_go() {
        let store = MemoryStore::default();
        let old = std::sync::Mutex::new(Some("sk-from-the-database".to_string()));
        let dropped = std::sync::Mutex::new(Vec::<String>::new());

        let resolved = resolve_provider_key(
            &store,
            "deepseek",
            || old.lock().unwrap().clone(),
            |name| {
                dropped.lock().unwrap().push(name.to_string());
                *old.lock().unwrap() = None;
            },
        );

        assert_eq!(resolved.as_deref(), Some("sk-from-the-database"));
        assert_eq!(
            store.get("deepseek_api_key").as_deref(),
            Some("sk-from-the-database"),
            "the value should have been copied into the keychain"
        );
        // The plaintext copy is released only after the keychain was shown to hold
        // the value, and the run still gets its credential from this call.
        assert_eq!(
            dropped.lock().unwrap().as_slice(),
            ["deepseek_api_key"],
            "the copy should have been let go exactly once, and under its own name"
        );
        assert!(old.lock().unwrap().is_none(), "the old copy should be gone");
    }

    #[test]
    fn a_keychain_that_refuses_the_copy_still_returns_the_key() {
        // A headless Linux box with no Secret Service, or a locked keyring: the run
        // has a credential and must not be stopped because a copy failed.
        let store = MemoryStore { refuse_writes: true, ..Default::default() };
        let resolved = resolve_provider_key(
            &store,
            "deepseek",
            || Some("sk-old".to_string()),
            |_| panic!("the keychain never held it, so the only copy must survive"),
        );
        assert_eq!(resolved.as_deref(), Some("sk-old"));
        assert_eq!(store.get("deepseek_api_key"), None);
    }

    #[test]
    fn a_store_that_loses_the_write_keeps_the_only_copy() {
        // The failure that shipped in 0.2.6: the store reports success, a fresh
        // entry cannot see the value, and the old copy is therefore the only real
        // one. The read-back check is what stands between that and a deleted key.
        let store = MemoryStore { lose_writes: true, ..Default::default() };
        let old = std::sync::Mutex::new(Some("sk-only-copy".to_string()));

        let resolved = resolve_provider_key(
            &store,
            "deepseek",
            || old.lock().unwrap().clone(),
            |_| *old.lock().unwrap() = None,
        );

        assert_eq!(resolved.as_deref(), Some("sk-only-copy"));
        assert!(store.get("deepseek_api_key").is_none(), "nothing was stored");
        assert!(
            old.lock().unwrap().is_some(),
            "the store never proved it held the value, so the only copy must survive"
        );
    }

    #[test]
    fn a_missing_credential_resolves_to_nothing_and_writes_nothing() {
        let store = MemoryStore::default();
        assert_eq!(
            resolve_provider_key(
                &store,
                "deepseek",
                || None,
                |_| panic!("nothing was copied, so nothing may be deleted"),
            ),
            None
        );
        // Especially not an empty string: a stored "" would then read as "present".
        assert_eq!(store.get("deepseek_api_key"), None);
    }

    #[test]
    fn the_secret_name_is_the_spelling_the_engine_uses() {
        // The engine writes and reads `{provider}_api_key`
        // (app_db.secret_name_for_provider). Two spellings of the same idea would
        // silently resolve nothing.
        assert_eq!(secret_name_for_provider("deepseek"), "deepseek_api_key");
        assert_eq!(secret_name_for_provider("ollama"), "ollama_api_key");
    }

    #[test]
    fn a_keychain_credential_reaches_the_engine_as_its_own_environment_variable() {
        // The engine resolves `ACSA_SECRET_<NAME>` by lowercasing the suffix
        // (`app_db._env_secret_names`), so the variable has to be the upper-cased
        // name. Getting the case wrong means a keychain-only credential is invisible
        // to the engine, and invisibly so: a missing variable simply means "not set".
        assert_eq!(
            secret_env_var("deepseek_api_key"),
            "ACSA_SECRET_DEEPSEEK_API_KEY"
        );

        let store = MemoryStore::default();
        store.set("deepseek_api_key", "sk-live").unwrap();
        let pairs = secret_env_pairs(
            &store,
            &["deepseek_api_key".to_string(), "openai_api_key".to_string()],
        );
        // Only the name that resolves is handed over. The other is absent rather
        // than present-and-empty, which is a different thing to the engine.
        assert_eq!(
            pairs,
            vec![(
                "ACSA_SECRET_DEEPSEEK_API_KEY".to_string(),
                "sk-live".to_string()
            )]
        );
    }

    /// The real keychain, end to end: write, read back through a fresh entry, delete.
    ///
    /// Ignored by default because it needs an actual OS keychain — and because on a
    /// machine without one it would fail for a reason that has nothing to do with
    /// this code. Run it deliberately on a Mac:
    ///
    ///     cargo test --manifest-path .tauri/Cargo.toml -- --ignored --nocapture
    ///
    /// It is the test that would have caught the missing `keyring` features. With
    /// no backend compiled in the crate falls back to a store that keeps its data
    /// *inside each credential object*: `set_password` returns `Ok`, and a fresh
    /// `Entry` for the same name then answers `NoEntry`. So the write looks like it
    /// worked, `KeychainStore::set`'s read-back check correctly rejects it, and every
    /// credential lands in the database while the settings page says "stored in your
    /// system keychain". `cargo tree -p keyring -e features` showed only `log` — that
    /// is the one-line check to repeat if this ever regresses, because nothing else
    /// in the build can tell the difference.
    #[test]
    fn a_turn_with_an_image_sends_it_as_the_runtime_accepts_it() {
        // The app-server transport sent text alone, so an attached image was
        // dropped there while the same image went through `--image=` on `exec` —
        // the asymmetry a user hit when their message arrived as "text only".
        //
        // The variant and field are the runtime's, asked rather than assumed: an
        // empty `{"type":"localImage"}` answers `missing field \`path\``, and
        // `input_image` — the shape `codex debug prompt-input` renders for the
        // Responses API — is rejected outright as an unknown variant.
        let input = turn_input("look at this", &[PathBuf::from("/tmp/attachments/0.png")]);
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[0]["text"], "look at this");
        assert_eq!(input[1]["type"], "localImage");
        assert_eq!(input[1]["path"], "/tmp/attachments/0.png");
    }

    #[test]
    fn a_turn_without_images_is_just_the_text() {
        // The common case must not acquire an empty image item, which the runtime
        // would reject as malformed rather than ignore.
        let input = turn_input("no pictures", &[]);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "text");
    }

    #[test]
    #[ignore = "needs a real OS keychain; run explicitly on a Mac"]
    fn the_os_keychain_round_trips_a_credential() {
        let store = KeychainStore;
        let name = "acsa-self-test";
        let value = "round-trip-probe";

        store.set(name, value).expect(
            "the keychain refused the write — see the doc comment: this is the \
             signature of a `keyring` build with no platform backend",
        );
        assert_eq!(store.get(name).as_deref(), Some(value));
        store.delete(name).expect("delete should succeed");
        assert_eq!(store.get(name), None, "the probe entry should be gone");
    }

    /// Opt-in, like the real-runtime tests: it needs a real OS keychain and it
    /// writes to it. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs a real OS keychain (writes and removes a throwaway entry)"]
    fn a_real_keychain_round_trips_a_throwaway_credential() {
        let name = format!("keychain-probe-{}", std::process::id());
        let store = KeychainStore;
        // `set` reads back through a fresh entry and only reports success if the
        // value came back, so a successful set *is* the round trip.
        if let Err(error) = store.set(&name, "throwaway-value") {
            // The reason is the point of this test existing at all: an unsigned or
            // ad-hoc-signed binary may be refused by the OS keychain, and that is
            // exactly why the plaintext copy is not deleted until a *signed* build
            // has been shown to read the keychain back.
            eprintln!("no usable OS keychain here: {error}");
            return;
        }
        assert_eq!(store.get(&name).as_deref(), Some("throwaway-value"));
        // Clean up behind ourselves — through the crate directly, because the
        // production store deliberately has no delete yet.
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &name) {
            let _ = entry.delete_credential();
        }
        assert_eq!(store.get(&name), None, "the probe entry should be gone");
    }
}
