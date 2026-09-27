/**
 * UpdateButton.tsx — the visible half of the updater.
 *
 * A version that nobody notices is a version nobody installs, so when a release
 * is available this appears in the titlebar rather than hiding in Settings. It
 * renders *nothing* when there is nothing to say: an up-to-date app should not
 * carry a permanent "Up to date" badge.
 *
 * Installing is always a click, and the last step is always a restart the user
 * chooses — see `services/appUpdater.ts` for why.
 */

import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { ArrowDownToLine, RefreshCw, X, AlertCircle, Check } from "lucide-react";
import {
  checkForUpdate,
  installUpdate,
  restartApp,
  autoCheckEnabled,
  installProgress,
  UPDATE_ANNOUNCEMENT,
  type AvailableUpdate,
  type InstallProgress,
  type UpdateAnnouncement,
} from "../../services/appUpdater";

/** Long enough that it never competes with the first paint. */
const STARTUP_DELAY_MS = 2500;

type Phase = "idle" | "downloading" | "installing" | "ready" | "failed";

export function UpdateButton() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [open, setOpen] = useState(false);
  // The install is the service's, not this button's: starting one in Settings and
  // closing the modal used to take its progress with it, so the banner had nothing
  // to show until the download had already finished.
  const [install, setInstall] = useState<InstallProgress | null>(installProgress);
  const timerRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoCheckEnabled()) return;
    timerRef.current = window.setTimeout(() => {
      void checkForUpdate().then((found) => {
        setUpdate(found);
        // Already downloaded for this version: the button is a restart, not a
        // second download. This is the surface someone sees after quitting
        // mid-install and launching the old build again.
        if (found?.pendingRestart) {
          setInstall({ version: found.version, phase: "ready", percent: 100 });
        }
      });
    }, STARTUP_DELAY_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  // A check anywhere else — the Settings → About pane, or a later one on launch —
  // shows or clears this button immediately. Without it, finding an update in
  // Settings left the button hidden until the next launch, which made "check now"
  // look like it had done nothing.
  useEffect(() => {
    const onAnnouncement = (event: Event) => {
      const detail = (event as CustomEvent<UpdateAnnouncement>).detail;
      if (!detail) return;
      if (detail.kind === "available") {
        setUpdate(detail.update);
      } else if (detail.kind === "none") {
        setUpdate(null);
      } else {
        // Progress, and the finished state, from wherever the install is running.
        setInstall(detail.progress);
      }
    };
    window.addEventListener(UPDATE_ANNOUNCEMENT, onAnnouncement);
    return () => window.removeEventListener(UPDATE_ANNOUNCEMENT, onAnnouncement);
  }, []);

  // Click-away, so an open panel is never something you have to hunt a close
  // button for.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Derived rather than stored, so there is one answer per question. A record
  // from a previous session (installed, not yet restarted) shows as `ready` too.
  const phase: Phase =
    install?.phase === "ready" || (!install && update?.pendingRestart)
      ? "ready"
      : install?.phase ?? "idle";
  const percent = install?.percent ?? 0;
  const detail = install?.detail ?? "";

  const startInstall = async () => {
    try {
      // No local bookkeeping: `installUpdate` publishes progress through the
      // service, which is what makes it survive this button being unmounted.
      await installUpdate();
    } catch {
      /* the failed phase is already published, with the reason */
    }
  };

  if (!update) return null;

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={`Version ${update.version} is available`}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/50 text-purple-200 transition-all shadow-sm"
      >
        <Icon icon={ArrowDownToLine} className="w-3.5 h-3.5" />
        {/* "Update", not the version number. A bare number reads as *the* version
            rather than *a newer one is waiting*, which is how it was reported. The
            version itself is in the panel, where there is room to say it properly.

            During an install it reports that instead, because a download started in
            Settings → About continues after the modal closes and this is the only
            thing on screen — a banner that still reads "Update" would look like the
            download had stopped. */}
        <span className="text-2xs font-semibold">
          {phase === "downloading"
            ? `${percent}%`
            : phase === "installing"
            ? "Installing…"
            : phase === "ready"
            ? "Restart"
            : phase === "failed"
            ? "Retry"
            : "Update"}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] z-popover rounded-xl border border-zinc-700/80 bg-[#18181b]/97 backdrop-blur-xl shadow-2xl p-3 text-left space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-zinc-100">Update available</div>
              <div className="text-2xs text-zinc-400 font-mono">
                {update.currentVersion} → {update.version}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Close"
              className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              <Icon icon={X} className="w-3 h-3" />
            </button>
          </div>

          {update.notes && phase === "idle" && (
            <p className="text-2xs text-zinc-400 leading-relaxed max-h-24 overflow-y-auto whitespace-pre-wrap">
              {update.notes}
            </p>
          )}

          {phase === "downloading" && (
            <div className="space-y-1.5">
              <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full bg-purple-500 transition-all" style={{ width: `${percent}%` }} />
              </div>
              <div className="text-2xs text-zinc-400 font-mono">Downloading… {percent}%</div>
            </div>
          )}

          {phase === "installing" && (
            <div className="text-2xs text-zinc-400 flex items-center gap-1.5">
              <Icon icon={RefreshCw} className="w-3 h-3 animate-spin" />
              <span>Installing…</span>
            </div>
          )}

          {phase === "ready" && (
            <p className="text-2xs text-emerald-300 flex items-center gap-1.5">
              <Icon icon={Check} className="w-3 h-3" />
              <span>Installed. Restart to finish.</span>
            </p>
          )}

          {phase === "failed" && (
            <p className="text-2xs text-red-300 flex items-start gap-1.5">
              <Icon icon={AlertCircle} className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{detail || "The update could not be installed."}</span>
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {phase === "idle" && (
              <>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="px-2.5 py-1 rounded-lg text-2xs text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  Later
                </button>
                <button
                  type="button"
                  onClick={() => void startInstall()}
                  className="px-3 py-1 rounded-lg text-2xs font-medium bg-purple-600 hover:bg-purple-500 text-white transition-colors shadow-sm"
                >
                  Download &amp; install
                </button>
              </>
            )}
            {phase === "ready" && (
              <button
                type="button"
                onClick={() => void restartApp()}
                className="px-3 py-1 rounded-lg text-2xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shadow-sm"
              >
                Restart now
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
