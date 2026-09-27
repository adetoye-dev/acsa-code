/**
 * AboutPane.tsx — version, and the one privacy switch the updater adds.
 *
 * Checking for updates is a network call that tells a server your version and,
 * implicitly, that you launched. This app's whole claim is that nothing leaves
 * the machine, so that call is visible here and can be turned off, rather than
 * being something that quietly happens on every start.
 */

import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon";
import { RefreshCw, Check, AlertCircle, ArrowDownToLine } from "lucide-react";
import {
  autoCheckEnabled,
  setAutoCheck,
  checkForUpdateDetailed,
  currentVersion,
  installUpdate,
  restartApp,
  installProgress,
  UPDATE_ANNOUNCEMENT,
  type InstallProgress,
  type UpdateAnnouncement,
} from "../../services/appUpdater";

type CheckState = { kind: "idle" | "checking" | "current" | "available" | "failed"; detail?: string };
// The install state is the service's, not this pane's — see `installProgress`.
type InstallState = InstallProgress | null;

export function AboutPane() {
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState(autoCheckEnabled);
  const [state, setState] = useState<CheckState>({ kind: "idle" });
  const [found, setFound] = useState<{ version: string; pendingRestart?: boolean } | null>(null);
  // The install lives here, not only in the titlebar. Reporting "an update is
  // available — the button is in the titlebar" was a dead end from this pane: the
  // titlebar only looked on mount, so the button appeared after a restart at the
  // earliest. Finding an update is the moment the user wants to act on it.
  const [install, setInstall] = useState<InstallState>(installProgress);

  useEffect(() => {
    void currentVersion().then(setVersion);
  }, []);

  // Follows an install started anywhere — including one this pane started and
  // then outlived, because closing the modal no longer discards it.
  useEffect(() => {
    const onAnnouncement = (event: Event) => {
      const detail = (event as CustomEvent<UpdateAnnouncement>).detail;
      if (detail?.kind === "install") setInstall(detail.progress);
    };
    window.addEventListener(UPDATE_ANNOUNCEMENT, onAnnouncement);
    return () => window.removeEventListener(UPDATE_ANNOUNCEMENT, onAnnouncement);
  }, []);

  const check = async () => {
    setState({ kind: "checking" });
    const outcome = await checkForUpdateDetailed({ force: true });
    if (outcome.kind === "available") {
      setFound(outcome.update);
      setState({ kind: "available" });
      // Quitting after an install and coming back here used to offer the download
      // again, which reads as "the update failed". If the version is already on
      // disk the only remaining step is the restart.
      if (outcome.update.pendingRestart) {
        setInstall({ version: outcome.update.version, phase: "ready", percent: 100 });
      }
    } else if (outcome.kind === "current") {
      setState({ kind: "current" });
    } else {
      setState({ kind: "failed", detail: outcome.detail });
    }
  };

  const startInstall = async () => {
    try {
      // No local phase bookkeeping: `installUpdate` reports through the service,
      // which is what makes the progress survive this component unmounting.
      await installUpdate();
    } catch {
      /* the failed phase is already published, with the reason */
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">About</h3>
        <p className="text-2xs text-zinc-400 mt-0.5">Version and how updates are delivered.</p>
      </div>

      <div className="bg-surface border border-hairline rounded-panel p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-300">Version</span>
          <span className="text-xs font-mono text-zinc-200">{version || "…"}</span>
        </div>

        <div className="flex items-start gap-2.5">
          <input
            id="acsa-check-updates"
            type="checkbox"
            checked={auto}
            onChange={(event) => {
              setAuto(event.target.checked);
              setAutoCheck(event.target.checked);
            }}
            className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-purple-400 focus:ring-purple-500/40 cursor-pointer"
          />
          {/* `htmlFor` rather than nesting: the lint rule wants an explicit
              association, and it is the more reliable one for screen readers. */}
          <label htmlFor="acsa-check-updates" className="cursor-pointer">
            <span className="text-xs text-zinc-200 block">Check for updates on launch</span>
            <span className="text-2xs text-zinc-500 block mt-0.5 leading-relaxed">
              One request to the release page. It reveals your version and IP to whoever hosts it, and
              nothing else — no usage, no identifiers. An update is never installed without you asking.
            </span>
          </label>
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-hairline">
          <button
            type="button"
            onClick={() => void check()}
            disabled={state.kind === "checking"}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition disabled:opacity-60 cursor-pointer"
          >
            <Icon
              icon={RefreshCw}
              className={`w-3.5 h-3.5 ${state.kind === "checking" ? "animate-spin" : ""}`}
            />
            Check now
          </button>

          {state.kind === "current" && (
            <span className="text-2xs text-zinc-400 flex items-center gap-1.5">
              <Icon icon={Check} className="w-3 h-3 text-emerald-400" />
              You are up to date.
            </span>
          )}
          {state.kind === "available" && found && (
            <span className="text-2xs text-purple-300 flex items-center gap-1.5">
              <Icon icon={ArrowDownToLine} className="w-3 h-3" />
              {found.pendingRestart
                ? `${found.version} is installed and waiting for a restart.`
                : `${found.version} is available.`}
            </span>
          )}
          {state.kind === "failed" && (
            <span className="text-2xs text-zinc-400 flex items-center gap-1.5">
              <Icon icon={AlertCircle} className="w-3 h-3 text-amber-400" />
              {state.detail ?? "No release page is reachable yet."}
            </span>
          )}

          {state.kind === "available" && found && !install && (
            <button
              type="button"
              onClick={() => void startInstall()}
              className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition cursor-pointer"
            >
              <Icon icon={ArrowDownToLine} className="w-3.5 h-3.5" />
              Download &amp; install {found.version}
            </button>
          )}
          {install?.phase === "downloading" && (
            <span className="ml-auto flex items-center gap-2 min-w-40">
              <span className="h-1 flex-1 rounded-full bg-zinc-800 overflow-hidden">
                <span
                  className="block h-full bg-purple-500 transition-all"
                  style={{ width: `${install.percent}%` }}
                />
              </span>
              <span className="text-2xs text-zinc-400 font-mono">{install.percent}%</span>
            </span>
          )}
          {install?.phase === "installing" && (
            <span className="ml-auto text-2xs text-zinc-400 flex items-center gap-1.5">
              <Icon icon={RefreshCw} className="w-3 h-3 animate-spin" />
              Installing…
            </span>
          )}
          {install?.phase === "ready" && (
            <>
              <span className="ml-auto text-2xs text-emerald-300 flex items-center gap-1.5">
                <Icon icon={Check} className="w-3 h-3" />
                Installed.
              </span>
              <button
                type="button"
                onClick={() => void restartApp()}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition cursor-pointer"
              >
                Restart to finish
              </button>
            </>
          )}
          {install?.phase === "failed" && (
            <span className="ml-auto text-2xs text-red-300 flex items-center gap-1.5">
              <Icon icon={AlertCircle} className="w-3 h-3" />
              {install?.detail || "The update could not be installed."}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
