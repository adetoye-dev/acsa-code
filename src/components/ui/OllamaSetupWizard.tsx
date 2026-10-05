/**
 * OllamaSetupWizard.tsx — Automatic Ollama Installation & Setup Wizard
 *
 * A floating modal that guides the user through:
 *  Step 1 – Detect (silent ping, auto-advances)
 *  Step 2 – Install (clean passwordless unpack, one-line loading hash bar)
 *  Step 3 – Pull model (one-line loading hash bar, RAM-appropriate model)
 *  Step 4 – Start server
 *  Step 5 – Done (offer to set Ollama as default provider)
 *
 * Progress display:
 *  - One-line loading hash (#) bar showing left-to-right filling and exact percentage
 *  - Collapsible technical log details if the user wants to inspect them
 */

import { useState, useEffect, useRef } from "react";
import { Bot, CheckCircle2, ChevronRight, Lightbulb, Download, Loader2, ChevronDown, Play, Cpu, AlertCircle, X } from "lucide-react";
import { Icon } from "../ui/Icon";
import {
  checkOllamaStatus,
  installOllama,
  pullOllamaModel,
  startOllamaServer,
  markSetupComplete,
  openAiManagementDashboard,
  startCodingWithOllama,
  type OllamaStatus,
  type OllamaProgressEvent,
} from "../../services/ollamaSetup";
import { openExternal } from "../../services/openExternal";
import { setDefaultProvider, syncOllamaModels } from "../../services/aiModelManager";
import { HashProgressBar } from "./HashProgressBar";

type WizardStep = "detect" | "install" | "pull" | "start" | "done" | "error";

interface OllamaSetupWizardProps {
  /** Called when wizard closes */
  onClose: () => void;
  /** Called when Ollama is successfully configured and set as default */
  onComplete?: () => void;
  /** Whether to render as a full modal (true, default) */
  asModal?: boolean;
}

export function OllamaSetupWizard({ onClose, onComplete, asModal = true }: OllamaSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("detect");
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStatus, setProgressStatus] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [selectedModel, setSelectedModel] = useState("qwen2.5-coder:3b");
  const [pulledModel, setPulledModel] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Auto-detect on mount
  useEffect(() => {
    void runDetect();
  }, []);

  const addLog = (line?: string) => {
    if (!line) return;
    // Control characters are the point: this strips ANSI colour codes.
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
    if (!clean) return;
    setLogs((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === clean) return prev;
      const next = [...prev, clean];
      return next.length > 150 ? next.slice(next.length - 150) : next;
    });
  };

  async function runDetect() {
    setStep("detect");
    setLogs([]);
    setProgressPercent(0);
    setProgressStatus("Inspecting local machine…");
    const s = await checkOllamaStatus();
    setStatus(s);
    setSelectedModel(s.recommendedModel || "qwen2.5-coder:3b");

    if (s.running) {
      if (s.models.length > 0) {
        markSetupComplete();
        setStep("done");
      } else {
        setStep("pull");
      }
    } else if (s.installed) {
      // Installed on disk! Skip install entirely, advance to start
      setStep("start");
    } else {
      setStep("install");
    }
  }

  async function runInstall() {
    // Downloading Ollama is this app's job, not the user's. The engine fetches
    // Ollama's own published release and unpacks it into the app's data folder —
    // no administrator password, nothing written outside our own directory.
    setLogs([]);
    setErrorMsg("");
    setIsBusy(true);
    setProgressPercent(0);
    setProgressStatus("Starting the Ollama download…");
    try {
      await installOllama((evt: OllamaProgressEvent) => {
        setProgressPercent(evt.percent);
        setProgressStatus(evt.status);
        if (evt.log) addLog(evt.log);
      });
      addLog("✓ Ollama is installed.");
      // Installed now — re-detect, which advances to starting the server.
      await runDetect();
    } catch (err: any) {
      setErrorMsg(err.message || "Setup failed.");
      setStep("error");
    } finally {
      setIsBusy(false);
    }
  }

  async function runPull() {
    setIsBusy(true);
    setLogs([]);
    setProgressPercent(0);
    setProgressStatus(`Connecting to registry for ${selectedModel}…`);
    try {
      const model = await pullOllamaModel(selectedModel, (evt: OllamaProgressEvent) => {
        setProgressPercent(evt.percent);
        setProgressStatus(evt.status);
        if (evt.log) addLog(evt.log);
      });
      setPulledModel(model);
      markSetupComplete();
      const s = await checkOllamaStatus();
      syncOllamaModels(s.models.length > 0 ? s.models : [model], model, s.modelsDetails);
      setDefaultProvider("ollama");
      setStep("done");
    } catch (err: any) {
      setErrorMsg(err.message || "Model download failed.");
      setStep("error");
    } finally {
      setIsBusy(false);
    }
  }

  async function runStart() {
    setIsBusy(true);
    setProgressPercent(20);
    setProgressStatus("Starting Ollama background server…");
    addLog("Spawning Ollama server process…");
    try {
      const ok = await startOllamaServer();
      if (ok) {
        setProgressPercent(100);
        setProgressStatus("✓ Ollama server reachable at http://127.0.0.1:11434");
        addLog("✓ Ollama server is running.");
        const s = await checkOllamaStatus();
        setStatus(s);
        if (s.models.length > 0) {
          syncOllamaModels(s.models, undefined, s.modelsDetails);
          setDefaultProvider("ollama");
          markSetupComplete();
          setStep("done");
        } else {
          setStep("pull");
        }
      } else {
        setErrorMsg("Server did not report ready in time. Try running `ollama serve` in a terminal.");
        setStep("error");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Could not start server.");
      setStep("error");
    } finally {
      setIsBusy(false);
    }
  }

  function handleSetDefault() {
    const modelToSet = pulledModel || selectedModel || (status?.models?.[0]) || "qwen2.5-coder:7b";
    try {
      const models = status?.models && status.models.length > 0 ? status.models : [modelToSet];
      syncOllamaModels(models, modelToSet, status?.modelsDetails);
      setDefaultProvider("ollama");
      markSetupComplete();
    } catch (err) {
      console.error("Error setting default Ollama provider:", err);
    }
    try {
      onComplete?.();
    } catch {}
    try {
      onClose();
    } catch {}
    startCodingWithOllama(modelToSet);
  }

  function handleSkip() {
    if (status?.models && status.models.length > 0) {
      syncOllamaModels(status.models, undefined, status.modelsDetails);
      setDefaultProvider("ollama");
    }
    markSetupComplete();
    onClose();
  }

  /* ── Step Progress Indicator ─────────────────────────────────────────── */
  const steps: { id: WizardStep; label: string }[] = [
    { id: "detect", label: "Detect" },
    { id: "install", label: "Install" },
    { id: "start", label: "Start" },
    { id: "pull", label: "Pull Model" },
    { id: "done", label: "Done" },
  ];
  const stepOrder: WizardStep[] = ["detect", "install", "start", "pull", "done"];
  const currentIdx = stepOrder.indexOf(step);

  /* ── Render Body Content ────────────────────────────────────────────── */
  function renderBody() {
    if (step === "detect") {
      return (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <Icon icon={Loader2} className="w-9 h-9 text-purple-400 animate-spin" />
          <div>
            <p className="text-xs font-semibold text-zinc-200">Detecting local Ollama installation…</p>
            <p className="text-2xs text-zinc-500 mt-1">Inspecting PATH and application directories</p>
          </div>
        </div>
      );
    }

    if (step === "install") {
      return (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3.5 rounded-xl bg-amber-950/30 border border-amber-500/25">
            <Icon icon={Lightbulb} className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-200/90 leading-relaxed">
              <span className="font-semibold text-white">Ollama is not yet installed.</span>
              <p className="mt-0.5 text-zinc-300">
                ACSA Code will download Ollama and set it up for you — about 190 MB, no password
                prompt, and nothing written outside the app&apos;s own folder. Then it starts the
                server and downloads a model for you.
              </p>
              {status && status.totalRamGb > 0 && (
                <div className="mt-1 text-2xs text-amber-300/80 font-mono">
                  Hardware: {status.totalRamGb} GB RAM · recommended model: {status.recommendedModel}
                </div>
              )}
            </div>
          </div>

          {/* One-line loading hash bar */}
          {isBusy && (
            <HashProgressBar
              percent={progressPercent}
              statusText={progressStatus || "Downloading Ollama…"}
            />
          )}

          {/* Technical log disclosure */}
          {logs.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowLogs((prev) => !prev)}
                className="flex items-center gap-1.5 text-3xs text-zinc-500 hover:text-zinc-300 transition-colors font-mono"
              >
                <Icon icon={ChevronDown} className={`w-3 h-3 transition-transform ${showLogs ? "" : "-rotate-90"}`} />
                <span>{showLogs ? "Hide details" : `Show details (${logs.length} events)`}</span>
              </button>
              {showLogs && <LogBox logs={logs} logsEndRef={logsEndRef} />}
            </div>
          )}

          {!isBusy && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={runInstall}
                className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition-colors shadow-sm"
              >
                <Icon icon={Download} className="w-3.5 h-3.5" />
                Install Ollama
              </button>
              <button
                type="button"
                onClick={() => void openExternal("https://ollama.com/download")}
                className="w-full text-2xs text-zinc-400 hover:text-zinc-200 py-1.5 transition-colors text-center"
              >
                Already have it, or prefer to install it yourself? Open the download page
              </button>
            </div>
          )}
        </div>
      );
    }

    if (step === "start") {
      return (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3.5 rounded-xl bg-purple-950/30 border border-purple-500/25">
            <Icon icon={CheckCircle2} className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-xs text-purple-200/90 leading-relaxed">
              <span className="font-semibold text-white">Ollama is installed on this device.</span>
              <p className="mt-0.5 text-zinc-300">
                The local daemon service is not currently running. Click below to launch the background server.
              </p>
            </div>
          </div>

          {isBusy && (
            <HashProgressBar
              percent={progressPercent}
              statusText={progressStatus || "Starting server…"}
            />
          )}

          {logs.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowLogs((prev) => !prev)}
                className="flex items-center gap-1.5 text-3xs text-zinc-500 hover:text-zinc-300 transition-colors font-mono"
              >
                <Icon icon={ChevronDown} className={`w-3 h-3 transition-transform ${showLogs ? "" : "-rotate-90"}`} />
                <span>{showLogs ? "Hide details" : `Show details (${logs.length} events)`}</span>
              </button>
              {showLogs && <LogBox logs={logs} logsEndRef={logsEndRef} />}
            </div>
          )}

          {!isBusy && (
            <button
              type="button"
              onClick={runStart}
              className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition-colors shadow-sm"
            >
              <Icon icon={Play} className="w-3.5 h-3.5" />
              Start Ollama Server
            </button>
          )}
        </div>
      );
    }

    if (step === "pull") {
      const modelOptions =
        status?.totalRamGb && status.totalRamGb >= 16
          ? ["qwen2.5-coder:7b", "qwen2.5-coder:3b", "qwen2.5-coder:1.5b", "codellama", "llama3.2"]
          : status?.totalRamGb && status.totalRamGb >= 8
          ? ["qwen2.5-coder:3b", "qwen2.5-coder:1.5b", "llama3.2"]
          : ["qwen2.5-coder:1.5b", "llama3.2"];

      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="ollamasetupwizard-select-local-model-to-download-1" className="text-xs font-semibold text-zinc-300">
              Model to download
            </label>
            <select id="ollamasetupwizard-select-local-model-to-download-1"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isBusy}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-mono focus:outline-none focus:border-purple-500 cursor-pointer disabled:opacity-50"
            >
              {modelOptions.map((m) => (
                <option key={m} value={m} className="bg-zinc-900">
                  {m}
                </option>
              ))}
            </select>
            {/* The choice is already made. Saying "Select a model" next to a
                dropdown that arrives filled in reads as a step the user has to
                work out, when the only real decision is whether to change it. */}
            <p className="text-2xs text-zinc-400 leading-relaxed">
              {status && status.totalRamGb > 0 ? (
                <>
                  ACSA Code picked{" "}
                  <span className="text-purple-400 font-mono font-semibold">{status.recommendedModel}</span>{" "}
                  for this machine — it fits{" "}
                  <span className="text-zinc-200 font-mono font-medium">{status.totalRamGb} GB</span> of RAM.
                </>
              ) : (
                <>ACSA Code picked a model for this machine.</>
              )}
              {!isBusy && " Pick a different one if you'd rather."}
            </p>
          </div>

          {/* One-line loading hash bar during model pull */}
          {isBusy && (
            <HashProgressBar
              percent={progressPercent}
              statusText={progressStatus || `Downloading ${selectedModel}…`}
            />
          )}

          {/* Technical log disclosure */}
          {logs.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowLogs((prev) => !prev)}
                className="flex items-center gap-1.5 text-3xs text-zinc-500 hover:text-zinc-300 transition-colors font-mono"
              >
                <Icon icon={ChevronDown} className={`w-3 h-3 transition-transform ${showLogs ? "" : "-rotate-90"}`} />
                <span>{showLogs ? "Hide details" : `Show details (${logs.length} events)`}</span>
              </button>
              {showLogs && <LogBox logs={logs} logsEndRef={logsEndRef} />}
            </div>
          )}

          {!isBusy && (
            <button
              type="button"
              onClick={runPull}
              className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white transition-colors shadow-sm"
            >
              <Icon icon={Download} className="w-3.5 h-3.5" />
              Pull {selectedModel}
            </button>
          )}
        </div>
      );
    }

    if (step === "done") {
      return (
        <div className="space-y-5">
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Icon icon={CheckCircle2} className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Ollama is Ready!</h3>
              <p className="text-xs text-zinc-400 mt-1">
                {pulledModel
                  ? `Model "${pulledModel}" is active and configured as your default AI engine.`
                  : "Ollama server is active and verified as your default AI engine."}
              </p>
              {status && status.models && status.models.length > 0 && (
                <p className="text-2xs text-zinc-500 mt-1 font-mono truncate max-w-xs mx-auto">
                  Available: {status.models.join(", ")}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={handleSetDefault}
              className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-xs font-bold text-zinc-950 transition-colors shadow-sm cursor-pointer"
            >
              <Icon icon={Bot} className="w-3.5 h-3.5 fill-zinc-950 text-zinc-950" />
              Start Coding with Ollama
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                openAiManagementDashboard();
              }}
              className="flex items-center gap-2 w-full justify-center px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 border border-zinc-700/60 transition-colors cursor-pointer"
            >
              <Icon icon={Download} className="w-3.5 h-3.5 text-purple-400" />
              Download More Models (AI Manager)
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="text-xs text-zinc-500 hover:text-zinc-300 py-1.5 transition-colors text-center cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      );
    }

    if (step === "error") {
      return (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3.5 rounded-xl bg-red-950/30 border border-red-500/30">
            <Icon icon={AlertCircle} className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="text-xs text-red-200/90 leading-relaxed">
              <span className="font-semibold text-white">Setup Interrupted</span>
              <p className="mt-1 font-mono text-2xs text-red-300/80 break-words">{errorMsg}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => runDetect()}
              className="flex-1 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 transition-colors"
            >
              Retry Detection
            </button>
            <button
              type="button"
              onClick={handleSkip}
              className="flex-1 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  /* ── Modal Layout ────────────────────────────────────────────────────── */
  const inner = (
    <div className="w-full max-w-md bg-workbench border border-zinc-800/90 rounded-2xl shadow-2xl overflow-hidden font-sans">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <Icon icon={Cpu} className="w-4 h-4 text-purple-400" />
          </div>
          <div>
            <h2 className="text-xs font-bold text-white tracking-tight">Local AI Engine Setup</h2>
            <p className="text-3xs text-zinc-500">Runs on this machine</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleSkip}
          className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded-lg hover:bg-zinc-800"
          title="Dismiss"
        >
          <Icon icon={X} className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Step Indicators */}
      <div className="flex items-center gap-0 px-5 py-2.5 border-b border-zinc-800/60 bg-zinc-950/40">
        {steps.map((s, idx) => {
          const stepIdx = stepOrder.indexOf(s.id);
          const done = stepIdx < currentIdx;
          const active = s.id === step;
          return (
            <div key={s.id} className="flex items-center">
              <div
                className={`flex items-center gap-1 text-3xs font-semibold px-2 py-0.5 rounded-md transition-colors ${
                  done
                    ? "text-emerald-400"
                    : active
                    ? "text-white bg-zinc-800"
                    : "text-zinc-500"
                }`}
              >
                {done && <Icon icon={CheckCircle2} className="w-2.5 h-2.5" />}
                <span>{s.label}</span>
              </div>
              {idx < steps.length - 1 && (
                <Icon icon={ChevronRight} className="w-3 h-3 text-zinc-800 mx-0.5 shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Main Content Area */}
      <div className="p-5">{renderBody()}</div>
    </div>
  );

  if (!asModal) return inner;

  return (
    <div className="fixed inset-0 z-critical flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      {inner}
    </div>
  );
}

/* ── Expandable Log Box (collapsed by default) ─────────────────────────── */
function LogBox({
  logs,
  logsEndRef,
}: {
  logs: string[];
  logsEndRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="h-28 overflow-y-auto rounded-xl bg-zinc-950 border border-zinc-800/80 p-2.5 font-mono text-3xs text-zinc-400 space-y-0.5">
      {logs.map((l, i) => (
        <div key={i} className={`truncate ${l.startsWith("✓") ? "text-emerald-400" : ""}`}>
          {l}
        </div>
      ))}
      <div ref={logsEndRef} />
    </div>
  );
}

/* ── Non-Intrusive Repeat-Launch Banner ─────────────────────────────────── */
interface OllamaBannerProps {
  onOpenSetup: () => void;
  onDismiss: () => void;
}

export function OllamaNotRunningBanner({ onOpenSetup, onDismiss }: OllamaBannerProps) {
  return (
    <div className="fixed bottom-6 right-6 z-toast flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-workbench border border-amber-500/40 shadow-xl max-w-xs font-sans">
      <Icon icon={AlertCircle} className="w-4 h-4 text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white truncate">No AI model is configured</p>
        <p className="text-3xs text-zinc-400 mt-0.5">Add a provider key, or start the local engine</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onOpenSetup}
          className="text-3xs font-bold text-purple-400 hover:text-purple-300 px-2 py-1 rounded-lg hover:bg-zinc-800 transition-colors"
        >
          Set up
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-zinc-500 hover:text-zinc-400 transition-colors p-1"
          title="Dismiss"
        >
          <Icon icon={X} className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

export default OllamaSetupWizard;
