"""tool_paths.py — finding a tool a GUI app cannot see on its PATH.

A macOS app launched from the Dock does not inherit the PATH from the user's shell
profile. launchd starts it with the system default — `/usr/bin:/bin:/usr/sbin:/sbin`
— and Homebrew's `/opt/homebrew/bin` is not in it. That is where `gh` installs, and
where Ollama installed with `brew` lives, so `shutil.which`, which reads PATH,
answers "not installed" for a tool the user is running in a terminal at that same
moment. The panel then repeats that answer to the user as though it were the truth.

So PATH is asked first, and the directories the common installers use are asked
after it — a tool that *is* on PATH is still the one chosen, and a tool that is
installed where launchd cannot see it is still found.

A login-shell probe (`$SHELL -lc 'command -v gh'`) would cover more and is
deliberately not used: a shell that prints a banner, or one whose profile takes a
second to load, puts its words where the caller expects a path.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Iterable


def install_dirs() -> tuple[str, ...]:
    """The directories a GUI-launched app is most likely missing, best first."""
    home = Path.home()
    dirs = [home / ".local" / "bin", home / "bin"]

    if sys.platform == "darwin":
        # Homebrew on Apple silicon, Homebrew's Intel prefix, then MacPorts.
        dirs += [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/opt/local/bin")]
    elif os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
        program_files = Path(os.environ.get("ProgramFiles") or "C:/Program Files")
        dirs += [local / "Programs", program_files / "GitHub CLI"]
    else:
        dirs += [Path("/usr/local/bin"), Path("/snap/bin")]

    dirs += [Path("/usr/bin"), Path("/bin")]
    return tuple(str(directory) for directory in dirs)


def find(name: str, extra_paths: Iterable[str] = ()) -> str | None:
    """An absolute path to `name`, or None when it really is not there.

    `extra_paths` are full paths to try before the directories — a copy the app
    installed itself, or a bundle that carries its own binary.
    """
    found = shutil.which(name)
    if found:
        return found

    suffix = ".exe" if os.name == "nt" else ""
    candidates = list(extra_paths)
    candidates += [str(Path(directory) / f"{name}{suffix}") for directory in install_dirs()]

    for candidate in candidates:
        if _runnable(candidate):
            return candidate
    return None


def _runnable(path: str) -> bool:
    if not Path(path).is_file():
        return False
    # Windows has no executable bit to test, and what it finds is runnable.
    return os.name == "nt" or os.access(path, os.X_OK)
