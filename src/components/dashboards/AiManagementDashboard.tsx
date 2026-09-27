/**
 * AiManagementDashboard.tsx — Executive Multi-Model AI Management & Provider Configuration
 *
 * Modern AI Control Plane:
 * 1. Fixed-width left navigation grouped into "Local & Offline Engines" and "Cloud LLM APIs".
 * 2. Authentic brand logos with connection state and default model badges.
 * 3. Configuration stage with model selector, API key management, endpoint settings,
 *    live connection ping test with latency metrics, and prominent default model switcher.
 * 4. Multi-provider persistence in localStorage.
 */

import { useState, useEffect } from "react";
import { Trash2, Globe, Star, CheckCircle2, RefreshCw, Eye, Download, Loader2, Zap, Play, Cpu, AlertCircle, ShieldCheck, ChevronDown } from "lucide-react";
import { Icon } from "../ui/Icon";
import { openExternal } from "../../services/openExternal";
import { ProviderLogo } from "../ui/BrandLogos";
import { OllamaSetupWizard } from "../ui/OllamaSetupWizard";
import { HashProgressBar } from "../ui/HashProgressBar";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { AIProviderConfig, AIProviderId } from "../../types/workbench";
import {
  loadAllProviders,
  saveProviderConfig,
  setDefaultProvider,
  syncOllamaModels,
  addCustomModelToProvider,
  curateProviderModels,
  saveActiveSelectedModel,
  setProviderApiKey,
} from "../../services/aiModelManager";
import {
  checkOllamaStatus,
  startOllamaServer,
  pullOllamaModel,
  deleteOllamaModel,
  CURATED_OLLAMA_MODELS,
  resolveModelMetadata,
  type OllamaStatus,
  type OllamaProgressEvent,
} from "../../services/ollamaSetup";
import { aiFetch } from "../../services/aiClient";
import { explainProviderFailure } from "../../services/providerErrors";

interface AiManagementDashboardProps {
  onModelSettingsChanged?: () => void;
}

export function AiManagementDashboard({
  onModelSettingsChanged,
}: AiManagementDashboardProps) {
  const [providers, setProviders] = useState<Record<AIProviderId, AIProviderConfig>>(loadAllProviders());
  const [selectedId, setSelectedId] = useState<AIProviderId>("ollama");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; message?: string } | null>(null);
  // Which store took the last credential, and why it was not the keychain. Without
  // this the fallback is silent, and a build with no working keychain looks exactly
  // like one whose keys are encrypted by the OS.
  const [keyStorage, setKeyStorage] = useState<{ stored: "keychain" | "file"; reason?: string } | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [isStartingOllama, setIsStartingOllama] = useState(false);
  const [showOllamaWizard, setShowOllamaWizard] = useState(false);
  const [openSpecsModelTag, setOpenSpecsModelTag] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Model pulling & downloader state
  const [pullingModelTag, setPullingModelTag] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState(0);
  const [pullStatusText, setPullStatusText] = useState("");
  const [pullSuccessMsg, setPullSuccessMsg] = useState<string | null>(null);
  const [pullErrorMsg, setPullErrorMsg] = useState<string | null>(null);
  const [customModelTag, setCustomModelTag] = useState("");
  const [customCloudModel, setCustomCloudModel] = useState("");
  const [isDeletingModel, setIsDeletingModel] = useState<string | null>(null);

  const activeProvider = providers[selectedId] || providers.ollama;

  // The registry's `isConnected` for the local provider is a static default: only
  // cloud providers have it recomputed from a stored key. Trusting it here made
  // the header claim "Connected & Verified" directly above a panel reading "Not
  // installed". Derive the local provider's state from the live probe instead.
  const activeConnected =
    activeProvider.id === "ollama" ? ollamaStatus?.running === true : activeProvider.isConnected;

  // Sync inputs when selected provider changes
  useEffect(() => {
    if (activeProvider) {
      setApiKeyInput(activeProvider.apiKey || "");
      setBaseUrlInput(activeProvider.baseUrl || "");
      setSelectedModel(activeProvider.selectedModel || activeProvider.availableModels[0] || "");
      setTestResult(null);
      setShowApiKey(false);
    }
    // When switching to Ollama, check its live status
    if (selectedId === "ollama") {
      setOllamaStatus(null);
      checkOllamaStatus().then((s) => {
        setOllamaStatus(s);
        if (s.running && s.models.length > 0) {
          const updated = syncOllamaModels(s.models);
          setProviders(updated);
          if (updated.ollama) {
            setSelectedModel(updated.ollama.selectedModel);
          }
        }
      }).catch(() => {});
    }
    // Keyed on which provider is selected. Depending on `activeProvider` would
    // re-enter: the Ollama branch calls `setProviders`, which produces a new
    // provider object, which would run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const handleStartOllama = async () => {
    setIsStartingOllama(true);
    const ok = await startOllamaServer();
    if (ok) {
      // Re-check to refresh model list
      const s = await checkOllamaStatus();
      setOllamaStatus(s);
      if (s.models.length > 0) {
        const updatedProviders = syncOllamaModels(s.models);
        setProviders(updatedProviders);
      } else {
        const updated: AIProviderConfig = { ...activeProvider, isConnected: true };
        const newMap = saveProviderConfig(updated);
        setProviders(newMap);
      }
    }
    setIsStartingOllama(false);
  };

  const handlePullModel = async (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || pullingModelTag) return;

    setPullingModelTag(trimmed);
    setPullPercent(0);
    setPullStatusText(`Connecting to Ollama service for ${trimmed}…`);
    setPullSuccessMsg(null);
    setPullErrorMsg(null);

    try {
      const model = await pullOllamaModel(trimmed, (evt: OllamaProgressEvent) => {
        setPullPercent(evt.percent);
        setPullStatusText(evt.status);
      });

      const s = await checkOllamaStatus();
      setOllamaStatus(s);
      const updated = syncOllamaModels(s.models.length > 0 ? s.models : [model], model);
      setProviders(updated);
      setSelectedModel(model);
      onModelSettingsChanged?.();

      setPullSuccessMsg(`Successfully pulled and activated ${model}`);
      setTimeout(() => setPullSuccessMsg(null), 6000);
    } catch (err: any) {
      setPullErrorMsg(err.message || "Model pull failed.");
    } finally {
      setPullingModelTag(null);
    }
  };

  const handleSwitchModel = (tag: string) => {
    setSelectedModel(tag);
    handleSaveProvider(tag, baseUrlInput);
    if (ollamaStatus?.models) {
      const updated = syncOllamaModels(ollamaStatus.models, tag);
      setProviders(updated);
    }
  };

  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string | null>(null);

  const handleDeleteModel = async (tag: string) => {
    if (isDeletingModel) return;
    setIsDeletingModel(tag);
    try {
      const ok = await deleteOllamaModel(tag);
      if (ok) {
        const s = await checkOllamaStatus();
        setOllamaStatus(s);
        const updated = syncOllamaModels(s.models);
        setProviders(updated);
        if (selectedModel === tag && s.models.length > 0) {
          setSelectedModel(s.models[0]);
          handleSaveProvider(s.models[0], baseUrlInput);
        }
        onModelSettingsChanged?.();
      }
    } finally {
      setIsDeletingModel(null);
      setConfirmDeleteTag(null);
    }
  };

  const handleSaveProvider = async (modelValue = selectedModel, baseUrlValue = baseUrlInput) => {
    let isConnected = false;
    if (activeProvider.id === "ollama") {
      isConnected = ollamaStatus?.running ?? activeProvider.isConnected;
    } else if (activeProvider.category === "cloud") {
      isConnected = !!(apiKeyInput && apiKeyInput.trim().length > 3);
    }

    const key = apiKeyInput.trim();
    const updated: AIProviderConfig = {
      ...activeProvider,
      // Deliberately empty: the credential is written below, awaited, so the
      // destination is known. Passing it here would be a second, unobserved write —
      // `saveProviderConfig` fires that one off with `void … .catch(() => {})`.
      apiKey: "",
      baseUrl: baseUrlValue.trim(),
      selectedModel: modelValue,
      isConnected,
    };

    const newMap = saveProviderConfig(updated);
    if (modelValue && activeProvider.category === "cloud") {
      saveActiveSelectedModel(activeProvider.id, modelValue);
    }
    setProviders(newMap);
    onModelSettingsChanged?.();

    if (activeProvider.category === "cloud" && key) {
      try {
        const result = await setProviderApiKey(activeProvider.id, key);
        setKeyStorage(
          result?.stored === "file"
            ? { stored: "file", reason: result.reason }
            : { stored: "keychain" },
        );
      } catch (error) {
        setKeyStorage({ stored: "file", reason: String((error as Error)?.message || error) });
      }
    }
  };

  const handleSetDefault = () => {
    handleSaveProvider();
    const newMap = setDefaultProvider(selectedId);
    const targetModel = selectedModel || activeProvider.selectedModel;
    if (targetModel && activeProvider.category === "cloud") {
      saveActiveSelectedModel(selectedId, targetModel);
    }
    setProviders(newMap);
    onModelSettingsChanged?.();
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const res = await aiFetch("/api/ai/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: activeProvider.id,
          baseUrl: baseUrlInput || activeProvider.baseUrl,
          apiKey: apiKeyInput || activeProvider.apiKey,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        // The engine reports a failure in `error`; this used to store the payload
        // whole and then render only `.message`, which is absent on every failure —
        // so a rejected key, an account with no credit and a dead network all read
        // "Connection failed. Please check endpoint or API key." `explainProviderFailure`
        // turns the reason into the fix, and falls back to the provider's own words.
        const reason =
          explainProviderFailure(String(data?.error ?? "")) ?? String(data?.error ?? data?.message ?? "");
        setTestResult({ ok: Boolean(data?.success ?? data?.ok), latencyMs: data?.latencyMs, message: reason });
        const success = Boolean(data?.success ?? data?.ok);
        const rawList = data.models && data.models.length > 0 ? data.models : activeProvider.availableModels;
        const newModels: string[] = curateProviderModels(activeProvider.id, rawList);
        const currentModel = selectedModel || activeProvider.selectedModel;
        const resolvedModel = (currentModel && newModels.includes(currentModel))
          ? currentModel
          : (newModels[0] || activeProvider.selectedModel);

        const updated: AIProviderConfig = {
          ...activeProvider,
          apiKey: apiKeyInput.trim() || activeProvider.apiKey,
          baseUrl: (baseUrlInput || activeProvider.baseUrl || "").trim(),
          isConnected: success,
          latencyMs: data.latencyMs,
          availableModels: newModels,
          selectedModel: resolvedModel,
        };
        const newMap = saveProviderConfig(updated);
        if (resolvedModel && activeProvider.category === "cloud") {
          saveActiveSelectedModel(activeProvider.id, resolvedModel);
        }
        setProviders(newMap);
        setSelectedModel(resolvedModel);
      } else {
        setTestResult({ ok: false, message: `Server returned HTTP ${res.status}` });
        const updated: AIProviderConfig = {
          ...activeProvider,
          apiKey: apiKeyInput.trim() || activeProvider.apiKey,
          isConnected: false,
        };
        const newMap = saveProviderConfig(updated);
        setProviders(newMap);
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: `Ping failed: ${err.message}` });
      const updated: AIProviderConfig = {
        ...activeProvider,
        apiKey: apiKeyInput.trim() || activeProvider.apiKey,
        isConnected: false,
      };
      const newMap = saveProviderConfig(updated);
      setProviders(newMap);
    } finally {
      setIsTesting(false);
    }
  };

  const handleAddCustomModel = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = customCloudModel.trim();
    if (!trimmed) return;
    const updated = addCustomModelToProvider(activeProvider.id, trimmed);
    setProviders(updated);
    setSelectedModel(trimmed);
    saveActiveSelectedModel(activeProvider.id, trimmed);
    setCustomCloudModel("");
    onModelSettingsChanged?.();
  };

  const localProviders = Object.values(providers).filter(
    (p) => p.category === "local" && (p.id as string) !== "deterministic"
  );
  const cloudProviders = Object.values(providers).filter((p) => p.category === "cloud");
  const defaultProvider = Object.values(providers).find((p) => p.isDefault) || providers.ollama;


  return (
    <>
    <div className="h-full w-full bg-workbench text-zinc-200 p-4 md:p-6 font-sans select-none overflow-hidden flex flex-col">
      <div className="w-full max-w-[clamp(48rem,88vw,96rem)] mx-auto h-full flex flex-col min-h-0 space-y-4">
        {/* ── Top Header Toolbar ────────────────────────────────────────── */}
        <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-zinc-800/80">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                <Icon icon={Cpu} className="w-4 h-4 text-purple-400" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-white">AI Models & Providers</h1>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Configure local and cloud AI inference engines. Designate your global default model or switch on the fly.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-zinc-400 px-3 py-1 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center gap-2">
              <span className="text-zinc-500">Default:</span>
              <span className="font-semibold text-white">{defaultProvider.name}</span>
              <Icon icon={Star} className="w-3 h-3 fill-amber-400 text-amber-400" />
            </span>
          </div>
        </div>

        {/* ── Main Two-Column Workbench Container ────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row rounded-2xl bg-workbench border border-zinc-800/80 overflow-hidden shadow-xl">
          {/* Left Column: Independently scrollable, compact fixed-width providers sidebar */}
          <div className="w-full md:w-64 lg:w-72 shrink-0 h-full overflow-y-auto border-b md:border-b-0 md:border-r border-zinc-800/80 p-3 space-y-4 bg-workbench/60">
            {/* Group 1: Local Engines */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 px-2.5 py-1 text-2xs font-bold text-zinc-400 uppercase tracking-wider">
                <Icon icon={Zap} className="w-3 h-3 text-emerald-400" />
                <span>Local Engines (Offline)</span>
              </div>
              <div className="space-y-1">
                {localProviders.map((p) => {
                  const isSelected = p.id === selectedId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-all ${
                        isSelected
                          ? "bg-zinc-800/90 text-white font-medium border border-zinc-700/60 shadow-sm"
                          : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-6 h-6 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                          <ProviderLogo providerId={p.id} className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold">{p.name}</div>
                          <div className="truncate text-3xs text-zinc-500 font-mono">
                            {p.selectedModel || (p.isConnected ? "Active" : "Offline")}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 pl-1">
                        {p.isDefault && (
                          <Icon icon={Star} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                        )}
                        <span
                          className={`w-2 h-2 rounded-full ${
                            p.isConnected
                              ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                              : "bg-zinc-700"
                          }`}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Group 2: Cloud LLMs */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 px-2.5 py-1 text-2xs font-bold text-zinc-400 uppercase tracking-wider">
                <Icon icon={Globe} className="w-3 h-3 text-purple-400" />
                <span>Cloud LLM APIs</span>
              </div>
              <div className="space-y-1">
                {cloudProviders.map((p) => {
                  const isSelected = p.id === selectedId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-all ${
                        isSelected
                          ? "bg-zinc-800/90 text-white font-medium border border-zinc-700/60 shadow-sm"
                          : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-6 h-6 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                          <ProviderLogo providerId={p.id} className="w-3.5 h-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold">{p.name}</div>
                          <div className="truncate text-3xs text-zinc-500 font-mono">{p.selectedModel}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 pl-1">
                        {p.isDefault && (
                          <Icon icon={Star} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                        )}
                        <span
                          className={`w-2 h-2 rounded-full ${
                            p.isConnected ? "bg-emerald-400" : "bg-zinc-700"
                          }`}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Column: Independently scrollable provider configuration & models pane */}
          <div className="flex-1 h-full min-h-0 overflow-y-auto p-5 md:p-6 space-y-6 flex flex-col justify-between">
            <div className="space-y-6">
              {/* Provider Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-zinc-800/80">
                <div className="flex items-center gap-3.5">
                  <div className="w-11 h-11 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
                    <ProviderLogo providerId={activeProvider.id} className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-lg font-bold text-white tracking-tight">{activeProvider.name}</h2>
                      <span className="px-2 py-0.5 rounded-full text-3xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700/60">
                        {activeProvider.category === "local" ? "Local Engine" : "Cloud LLM"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          activeConnected ? "bg-emerald-400" : "bg-zinc-600"
                        }`}
                      />
                      <span className="text-2xs font-mono text-zinc-400 font-medium">
                        {activeConnected
                          ? "Connected & Verified"
                          : activeProvider.category === "local"
                          ? "Offline / Not Running"
                          : "Not Configured"}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleSetDefault}
                  disabled={!activeProvider.isConnected && activeProvider.id !== "ollama"}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-xs transition-all shadow-sm ${
                    activeProvider.isDefault
                      ? "bg-amber-400 text-zinc-950 shadow-amber-400/20"
                      : !activeProvider.isConnected && activeProvider.id !== "ollama"
                      ? "bg-zinc-800/40 text-zinc-500 border border-zinc-800/60 cursor-not-allowed"
                      : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700/60"
                  }`}
                  title={!activeProvider.isConnected && activeProvider.id !== "ollama" ? "Connect or verify provider before setting as default" : ""}
                >
                  <Icon icon={Star} className={`w-3.5 h-3.5 ${activeProvider.isDefault ? "fill-zinc-950 text-zinc-950" : ""}`} />
                  <span>{activeProvider.isDefault ? "Current Default" : "Set as Default"}</span>
                </button>
              </div>

              {/* ── Ollama Control Plane (when Ollama tab is active) ─── */}
              {selectedId === "ollama" ? (
                <div className="space-y-5">
                  {/* 1. Server Status & Hardware Specs Header */}
                  <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zinc-200">Ollama Daemon Service</span>
                        {ollamaStatus?.running && (
                          <span className="px-2 py-0.5 rounded-full text-3xs font-mono font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-500/30">
                            Port 11434 · Ready
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {ollamaStatus === null ? (
                          <Icon icon={Loader2} className="w-3.5 h-3.5 text-zinc-500 animate-spin" />
                        ) : (
                          <span
                            title={ollamaStatus.error || undefined}
                            className={`flex items-center gap-1.5 text-xs font-mono font-semibold ${
                              ollamaStatus.running
                                ? "text-emerald-400"
                                : ollamaStatus.error || ollamaStatus.installed
                                  ? "text-amber-400"
                                  : "text-red-400"
                            }`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                ollamaStatus.running
                                  ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                                  : ollamaStatus.error || ollamaStatus.installed
                                    ? "bg-amber-400"
                                    : "bg-red-400"
                              }`}
                            />
                            {ollamaStatus.running
                              ? "Running"
                              : ollamaStatus.error
                                ? "Detection unavailable"
                                : ollamaStatus.installed
                                  ? "Stopped"
                                  : "Not installed"}
                          </span>
                        )}
                      </div>
                    </div>

                    {ollamaStatus?.totalRamGb ? (
                      <div className="text-2xs text-zinc-400 flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-800/60 font-mono">
                        <span>Hardware: <strong className="text-zinc-200 font-semibold">{ollamaStatus.totalRamGb} GB RAM</strong></span>
                        <span>Recommended Default: <strong className="text-purple-300 font-semibold">{ollamaStatus.recommendedModel}</strong></span>
                      </div>
                    ) : null}

                    {/* Action buttons if not running or need wizard */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {!ollamaStatus?.running && ollamaStatus?.installed && (
                        <button
                          type="button"
                          disabled={isStartingOllama}
                          onClick={handleStartOllama}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-950/40 hover:bg-purple-900/40 border border-purple-500/40 text-xs font-semibold text-purple-200 transition-colors disabled:opacity-50"
                        >
                          {isStartingOllama ? <Icon icon={Loader2} className="w-3.5 h-3.5 animate-spin" /> : <Icon icon={Play} className="w-3.5 h-3.5" />}
                          <span>{isStartingOllama ? "Starting Daemon…" : "Start Ollama Server"}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setShowOllamaWizard(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700/60 text-xs font-semibold transition-colors"
                      >
                        <Icon icon={RefreshCw} className="w-3.5 h-3.5 text-zinc-400" />
                        <span>Run Setup Wizard</span>
                      </button>
                    </div>
                  </div>

                  {/* 2. Installed Local Models Panel */}
                  <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon icon={Cpu} className="w-4 h-4 text-purple-400" />
                        <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                          Installed Local Models ({ollamaStatus?.models.length || 0})
                        </h3>
                      </div>
                      <span className="text-2xs text-zinc-500 font-mono">100% offline on this machine</span>
                    </div>

                    {ollamaStatus && ollamaStatus.models.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                        {ollamaStatus.models.map((m, index) => {
                          const isActive =
                            selectedModel === m ||
                            selectedModel === `${m}:latest` ||
                            m === `${selectedModel}:latest` ||
                            selectedModel.startsWith(`${m}:`);
                          const isDeleting = isDeletingModel === m;
                          const detail = ollamaStatus.modelsDetails?.find(
                            (d) =>
                              d.tag === m ||
                              d.name === m ||
                              `${d.tag}:latest` === m ||
                              d.tag === `${m}:latest` ||
                              d.tag.startsWith(`${m}:`) ||
                              m.startsWith(`${d.tag}:`)
                          );
                          const meta = resolveModelMetadata(m, detail);

                          return (
                            <div
                              key={m}
                              className={`p-3.5 rounded-xl border transition-all flex flex-col justify-between gap-3 relative ${
                                isActive
                                  ? "bg-purple-950/20 border-purple-500/50 shadow-sm"
                                  : "bg-zinc-900/80 border-zinc-800 hover:border-zinc-700"
                              }`}
                            >
                              {/* Top Row: Name, Active Badge & Delete Button */}
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold text-zinc-100 truncate">
                                      {meta.name}
                                    </span>
                                    {isActive && (
                                      <span className="px-1.5 py-0.5 rounded text-4xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase tracking-wider shrink-0">
                                        Active
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-2xs text-zinc-400 font-mono truncate mt-0.5" title={m}>
                                    {m}
                                  </p>
                                </div>

                                {ollamaStatus.models.length > 1 && (
                                  <button
                                    type="button"
                                    disabled={isDeleting}
                                    onClick={() => setConfirmDeleteTag(m)}
                                    className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors shrink-0"
                                    title={`Delete ${m} from disk`}
                                  >
                                    {isDeleting ? (
                                      <Icon icon={Loader2} className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <Icon icon={Trash2} className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                              </div>

                              {/* Bottom Row: Metadata Pills on left, Action on right */}
                              <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-800/60">
                                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                  {meta.size && (
                                    <span className="px-2 py-0.5 rounded-md text-3xs font-mono font-medium bg-zinc-800/80 text-zinc-300 border border-zinc-700/50 whitespace-nowrap">
                                      {meta.size}
                                    </span>
                                  )}
                                  {meta.category && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenSpecsModelTag(openSpecsModelTag === m ? null : m);
                                      }}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-3xs font-medium bg-purple-950/40 hover:bg-purple-900/50 text-purple-300 border border-purple-800/40 hover:border-purple-600/50 transition-colors whitespace-nowrap cursor-pointer"
                                      title="Click to view verified Ollama capabilities & GGUF hardware specs"
                                    >
                                      <span>{meta.category}</span>
                                      <Icon
                                        icon={ChevronDown}
                                        className={`w-3 h-3 text-purple-400/80 transition-transform ${openSpecsModelTag === m ? "rotate-180" : ""}`}
                                      />
                                    </button>
                                  )}
                                </div>

                                <div className="shrink-0">
                                  {!isActive ? (
                                    <button
                                      type="button"
                                      onClick={() => handleSwitchModel(m)}
                                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white transition-colors border border-zinc-700/60"
                                    >
                                      Use Model
                                    </button>
                                  ) : (
                                    <div className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                                      <Icon icon={CheckCircle2} className="w-3.5 h-3.5 text-emerald-400" />
                                      <span>In Use</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Specs & Capabilities Popover anchored within card boundaries */}
                              {openSpecsModelTag === m && (
                                <>
                                  {/* Backdrop to dismiss when clicking outside */}
                                  <div
                                    role="presentation"
                                    className="fixed inset-0 z-scrim"
                                    onClick={() => setOpenSpecsModelTag(null)}
                                  />

                                  {/* Popover Card */}
                                  <div
                                    role="dialog"
                                    aria-label="Model specification"
                                    className={`absolute z-popover bottom-[48px] w-72 max-w-[calc(100vw-3rem)] p-3 rounded-xl bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/80 shadow-2xl text-left space-y-2.5 animate-in fade-in zoom-in-95 duration-100 ${
                                      index % 2 === 1
                                        ? "sm:right-3.5 sm:left-auto left-3.5"
                                        : "left-3.5"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                                      <div className="flex items-center gap-1.5">
                                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                        <span className="text-2xs font-semibold text-zinc-200">Verified GGUF Specs</span>
                                      </div>
                                      <span className="text-3xs text-zinc-500 font-mono">Ollama Source</span>
                                    </div>

                                    {/* Runtime Capabilities Section */}
                                    <div className="space-y-1">
                                      <div className="text-4xs uppercase tracking-wider font-bold text-zinc-400">
                                        Runtime Capabilities
                                      </div>
                                      <div className="flex flex-wrap gap-1 pt-0.5">
                                        {meta.capabilities && meta.capabilities.length > 0 ? (
                                          meta.capabilities.map((cap) => (
                                            <span
                                              key={cap}
                                              className="px-1.5 py-0.5 rounded text-3xs font-medium bg-zinc-800/90 text-zinc-300 border border-zinc-700/60 flex items-center gap-1"
                                            >
                                              <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                                              {cap}
                                            </span>
                                          ))
                                        ) : (
                                          <span className="text-3xs text-zinc-500 italic">Standard generation</span>
                                        )}
                                      </div>
                                    </div>

                                    {/* Hardware & Parameter Specs */}
                                    <div className="space-y-1 pt-1 border-t border-zinc-800/80 text-2xs">
                                      <div className="flex justify-between text-zinc-400">
                                        <span>Context Limit:</span>
                                        <span className="font-mono text-zinc-200">{meta.contextLengthFormatted || "Standard"}</span>
                                      </div>
                                      <div className="flex justify-between text-zinc-400">
                                        <span>Parameter Scale:</span>
                                        <span className="font-mono text-zinc-200">{meta.parameterSize || "N/A"}</span>
                                      </div>
                                      <div className="flex justify-between text-zinc-400">
                                        <span>Quantization:</span>
                                        <span className="font-mono text-zinc-200">{meta.quantization || "GGUF"}</span>
                                      </div>
                                      <div className="flex justify-between text-zinc-400">
                                        <span>Disk Footprint:</span>
                                        <span className="font-mono text-zinc-200">{meta.size}</span>
                                      </div>
                                    </div>

                                    {/* Capability Explanation */}
                                    <div className="p-2 rounded-lg bg-zinc-950/60 border border-zinc-800/60 text-3xs text-zinc-400 leading-relaxed">
                                      {meta.strength}
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl border border-dashed border-zinc-800 text-center space-y-1">
                        <p className="text-xs text-zinc-400">No models currently downloaded to Ollama.</p>
                        <p className="text-2xs text-zinc-500">Pick a recommended model below to download it locally.</p>
                      </div>
                    )}
                  </div>

                  {/* 3. Active In-Progress Download Bar */}
                  {pullingModelTag && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <div className="flex items-center gap-2">
                          <Icon icon={Loader2} className="w-3.5 h-3.5 text-purple-400 animate-spin" />
                          <span className="text-zinc-400">Pulling</span>
                          <strong className="text-white font-bold">{pullingModelTag}</strong>
                        </div>
                      </div>
                      <HashProgressBar percent={pullPercent} statusText={pullStatusText} />
                    </div>
                  )}

                  {/* Success & Error Banners */}
                  {pullSuccessMsg && (
                    <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 text-xs font-mono flex items-center gap-2">
                      <Icon icon={CheckCircle2} className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{pullSuccessMsg}</span>
                    </div>
                  )}
                  {pullErrorMsg && (
                    <div className="p-3 rounded-xl bg-red-950/50 border border-red-500/40 text-red-300 text-xs font-mono flex items-center gap-2">
                      <Icon icon={AlertCircle} className="w-4 h-4 text-red-400 shrink-0" />
                      <span>{pullErrorMsg}</span>
                    </div>
                  )}

                  {/* 4. Curated Models to Download (De-duplicated: only uninstalled models) */}
                  {(() => {
                    const uninstalledCuratedModels = CURATED_OLLAMA_MODELS.filter((item) => {
                      return !ollamaStatus?.models.some(
                        (m) =>
                          m === item.tag ||
                          m === `${item.tag}:latest` ||
                          item.tag === `${m}:latest` ||
                          m.startsWith(`${item.tag}:`) ||
                          item.tag.startsWith(`${m}:`)
                      );
                    });

                    return (
                      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-3.5">
                        <div>
                          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                            <Icon icon={Download} className="w-3.5 h-3.5 text-purple-400" />
                            Download Additional Models
                          </h3>
                          <p className="text-2xs text-zinc-400 mt-0.5">
                            High-performance local models optimized for code completion, refactoring, and AI conversation.
                          </p>
                        </div>

                        {uninstalledCuratedModels.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {uninstalledCuratedModels.map((item) => {
                              const isPullingThis = pullingModelTag === item.tag;

                              return (
                                <div
                                  key={item.tag}
                                  className="p-3.5 rounded-xl border border-zinc-800/80 bg-zinc-900/70 hover:border-zinc-700/80 transition-all flex flex-col justify-between space-y-2.5"
                                >
                                  <div>
                                    <div className="flex items-start justify-between gap-2">
                                      <div>
                                        <h4 className="text-xs font-bold text-zinc-100">{item.name}</h4>
                                        <div className="font-mono text-3xs text-purple-300 mt-0.5">{item.tag}</div>
                                      </div>
                                      <div className="flex flex-col items-end gap-1">
                                        <span className="px-1.5 py-0.5 rounded text-4xs font-mono bg-zinc-800 text-zinc-300 border border-zinc-700/60">
                                          {item.size}
                                        </span>
                                        <span className="text-4xs text-zinc-500 font-mono">{item.recommendedRam}</span>
                                      </div>
                                    </div>

                                    <p className="text-2xs text-zinc-400 mt-2 leading-relaxed">
                                      {item.description}
                                    </p>
                                  </div>

                                  <div className="pt-2 border-t border-zinc-800/60 flex items-center justify-between">
                                    <span className="text-3xs text-zinc-500 font-mono uppercase tracking-wider">
                                      {item.category}
                                    </span>

                                    {isPullingThis ? (
                                      <span className="text-xs font-semibold text-purple-300 flex items-center gap-1.5">
                                        <Icon icon={Loader2} className="w-3 h-3 animate-spin" /> Downloading…
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={!!pullingModelTag}
                                        onClick={() => handlePullModel(item.tag)}
                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white transition-colors disabled:opacity-40 shadow-sm"
                                      >
                                        <Icon icon={Download} className="w-3 h-3" />
                                        <span>Pull ({item.size})</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="p-3.5 rounded-xl bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2.5">
                            <Icon icon={CheckCircle2} className="w-4 h-4 text-emerald-400 shrink-0" />
                            <span>All recommended local models are installed on this machine. Ready for 100% offline inference.</span>
                          </div>
                        )}

                        {/* 5. Custom Model Tag Input Field */}
                        <div className="pt-3 border-t border-zinc-800/80">
                          <label htmlFor="aimanagementdashboard-pull-custom-model-by-tag-1" className="text-xs font-semibold text-zinc-300 block mb-1.5">
                            Pull Custom Model by Tag
                          </label>
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (customModelTag.trim()) {
                                handlePullModel(customModelTag.trim());
                                setCustomModelTag("");
                              }
                            }}
                            className="flex items-center gap-2"
                          >
                            <input id="aimanagementdashboard-pull-custom-model-by-tag-1"
                              type="text"
                              value={customModelTag}
                              onChange={(e) => setCustomModelTag(e.target.value)}
                              placeholder="e.g. llama3.2:1b, starcoder2:3b, deepseek-r1:14b..."
                              disabled={!!pullingModelTag}
                              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-zinc-100 font-mono placeholder-zinc-500 focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
                            />
                            <button
                              type="submit"
                              disabled={!customModelTag.trim() || !!pullingModelTag}
                              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white transition-colors disabled:opacity-40 shrink-0 shadow-sm"
                            >
                              <Icon icon={Download} className="w-3.5 h-3.5" />
                              <span>Pull Model</span>
                            </button>
                          </form>
                          <p className="text-3xs text-zinc-500 mt-1">
                            Supports any model tag from the official{" "}
                            <button
                              type="button"
                              onClick={() => void openExternal("https://ollama.com/library")}
                              className="text-purple-400 hover:underline"
                            >
                              Ollama Library
                            </button>.
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                /* ── Standard Provider Configuration ─── */
                <>
                  {/* Model Selection Dropdown */}
                  <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label htmlFor="aimanagementdashboard-active-model-2" className="text-xs font-semibold text-zinc-300">Active Model</label>
                        {activeProvider.category === "cloud" && (
                          <button
                            type="button"
                            disabled={isTesting}
                            onClick={handleTestConnection}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-semibold text-purple-300 hover:text-purple-100 bg-purple-950/50 hover:bg-purple-900/60 border border-purple-700/50 rounded-lg transition-colors shadow-sm disabled:opacity-50"
                            title="Query live provider endpoint with your API key to fetch newest models"
                          >
                            <Icon icon={RefreshCw} className={`w-3 h-3 ${isTesting ? "animate-spin text-purple-400" : ""}`} />
                            <span>{isTesting ? "Fetching Models…" : "Fetch Latest Models"}</span>
                          </button>
                        )}
                      </div>
                      {(() => {
                        const curated = curateProviderModels(activeProvider.id, activeProvider.availableModels);
                        // Ensure selectedModel or any custom model is included if set
                        const displayModels = (selectedModel && !curated.includes(selectedModel))
                          ? [selectedModel, ...curated]
                          : curated;
                        const modelsToShow = displayModels.length > 0 ? displayModels : activeProvider.availableModels;

                        return (
                          <select id="aimanagementdashboard-active-model-2"
                            value={selectedModel}
                            onChange={(e) => {
                              setSelectedModel(e.target.value);
                              handleSaveProvider(e.target.value, baseUrlInput);
                            }}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-purple-500/60 transition-colors cursor-pointer"
                          >
                            {modelsToShow.map((m) => (
                              <option key={m} value={m} className="bg-zinc-900 text-zinc-100">
                                {m}
                              </option>
                            ))}
                          </select>
                        );
                      })()}

                      {/* Custom Model Write-in for Cloud Providers */}
                      {activeProvider.category === "cloud" && (
                        <div className="pt-1.5">
                          <form
                            onSubmit={handleAddCustomModel}
                            className="flex items-center gap-2"
                          >
                            <input id="aimanagementdashboard-api-key-secret-token-stored-in-the-app-3"
                              type="text"
                              value={customCloudModel}
                              onChange={(e) => setCustomCloudModel(e.target.value)}
                              placeholder="Or enter custom model ID (e.g. gpt-5, claude-3-7-sonnet-2026, deepseek-v3)..."
                              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-1.5 text-xs text-zinc-100 font-mono placeholder-zinc-500 focus:outline-none focus:border-purple-500/60 transition-colors"
                            />
                            <button
                              type="submit"
                              disabled={!customCloudModel.trim()}
                              className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition-colors disabled:opacity-40 shrink-0 shadow-sm"
                            >
                              Add Model
                            </button>
                          </form>
                          <p className="text-3xs text-zinc-500 mt-1">
                            Type any custom model ID to bypass defaults and use unlisted or fine-tuned model weights.
                          </p>
                        </div>
                      )}

                      <p className="text-2xs text-zinc-500">
                        Powers inline completions, code suggestions, syntax repair, and AI assistant conversations.
                      </p>
                  </div>

                  {/* API Key Input (if cloud provider) */}
                  {activeProvider.category === "cloud" ? (
                    <div className="space-y-2">
                      <label htmlFor="aimanagementdashboard-api-key-secret-token-stored-in-the-app-3" className="text-xs font-semibold text-zinc-300 flex items-center justify-between">
                        <span>API Key / Secret Token</span>
                        <span className="text-2xs text-zinc-500 font-normal">
                          Stored in your system keychain — never read back into the page
                        </span>
                      </label>
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input id="aimanagementdashboard-base-url-endpoint-classname-text-1-4"
                            type={showApiKey ? "text" : "password"}
                            value={apiKeyInput}
                            onChange={(e) => setApiKeyInput(e.target.value)}
                            placeholder="sk-••••••••••••••••••••••••"
                            // A credential is not prose. Measured: with "Show key" on,
                            // WebKit capitalised the first character and the app saved
                            // `Sk-…` — a key that looks right and authenticates as 401.
                            // Nothing about a key wants autocapitalisation, autocorrect
                            // or spellcheck, and none of them can be recovered from.
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-3.5 pr-10 py-2.5 text-xs text-zinc-100 font-mono placeholder-zinc-500 focus:outline-none focus:border-purple-500/60 transition-colors"
                          />
                          <button
                            type="button"
                            onClick={() => setShowApiKey((prev) => !prev)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                            title={showApiKey ? "Hide key" : "Show key"}
                          >
                            {showApiKey ? <Icon icon={Eye} className="w-3.5 h-3.5" /> : <Icon icon={Eye} className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSaveProvider()}
                          className="px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-bold text-white transition-colors shadow-sm"
                        >
                          Save Key
                        </button>
                      </div>
                      {keyStorage && (
                        <p
                          className={
                            keyStorage.stored === "keychain"
                              ? "mt-2 text-2xs text-emerald-300/80"
                              : "mt-2 text-2xs text-amber-300/90"
                          }
                        >
                          {keyStorage.stored === "keychain"
                            ? "Saved to your system keychain."
                            : `Saved to the app database, not your keychain — ${
                                keyStorage.reason || "the keychain was not usable here"
                              }`}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 flex items-start gap-2.5">
                      <Icon icon={ShieldCheck} className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-white">100% Offline & Private</div>
                        <p className="text-2xs text-emerald-300/80 mt-0.5">
                          This model runs locally on your machine. Zero network traffic, zero third-party telemetry, zero API keys required.
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Base URL / Endpoint */}
              <div className="space-y-2">
                <label htmlFor="aimanagementdashboard-base-url-endpoint-classname-text-1-4" className="text-xs font-semibold text-zinc-300 flex items-center justify-between">
                  <span>Base URL / Endpoint</span>
                  <button
                    type="button"
                    onClick={() => {
                      setBaseUrlInput(activeProvider.baseUrl);
                      handleSaveProvider(selectedModel, activeProvider.baseUrl);
                    }}
                    className="text-2xs text-purple-400 hover:underline"
                  >
                    Reset default
                  </button>
                </label>
                <input
                  type="text"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder="https://api..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-100 font-mono placeholder-zinc-500 focus:outline-none focus:border-purple-500/60 transition-colors"
                />
              </div>

              {/* Provider Actions */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    disabled={isTesting}
                    onClick={handleTestConnection}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-200 hover:text-white transition-all shadow-sm"
                  >
                    <Icon icon={RefreshCw} className={`w-3.5 h-3.5 ${isTesting ? "animate-spin text-purple-400" : "text-zinc-400"}`} />
                    <span>{isTesting ? "Pinging Endpoint..." : "Test Connection"}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      handleSaveProvider();
                      setSavedFlash(true);
                      window.setTimeout(() => setSavedFlash(false), 2500);
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white transition-all shadow-sm"
                  >
                    <Icon icon={ShieldCheck} className="w-3.5 h-3.5" />
                    <span>{savedFlash ? "Saved ✓" : "Save Configuration"}</span>
                  </button>
                </div>
                {activeProvider.category === "cloud" && (
                  <p className="text-3xs text-zinc-500">
                    API keys are kept in your operating system's keychain — macOS Keychain, Windows Credential Manager, Linux Secret Service — and used by the agent, editor review and inline edit. Where a keychain is unavailable the key falls back to the app database with `0600` permissions, and the save reports which happened. They are write-only across the app's own API: the page can set or clear a key and ask whether one exists, but never receives the value.
                  </p>
                )}

                {testResult && (
                  <div
                    className={`p-3 rounded-xl text-xs flex items-center gap-2 font-mono ${
                      testResult.ok
                        ? "bg-emerald-950/60 border border-emerald-500/40 text-emerald-300"
                        : "bg-red-950/60 border border-red-500/40 text-red-300"
                    }`}
                  >
                    {testResult.ok ? (
                      <Icon icon={CheckCircle2} className="w-4 h-4 shrink-0 text-emerald-400" />
                    ) : (
                      <Icon icon={AlertCircle} className="w-4 h-4 shrink-0 text-red-400" />
                    )}
                    <span>
                      {testResult.ok
                        ? `Connection verified! Round-trip latency: ${testResult.latencyMs}ms`
                        : testResult.message || "Connection failed. Please check endpoint or API key."}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Status Callout */}
            <div className="pt-4 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
              <span>{activeProvider.availableModels.length} models available for {activeProvider.name}</span>
              <span className="font-mono text-2xs text-zinc-500">ID: {activeProvider.id}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Inline Ollama Setup Wizard (triggered from status card) */}
      {showOllamaWizard && (
        <OllamaSetupWizard
          onClose={() => setShowOllamaWizard(false)}
          onComplete={() => {
            setShowOllamaWizard(false);
            setProviders(loadAllProviders());
            checkOllamaStatus().then(setOllamaStatus).catch(() => {});
            onModelSettingsChanged?.();
          }}
        />
      )}

      {confirmDeleteTag && (
        <ConfirmDialog
          isOpen={true}
          title="Delete Local Model"
          message={
            <span>
              Are you sure you want to delete <span className="font-semibold text-zinc-100">"{confirmDeleteTag}"</span> from your local machine? This action cannot be undone.
            </span>
          }
          detail="You can re-download this model at any time from the models registry."
          confirmText="Delete Model"
          cancelText="Cancel"
          isDestructive={true}
          onConfirm={() => handleDeleteModel(confirmDeleteTag)}
          onCancel={() => setConfirmDeleteTag(null)}
        />
      )}
    </>
  );
}

export default AiManagementDashboard;
