/**
 * ollamaSetup.ts — Automatic Ollama Detection & Setup Service
 *
 * Detection, install and downloads for the local model runtime. Every call
 * prefers the desktop shell and falls back to the dev bridge for a browser:
 * 1. Silently detect whether Ollama is installed and running on startup.
 * 2. Install Ollama via clean passwordless unpack with structured progress streaming.
 * 3. Pull the RAM-appropriate default model with structured progress streaming.
 * 4. Start the Ollama server and wait for it to become healthy.
 * 5. Track first-launch state so the wizard only auto-shows once.
 */

export const OLLAMA_FIRST_LAUNCH_KEY = "acsa_code_ollama_setup_done_v1";

/** Set once the user dismisses the advisory "no model configured" notice. */
export const OLLAMA_NOTICE_DISMISSED_KEY = "acsa_code_ollama_notice_dismissed_v1";

export interface OllamaModelDetail {
  name: string;
  tag: string;
  sizeBytes?: number;
  sizeFormatted?: string;
  parameterSize?: string;
  family?: string;
  quantizationLevel?: string;
  modifiedAt?: string;
  capabilities?: string[];
  contextLength?: number;
  parameterCount?: number;
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  models: string[];
  modelsDetails?: OllamaModelDetail[];
  recommendedModel: string;
  totalRamGb: number;
  binaryPath?: string;
  error?: string;
}

export interface OllamaProgressEvent {
  percent: number;
  status: string;
  log?: string;
}

/** Ping the bridge to get Ollama install/running state + RAM-based model recommendation. */
export async function checkOllamaStatus(): Promise<OllamaStatus> {
  try {
    if (hasIpc()) {
      // The bundled engine probes 127.0.0.1:11434 itself. This is the path that
      // makes the app able to see a running Ollama at all.
      return await engineCall<OllamaStatus>("ollama", ["status"]);
    }
    throw desktopRequired("Ollama detection");
  } catch (err: any) {
    return {
      installed: false,
      running: false,
      models: [],
      recommendedModel: "qwen2.5-coder:3b",
      totalRamGb: 0,
      error: err.message,
    };
  }
}

/**
 * Stream model pull progress.
 * Resolves with the pulled model name when complete.
 */
export async function pullOllamaModel(
  model: string,
  onProgress: (evt: OllamaProgressEvent) => void
): Promise<string> {
  if (hasIpc()) return pullViaIpc(model, onProgress);
  // Downloads are the engine's job (it streams Ollama's own progress through
  // `ollama_pull`). A browser has no engine, so there is nothing to fall back to.
  throw desktopRequired("Downloading a model");
}

/**
 * Download through the desktop shell.
 *
 * The engine streams one NDJSON frame per progress update on its stdout and Rust
 * forwards each as an `ollama:frame` event, so the wizard shows the same percent
 * it did over the dev bridge — this is the path the packaged app uses.
 */
async function pullViaIpc(
  model: string,
  onProgress: (evt: OllamaProgressEvent) => void,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let finished = false;
  let unlisten: Array<() => void> = [];
  const cleanup = () => {
    unlisten.forEach((off) => off());
    unlisten = [];
  };

  return new Promise<string>((resolve, reject) => {
    void (async () => {
      const handle = (line: string) => {
        if (finished) return;
        try {
          const obj = JSON.parse(line) as {
            percent?: number;
            status?: string;
            done?: boolean;
            model?: string;
            error?: string;
          };
          if (obj.error && !obj.done) {
            onProgress({ percent: obj.percent ?? 0, status: obj.error });
            return;
          }
          if (obj.percent !== undefined || obj.status) {
            onProgress({
              percent: obj.percent ?? 0,
              status: obj.status || `Downloading ${model}…`,
              log: obj.status,
            });
          }
          if (obj.done) {
            finished = true;
            cleanup();
            if (obj.error) reject(new Error(obj.error));
            else resolve(obj.model || model);
          }
        } catch {
          /* a partial or non-JSON line carries nothing to show */
        }
      };

      unlisten.push(
        await listen<{ line?: string } | string>("ollama:frame", (event) => {
          const payload = event.payload;
          handle(typeof payload === "string" ? payload : String(payload?.line ?? ""));
        }),
      );
      unlisten.push(
        await listen<string>("ollama:exit", (event) => {
          if (finished) return;
          finished = true;
          cleanup();
          const note = String(event.payload ?? "").trim();
          reject(new Error(note || "The download stopped before finishing."));
        }),
      );

      try {
        await invoke("ollama_pull", { model });
      } catch (error) {
        finished = true;
        cleanup();
        reject(new Error(String(error)));
      }
    })();
  });
}

/** Start the Ollama server and wait for it to become healthy (up to 6s). */
export async function startOllamaServer(): Promise<boolean> {
  try {
    if (hasIpc()) {
      const result = await engineCall<{ started: boolean }>("ollama", ["start"]);
      return Boolean(result?.started);
    }
    return false;
  } catch {
    return false;
  }
}

/** Mark setup as completed so wizard doesn't auto-pop on next launch. */
export function markSetupComplete(): void {
  localStorage.setItem(OLLAMA_FIRST_LAUNCH_KEY, "1");
}

/**
 * The "no model configured" notice is advisory, so dismissing it has to stick —
 * otherwise the app nags on every launch. The wizard stays reachable from the AI
 * dashboard and the command palette, so nothing is lost by hiding it.
 */
export function isOllamaNoticeDismissed(): boolean {
  return localStorage.getItem(OLLAMA_NOTICE_DISMISSED_KEY) === "1";
}

export function dismissOllamaNotice(): void {
  localStorage.setItem(OLLAMA_NOTICE_DISMISSED_KEY, "1");
}

/** Delete an installed Ollama model to free disk space. */
export async function deleteOllamaModel(model: string): Promise<boolean> {
  try {
    if (hasIpc()) {
      const result = await engineCall<{ ok: boolean }>("ollama", [
        "delete",
        JSON.stringify({ model }),
      ]);
      return Boolean(result?.ok);
    }
    return false;
  } catch {
    return false;
  }
}

export interface CuratedOllamaModel {
  tag: string;
  name: string;
  category: string;
  size: string;
  recommendedRam: string;
  description: string;
  isPopular?: boolean;
}

export const CURATED_OLLAMA_MODELS: CuratedOllamaModel[] = [
  {
    tag: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder 7B",
    category: "Coding & Agents",
    size: "4.7 GB",
    recommendedRam: "16 GB+ RAM",
    description: "Flagship local coding model. Exceptional reasoning, refactoring, and AST-aware code generation.",
    isPopular: true,
  },
  {
    tag: "qwen2.5-coder:3b",
    name: "Qwen 2.5 Coder 3B",
    category: "Coding & Agents",
    size: "1.9 GB",
    recommendedRam: "8 GB RAM",
    description: "Optimal balance of performance and low memory footprint. Fast chat, generation, and syntax fixes.",
    isPopular: true,
  },
  {
    tag: "qwen2.5-coder:1.5b",
    name: "Qwen 2.5 Coder 1.5B",
    category: "Autocomplete",
    size: "986 MB",
    recommendedRam: "4-8 GB RAM",
    description: "Ultra-fast lightweight model. Ideal for inline ghost completions and rapid code hints.",
    isPopular: true,
  },
  {
    tag: "llama3.2:3b",
    name: "Llama 3.2 3B",
    category: "General & Chat",
    size: "2.0 GB",
    recommendedRam: "8 GB RAM",
    description: "Meta's lightweight instruction-tuned model for conversational programming assistance.",
    isPopular: true,
  },
  {
    tag: "llama3.2:1b",
    name: "Llama 3.2 1B",
    category: "Ultra-Lightweight",
    size: "1.3 GB",
    recommendedRam: "4 GB RAM",
    description: "Smallest Meta Llama 3.2 release. Extremely quick responses on constrained devices.",
  },
  {
    tag: "deepseek-coder:6.7b",
    name: "DeepSeek Coder 6.7B",
    category: "Code Specialist",
    size: "3.8 GB",
    recommendedRam: "16 GB RAM",
    description: "Pre-trained on 2T code tokens. Highly capable at complex multi-file logic and debugging.",
  },
  {
    tag: "codellama:7b",
    name: "Code Llama 7B",
    category: "Code Specialist",
    size: "3.8 GB",
    recommendedRam: "16 GB RAM",
    description: "Meta's code-specialized model built specifically for software engineering workflows.",
  },
  {
    tag: "gemma4:e4b",
    name: "Gemma 4 E4B",
    category: "General & Chat",
    size: "2.6 GB",
    recommendedRam: "8 GB RAM",
    description: "Google's lightweight Gemma 4B model optimized for conversational programming and text reasoning.",
    isPopular: true,
  },
  {
    tag: "gemma2:9b",
    name: "Gemma 2 9B",
    category: "General & Reasoning",
    size: "5.5 GB",
    recommendedRam: "16 GB RAM",
    description: "Google's high-efficiency open model with exceptional reasoning and knowledge breadth.",
  },
  {
    tag: "gemma2:2b",
    name: "Gemma 2 2B",
    category: "Fast & Lightweight",
    size: "1.6 GB",
    recommendedRam: "4-8 GB RAM",
    description: "Google's compact lightweight model for fast local inference and quick assistance.",
  },
  {
    tag: "deepseek-r1:8b",
    name: "DeepSeek R1 8B",
    category: "Reasoning & Logic",
    size: "4.9 GB",
    recommendedRam: "16 GB RAM",
    description: "DeepSeek's distilled reasoning model featuring strong chain-of-thought mathematical and algorithmic abilities.",
    isPopular: true,
  },
  {
    tag: "mistral:7b",
    name: "Mistral 7B",
    category: "General & Reasoning",
    size: "4.1 GB",
    recommendedRam: "16 GB RAM",
    description: "Strong general reasoning, summarization, and instruction-following capabilities.",
  },
];

export interface ResolvedModelMetadata {
  name: string;
  tag: string;
  size: string;
  category: string;
  strength: string;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  capabilities: string[];
  contextLength?: number;
  contextLengthFormatted?: string;
}

export function formatModelBytes(bytes?: number): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 ** 2))} MB`;
}

export function formatContextLength(tokens?: number): string {
  if (!tokens || tokens <= 0 || !Number.isFinite(tokens)) return "";
  if (tokens >= 1024) {
    const k = Math.round(tokens / 1024);
    return `${k}K Context`;
  }
  return `${tokens} Tokens`;
}

/**
 * Fetch raw model manifest from Ollama's local inspection endpoint.
 */
export async function getOllamaModelShow(model: string): Promise<any> {
  try {
    if (hasIpc()) {
      const result = await engineCall<{ ok: boolean }>("ollama", [
        "show",
        JSON.stringify({ model }),
      ]);
      return result?.ok ? result : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Intelligently resolve display name, disk size, and capability category for ANY Ollama model.
 * Uses factual Ollama capabilities flags (tools, thinking, vision, completion) as the single source of truth.
 */
export function resolveModelMetadata(
  tag: string,
  detail?: OllamaModelDetail
): ResolvedModelMetadata {
  const cleanTag = tag.trim();
  const lowerTag = cleanTag.toLowerCase();
  const tagNoLatest = lowerTag.replace(/:latest$/, "");

  // 1. Try to find a match in CURATED_OLLAMA_MODELS
  // Priority 1: Exact tag match (e.g. "qwen2.5-coder:1.5b" === "qwen2.5-coder:1.5b")
  let curated = CURATED_OLLAMA_MODELS.find((c) => c.tag.toLowerCase() === lowerTag);

  // Priority 2: If model tag in Ollama is "model:latest" or "model", match curated entry without :latest
  if (!curated) {
    curated = CURATED_OLLAMA_MODELS.find((c) => {
      const cTag = c.tag.toLowerCase();
      const cTagNoLatest = cTag.replace(/:latest$/, "");
      return cTagNoLatest === tagNoLatest && (lowerTag === cTagNoLatest || lowerTag.endsWith(":latest"));
    });
  }

  // 2. Resolve Size
  let size = detail?.sizeFormatted || (detail?.sizeBytes ? formatModelBytes(detail.sizeBytes) : "");
  if (!size && curated?.size) {
    size = curated.size;
  }
  if (!size) {
    const paramMatch =
      lowerTag.match(/[:_-]?(\d+(\.\d+)?)b/i) ||
      (detail?.parameterSize ? [detail.parameterSize, detail.parameterSize.replace(/b/i, "")] : null);
    if (paramMatch && paramMatch[1]) {
      const numB = parseFloat(paramMatch[1]);
      if (numB <= 1.5) size = `${Math.round(numB * 700)} MB`;
      else if (numB <= 4) size = `${(numB * 0.65).toFixed(1)} GB`;
      else if (numB <= 9) size = `${(numB * 0.6).toFixed(1)} GB`;
      else if (numB <= 14) size = `${(numB * 0.65).toFixed(1)} GB`;
      else size = `${(numB * 0.6).toFixed(0)} GB`;
    } else {
      size = "Local Model";
    }
  }

  // 3. Resolve Category & Strength using Factual Capabilities as Source of Truth
  const capabilities = detail?.capabilities || [];
  const hasTools = capabilities.includes("tools");
  const hasThinking = capabilities.includes("thinking");
  const hasVision = capabilities.includes("vision");

  const isCodeAffinitive =
    /coder|code|codestral|starcoder|codellama|dev/i.test(lowerTag) ||
    (detail?.family ? /coder|code/i.test(detail.family) : false);

  // Extract parameter size number in Billions
  const paramMatch =
    lowerTag.match(/[:_-]?(\d+(\.\d+)?)b/i) ||
    (detail?.parameterSize ? [detail.parameterSize, detail.parameterSize.replace(/b/i, "")] : null);
  const numB = paramMatch && paramMatch[1] ? parseFloat(paramMatch[1]) : 0;

  let category = "";
  let strength = "";

  if ((numB > 0 && numB <= 1.5) || /autocomplete|tiny|mini/i.test(lowerTag)) {
    category = "Autocomplete & Speed";
    strength = "Ultra-fast low-latency inline code predictions and ghost completions";
  } else if (hasTools && isCodeAffinitive) {
    category = "Agent & Coding";
    strength = "Autonomous code generation, refactoring, and agent tool execution";
  } else if (hasThinking) {
    category = "Reasoning & Logic";
    strength = "Native chain-of-thought analysis, mathematical synthesis, and deep logic";
  } else if (hasVision) {
    category = "Multimodal & Vision";
    strength = "Visual image comprehension, document parsing, and multimodal reasoning";
  } else if (hasTools) {
    category = "Agent & Tools";
    strength = "Tool & function calling for autonomous workflows and structured APIs";
  } else if (isCodeAffinitive) {
    category = "Coding Specialist";
    strength = "Code synthesis, syntax completion, and AST-aware programming";
  } else if (numB > 0 && numB <= 3) {
    category = "Fast & Lightweight";
    strength = "Fast local inference, low memory usage, and responsive assistance";
  } else {
    category = curated?.category || "General Chat";
    strength = curated?.description || "Conversational dialogue and natural language assistance";
  }

  // 4. Resolve Human-Readable Name
  let name = curated?.name || "";
  if (!name) {
    const [namePart, subPart] = cleanTag.split(":");
    const formatPart = (str: string) =>
      str
        .replace(/([a-zA-Z]{2,})(\d)/g, "$1 $2")
        .replace(/[-_]/g, " ")
        .split(" ")
        .filter(Boolean)
        .map((w) => {
          const lower = w.toLowerCase();
          if (lower === "deepseek") return "DeepSeek";
          if (lower === "codellama") return "CodeLlama";
          if (lower === "starcoder") return "StarCoder";
          if (/^\d+(\.\d+)?$/.test(w)) return w; // keep version numbers like 2.5 intact
          return w.charAt(0).toUpperCase() + w.slice(1);
        })
        .join(" ");

    const formattedName = formatPart(namePart);
    if (subPart && subPart !== "latest") {
      const formattedSub = subPart.toUpperCase();
      name = `${formattedName} ${formattedSub}`;
    } else if (detail?.parameterSize) {
      name = `${formattedName} ${detail.parameterSize.toUpperCase()}`;
    } else {
      name = formattedName;
    }
  }

  return {
    name,
    tag: cleanTag,
    size,
    category,
    strength,
    parameterSize: detail?.parameterSize,
    quantization: detail?.quantizationLevel,
    family: detail?.family,
    capabilities,
    contextLength: detail?.contextLength,
    contextLengthFormatted: formatContextLength(detail?.contextLength),
  };
}

export const EVENT_OPEN_OLLAMA_WIZARD = "acsa:open-ollama-wizard";
export const EVENT_OPEN_AI_MANAGEMENT = "acsa:open-ai-management";
export const EVENT_START_CODING_WITH_OLLAMA = "acsa:start-coding-with-ollama";

/** Programmatically open the Ollama setup wizard modal from anywhere in the app. */
export function openOllamaSetupWizard(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_OPEN_OLLAMA_WIZARD));
  }
}

/** Programmatically open the AI Models & Providers Management Dashboard from anywhere. */
export function openAiManagementDashboard(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_OPEN_AI_MANAGEMENT));
  }
}

/** Programmatically open AI Assistant Chat and focus input to start coding with Ollama immediately. */
export function startCodingWithOllama(model?: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_START_CODING_WITH_OLLAMA, { detail: { model } }));
  }
}
import { desktopRequired, engineCall, hasIpc } from "./engineBridge";
