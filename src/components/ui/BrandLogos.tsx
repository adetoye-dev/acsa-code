/**
 * BrandLogos.tsx — Authentic AI Model, Provider & IDE Vector Logos
 *
 * Provides standardized, pixel-perfect official brand vector assets directly loaded
 * from public/logos/*.svg with design system token scaling, automatic viewBox resolution,
 * and zero-latency live synchronization when files on disk are updated.
 */

import React, { useState, useEffect, useRef } from "react";
import {
  computeLogoStyle,
  resolveLogoSize,
  type LogoSize,
} from "./logoSizing";

export { computeLogoStyle, LOGO_SIZE_MAP, resolveLogoSize } from "./logoSizing";
export type { LogoSize } from "./logoSizing";

// ── Design System Size Tokens ──────────────────────────────────────────────
export interface LogoProps extends Omit<React.HTMLAttributes<HTMLElement>, "size"> {
  className?: string;
  size?: LogoSize;
  title?: string;
}

/**
 * Checks whether target string contains token bounded by start/end or non-alphanumeric separators.
 * Prevents false positives like "meshflow" matching "hf" or "custom-provider" matching "ide".
 */
function hasToken(target: string, token: string): boolean {
  const pattern = new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`, "i");
  return pattern.test(target);
}

// ── Official SVG Asset Paths ────────────────────────────────────────────────
export const BRAND_LOGO_URLS: Record<string, string> = {
  acsa: "/logos/acsa.svg",
  openai: "/logos/openai.svg",
  anthropic: "/logos/anthropic.svg",
  claude: "/logos/claude.svg",
  google: "/logos/gemini.svg",
  gemini: "/logos/gemini.svg",
  deepseek: "/logos/deepseek.svg",
  meta: "/logos/meta.svg",
  llama: "/logos/llama.svg",
  mistral: "/logos/mistral.svg",
  groq: "/logos/groq.svg",
  nvidia: "/logos/nvidia.svg",
  ollama: "/logos/ollama.svg",
  cohere: "/logos/cohere.svg",
  perplexity: "/logos/perplexity.svg",
  huggingface: "/logos/huggingface.svg",
  xai: "/logos/xai.svg",
  grok: "/logos/grok.svg",
  moonshot: "/logos/moonshot.svg",
  kimi: "/logos/kimi.svg",
  qwen: "/logos/qwen.svg",
  alibaba: "/logos/alibaba.svg",
  together: "/logos/together.svg",
  replicate: "/logos/replicate.svg",
  scale: "/logos/scale.svg",
  elevenlabs: "/logos/elevenlabs.svg",
  stability: "/logos/stability.svg",
  midjourney: "/logos/midjourney.svg",
  runway: "/logos/runway.svg",
  databricks: "/logos/databricks.svg",
  copilot: "/logos/copilot.svg",
  github: "/logos/github.svg",
  openrouter: "/logos/openrouter.svg",
  cognition: "/logos/cognition.svg",
  devin: "/logos/devin.svg",
  ai21: "/logos/ai21.svg",
  pinecone: "/logos/pinecone.svg",
  character: "/logos/character.svg",
  inflection: "/logos/inflection.svg",
  pi: "/logos/pi.svg",
  poolside: "/logos/poolside.svg",
  luma: "/logos/luma.svg",
  deterministic: "/logos/deterministic.svg",
};

// ── Live In-Memory Cache Invalidation & Event Dispatcher ────────────────────
let globalLogoVersion = Date.now();
const logoListeners = new Set<() => void>();

export function refreshBrandLogos() {
  globalLogoVersion = Date.now();
  logoListeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

if (typeof window !== "undefined") {
  (window as any).__refreshLogos = refreshBrandLogos;
  if ((import.meta as any).hot) {
    (import.meta as any).hot.on("logo-file-changed", () => {
      refreshBrandLogos();
    });
  }
}

export interface BrandLogoImgProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "size"> {
  providerId: string;
  size?: LogoSize;
  className?: string;
  title?: string;
}

export function BrandLogoImg({
  providerId,
  size,
  className = "w-4 h-4 shrink-0",
  style,
  alt,
  title,
  ...rest
}: BrandLogoImgProps) {
  const [, setVersion] = useState(globalLogoVersion);

  useEffect(() => {
    const onUpdate = () => setVersion(globalLogoVersion);
    logoListeners.add(onUpdate);
    return () => {
      logoListeners.delete(onUpdate);
    };
  }, []);

  const resolvedProviderId = resolveBrandId(providerId);
  const baseSrc = BRAND_LOGO_URLS[resolvedProviderId] ?? BRAND_LOGO_URLS.deterministic;
  const src = `${baseSrc}?v=${globalLogoVersion}`;
  const px = resolveLogoSize(size);
  const computedStyle = computeLogoStyle(size, style);
  const meta = getBrandMetadata(resolvedProviderId);
  const brandTitle = title || meta?.name || providerId;
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (imageRef.current) delete imageRef.current.dataset.fallback;
  }, [src]);

  return (
    <img
      ref={imageRef}
      src={src}
      alt={alt || brandTitle || `${providerId} logo`}
      title={brandTitle}
      className={className}
      style={computedStyle}
      width={px}
      height={px}
      loading="eager"
      decoding="async"
      onError={(e) => {
        const target = e.currentTarget;
        if (!target.dataset.fallback) {
          target.dataset.fallback = "true";
          target.src = `${BRAND_LOGO_URLS.deterministic}?v=${globalLogoVersion}`;
        }
      }}
      onLoad={(e) => {
        e.currentTarget.dataset.fallback = "";
      }}
      {...rest}
    />
  );
}

// ── Official Brand Component Wrappers (100% Sourced from public/logos/*.svg) ─
export function IdeBrandLogo({ className = "w-4 h-4 shrink-0", size, style, title = "ACSA Code", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="acsa" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function OpenAiLogo({ className = "w-4 h-4 shrink-0", size, style, title = "OpenAI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="openai" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function ClaudeLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Anthropic Claude", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="claude" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}
export const AnthropicLogo = ClaudeLogo;

export function CopilotLogo({ className = "w-4 h-4 shrink-0", size, style, title = "GitHub Copilot", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="copilot" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function GithubLogo({ className = "w-4 h-4 shrink-0", size, style, title = "GitHub", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="github" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function GeminiLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Google Gemini", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="gemini" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function GoogleLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Google Gemini", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="gemini" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function OllamaLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Ollama", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="ollama" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function MistralLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Mistral AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="mistral" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function DeepSeekLogo({ className = "w-4 h-4 shrink-0", size, style, title = "DeepSeek", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="deepseek" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function MetaLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Meta / Llama", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="meta" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}
export const LlamaLogo = MetaLogo;

export function GroqLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Groq", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="groq" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function CohereLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Cohere", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="cohere" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

/**
 * The mark is a placeholder in `public/logos/nvidia.svg` — drawn for this app,
 * not the official artwork.
 *
 * It exists because the registry falls back to the local "Deterministic AST"
 * entry for any id it does not know, so without an entry NVIDIA NIM was drawn
 * with that mark *and announced as "Deterministic AST"* in the accessibility
 * tree. An honest placeholder beats a wrong brand.
 */
export function NvidiaLogo({ className = "w-4 h-4 shrink-0", size, style, title = "NVIDIA NIM", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="nvidia" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function PerplexityLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Perplexity AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="perplexity" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function HuggingFaceLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Hugging Face", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="huggingface" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function XAiLogo({ className = "w-4 h-4 shrink-0", size, style, title = "xAI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="xai" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function GrokLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Grok", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="grok" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function MoonshotLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Moonshot AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="moonshot" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}
export const KimiLogo = MoonshotLogo;

export function QwenLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Qwen", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="qwen" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}
export const AlibabaLogo = QwenLogo;

export function TogetherLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Together AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="together" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function ReplicateLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Replicate", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="replicate" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function ScaleLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Scale AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="scale" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function ElevenLabsLogo({ className = "w-4 h-4 shrink-0", size, style, title = "ElevenLabs", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="elevenlabs" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function StabilityLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Stability AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="stability" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function MidjourneyLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Midjourney", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="midjourney" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function RunwayLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Runway", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="runway" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function DatabricksLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Databricks", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="databricks" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function OpenRouterLogo({ className = "w-4 h-4 shrink-0", size, style, title = "OpenRouter", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="openrouter" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function CognitionLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Cognition AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="cognition" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}
export const DevinLogo = CognitionLogo;

export function Ai21Logo({ className = "w-4 h-4 shrink-0", size, style, title = "AI21 Labs", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="ai21" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function PineconeLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Pinecone", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="pinecone" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function CharacterAiLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Character.AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="character" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function InflectionLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Inflection AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="inflection" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}
export const PiLogo = InflectionLogo;

export function PoolsideLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Poolside", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="poolside" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function LumaLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Luma AI", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="luma" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

export function DeterministicLogo({ className = "w-4 h-4 shrink-0", size, style, title = "Deterministic AST", ...rest }: LogoProps) {
  return <BrandLogoImg providerId="deterministic" className={className} size={size} style={style} title={title} {...(rest as any)} />;
}

// ── Generic Provider Logo Dispatcher ────────────────────────────────────────
export interface ProviderLogoProps extends LogoProps {
  providerId: string;
  useImg?: boolean;
}

export function ProviderLogo({
  providerId,
  className = "w-4 h-4 shrink-0",
  size,
  style,
  useImg: _useImg,
  ...rest
}: ProviderLogoProps) {
  return (
    <BrandLogoImg
      providerId={providerId}
      size={size}
      className={className}
      style={style}
      {...(rest as any)}
    />
  );
}

// ── AI Company & Provider Registry ──────────────────────────────────────────
export interface AIBrandMetadata {
  id: string;
  name: string;
  domain: string;
  category: "frontier" | "cloud" | "local" | "open-source" | "platform" | "specialized";
  primaryColor: string;
  description: string;
  component: React.ComponentType<LogoProps>;
  aliases: string[];
}

export const AI_BRAND_REGISTRY: Record<string, AIBrandMetadata> = {
  acsa: {
    id: "acsa",
    name: "ACSA Code",
    domain: "acsa.internal",
    category: "local",
    primaryColor: "#38BDF8",
    description: "ACSA Code IDE native brand mark and system runtime.",
    component: IdeBrandLogo,
    aliases: ["acsa", "acsa-code", "ide", "workbench"],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    domain: "openai.com",
    category: "frontier",
    primaryColor: "#10A37F",
    description: "Frontier research lab behind GPT-5.5, GPT-5.4, o3, and Codex.",
    component: OpenAiLogo,
    aliases: ["openai", "chatgpt", "gpt", "codex", "dall-e", "o1", "o3", "whisper"],
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    domain: "anthropic.com",
    category: "frontier",
    primaryColor: "#D97757",
    description: "AI safety and frontier research lab, creators of Claude Fable 5.1 & Opus 5.",
    component: ClaudeLogo,
    aliases: ["anthropic", "claude", "sonnet", "haiku", "opus"],
  },
  google: {
    id: "google",
    name: "Google Gemini",
    domain: "google.com",
    category: "frontier",
    primaryColor: "#1A73E8",
    description: "Google DeepMind frontier multimodal models (Gemini 3.8 Flash & Pro).",
    component: GeminiLogo,
    aliases: ["google", "gemini", "deepmind", "gemma", "bard"],
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    domain: "gemini.google.com",
    category: "frontier",
    primaryColor: "#1A73E8",
    description: "Google DeepMind frontier multimodal models (Gemini 3.8 Flash & Pro).",
    component: GeminiLogo,
    aliases: ["gemini", "google", "deepmind", "gemma", "bard"],
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    domain: "deepseek.com",
    category: "open-source",
    primaryColor: "#4D6BFE",
    description: "Open-weights frontier reasoning models (DeepSeek-V4-Pro & Flash).",
    component: DeepSeekLogo,
    aliases: ["deepseek", "deepseek-chat", "deepseek-reasoner", "deepseek-coder", "deepseek-r1", "r1"],
  },
  meta: {
    id: "meta",
    name: "Meta / Llama",
    domain: "meta.com",
    category: "open-source",
    primaryColor: "#0866FF",
    description: "Open-weights frontier model family (Llama 3.1, 3.2, 3.3).",
    component: MetaLogo,
    aliases: ["meta", "llama", "llama2", "llama3", "llama-3", "facebook"],
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    domain: "mistral.ai",
    category: "frontier",
    primaryColor: "#FF7000",
    description: "European frontier lab, creators of Mistral Large 3 & Devstral.",
    component: MistralLogo,
    aliases: ["mistral", "codestral", "mixtral", "pixtral", "ministral"],
  },
  groq: {
    id: "groq",
    name: "Groq",
    domain: "groq.com",
    category: "cloud",
    primaryColor: "#F55036",
    description: "Ultra-high-speed LPU inference engine for instant tokens.",
    component: GroqLogo,
    aliases: ["groq", "groq-cloud"],
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    domain: "nvidia.com",
    category: "cloud",
    primaryColor: "#76B900",
    description: "NVIDIA's hosted inference microservices, including a free tier of OpenAI-compatible endpoints.",
    component: NvidiaLogo,
    aliases: ["nvidia", "nvidia-nim", "nim", "integrate.api.nvidia.com"],
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    domain: "ollama.ai",
    category: "local",
    primaryColor: "#FFFFFF",
    description: "Local model execution framework for private, offline intelligence.",
    component: OllamaLogo,
    aliases: ["ollama", "localhost:11434", "127.0.0.1:11434"],
  },
  cohere: {
    id: "cohere",
    name: "Cohere",
    domain: "cohere.com",
    category: "frontier",
    primaryColor: "#D07A60",
    description: "Enterprise foundation models and multilingual retrieval intelligence (Command R+).",
    component: CohereLogo,
    aliases: ["cohere", "command-r", "command-r-plus", "command"],
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity AI",
    domain: "perplexity.ai",
    category: "frontier",
    primaryColor: "#20808D",
    description: "Live web citation and conversational search intelligence (Sonar).",
    component: PerplexityLogo,
    aliases: ["perplexity", "pplx", "sonar"],
  },
  huggingface: {
    id: "huggingface",
    name: "Hugging Face",
    domain: "huggingface.co",
    category: "open-source",
    primaryColor: "#FFD21E",
    description: "The AI community building the future of open models and datasets.",
    component: HuggingFaceLogo,
    aliases: ["huggingface", "hf", "huggingface.co", "hugging_face"],
  },
  xai: {
    id: "xai",
    name: "xAI",
    domain: "x.ai",
    category: "frontier",
    primaryColor: "#FFFFFF",
    description: "Frontier mathematical and reasoning lab behind Grok-3.",
    component: XAiLogo,
    aliases: ["xai", "grok", "x.ai"],
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot AI / Kimi",
    domain: "moonshot.cn",
    category: "frontier",
    primaryColor: "#007AFF",
    description: "Ultra-long context frontier Chinese intelligence (Kimi k1.5).",
    component: MoonshotLogo,
    aliases: ["moonshot", "kimi", "moonshot-ai", "kimi.ai"],
  },
  qwen: {
    id: "qwen",
    name: "Qwen / Alibaba Cloud",
    domain: "alibabacloud.com",
    category: "frontier",
    primaryColor: "#615ced",
    description: "Multilingual frontier reasoning & coding models (Qwen 2.5 Coder).",
    component: QwenLogo,
    aliases: ["qwen", "alibaba", "aliyun", "tongyi"],
  },
  together: {
    id: "together",
    name: "Together AI",
    domain: "together.ai",
    category: "cloud",
    primaryColor: "#0F6FFF",
    description: "High-performance decentralized cloud inference and fine-tuning cluster.",
    component: TogetherLogo,
    aliases: ["together", "together-ai", "together.xyz"],
  },
  replicate: {
    id: "replicate",
    name: "Replicate",
    domain: "replicate.com",
    category: "cloud",
    primaryColor: "#FFFFFF",
    description: "Run open-source machine learning models with a cloud API.",
    component: ReplicateLogo,
    aliases: ["replicate", "replicate.com"],
  },
  scale: {
    id: "scale",
    name: "Scale AI",
    domain: "scale.com",
    category: "platform",
    primaryColor: "#EC4899",
    description: "Data infrastructure and frontier model fine-tuning platform (SEAL).",
    component: ScaleLogo,
    aliases: ["scale", "scale-ai", "scale.com"],
  },
  elevenlabs: {
    id: "elevenlabs",
    name: "ElevenLabs",
    domain: "elevenlabs.io",
    category: "specialized",
    primaryColor: "#FFFFFF",
    description: "Voice synthesis, generative speech audio, and sound effects intelligence.",
    component: ElevenLabsLogo,
    aliases: ["elevenlabs", "eleven-labs", "elevenlabs.io"],
  },
  stability: {
    id: "stability",
    name: "Stability AI",
    domain: "stability.ai",
    category: "specialized",
    primaryColor: "#8B5CF6",
    description: "Open generative visual models behind Stable Diffusion 3.5.",
    component: StabilityLogo,
    aliases: ["stability", "stable-diffusion", "stability.ai"],
  },
  midjourney: {
    id: "midjourney",
    name: "Midjourney",
    domain: "midjourney.com",
    category: "specialized",
    primaryColor: "#FFFFFF",
    description: "Hyper-creative generative imagery exploration studio.",
    component: MidjourneyLogo,
    aliases: ["midjourney", "midjourney.com"],
  },
  runway: {
    id: "runway",
    name: "Runway",
    domain: "runwayml.com",
    category: "specialized",
    primaryColor: "#10B981",
    description: "Generative video intelligence studio behind Gen-3 Alpha.",
    component: RunwayLogo,
    aliases: ["runway", "runwayml", "runwayml.com"],
  },
  databricks: {
    id: "databricks",
    name: "Databricks",
    domain: "databricks.com",
    category: "cloud",
    primaryColor: "#FF3621",
    description: "Data intelligence platform and creators of DBRX open architecture.",
    component: DatabricksLogo,
    aliases: ["databricks", "dbrx", "databricks.com"],
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    domain: "github.com",
    category: "platform",
    primaryColor: "#A371F7",
    description: "Cloud pair programming service powered by GitHub and OpenAI.",
    component: CopilotLogo,
    aliases: ["copilot", "github-copilot"],
  },
  github: {
    id: "github",
    name: "GitHub",
    domain: "github.com",
    category: "platform",
    primaryColor: "#A371F7",
    description: "Code hosting and developer collaboration platform.",
    component: GithubLogo,
    aliases: ["github", "github.com"],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    domain: "openrouter.ai",
    category: "cloud",
    primaryColor: "#6366F1",
    description: "Unified routing gateway delivering transparent pricing across frontier models.",
    component: OpenRouterLogo,
    aliases: ["openrouter", "openrouter.ai"],
  },
  cognition: {
    id: "cognition",
    name: "Cognition AI",
    domain: "cognition.ai",
    category: "specialized",
    primaryColor: "#38BDF8",
    description: "Applied AI lab behind Devin, the first autonomous software engineer.",
    component: CognitionLogo,
    aliases: ["cognition", "devin", "cognition.ai"],
  },
  ai21: {
    id: "ai21",
    name: "AI21 Labs",
    domain: "ai21.com",
    category: "frontier",
    primaryColor: "#8B5CF6",
    description: "Frontier enterprise models and creators of the Jamba hybrid SSM-transformer architecture.",
    component: Ai21Logo,
    aliases: ["ai21", "ai21-labs", "jamba", "ai21.com"],
  },
  pinecone: {
    id: "pinecone",
    name: "Pinecone",
    domain: "pinecone.io",
    category: "platform",
    primaryColor: "#10B981",
    description: "Specialized cloud vector database for fast similarity search and AI memory.",
    component: PineconeLogo,
    aliases: ["pinecone", "pinecone-io", "pinecone.io"],
  },
  character: {
    id: "character",
    name: "Character.AI",
    domain: "character.ai",
    category: "cloud",
    primaryColor: "#3B82F6",
    description: "Conversational open-ended dialogue and personalized interactive agents.",
    component: CharacterAiLogo,
    aliases: ["character", "character-ai", "characterai", "c.ai", "character.ai"],
  },
  inflection: {
    id: "inflection",
    name: "Inflection AI",
    domain: "inflection.ai",
    category: "frontier",
    primaryColor: "#10B981",
    description: "Empathetic conversational intelligence studio and creators of Pi.",
    component: InflectionLogo,
    aliases: ["inflection", "inflection-ai", "pi", "pi-ai", "inflection.ai"],
  },
  poolside: {
    id: "poolside",
    name: "Poolside",
    domain: "poolside.ai",
    category: "frontier",
    primaryColor: "#06B6D4",
    description: "Foundation models purpose-built for software engineering and code intelligence.",
    component: PoolsideLogo,
    aliases: ["poolside", "poolside-ai", "poolside.ai"],
  },
  luma: {
    id: "luma",
    name: "Luma AI",
    domain: "luma.ai",
    category: "specialized",
    primaryColor: "#F43F5E",
    description: "Multimodal generative video and 3D visual intelligence (Dream Machine).",
    component: LumaLogo,
    aliases: ["luma", "luma-ai", "dream-machine", "lumalabs", "luma.ai"],
  },
  deterministic: {
    id: "deterministic",
    name: "Deterministic AST",
    domain: "offline.internal",
    category: "local",
    primaryColor: "#10B981",
    description: "Zero-latency offline AST synthesis and rule-based code transformations.",
    component: DeterministicLogo,
    aliases: ["deterministic", "ast", "offline"],
  },
};

/**
 * Resolves any provider ID, model identifier, custom endpoint URL, or alias
 * into a canonical brand key registered in AI_BRAND_REGISTRY and BRAND_LOGO_URLS.
 */
export function resolveBrandId(providerOrModel: string): string {
  const p = (providerOrModel || "").toLowerCase().trim();
  if (!p) return "deterministic";

  // 1. Exact match in registry by ID or exact domain/alias
  if (AI_BRAND_REGISTRY[p]) return p;
  for (const item of Object.values(AI_BRAND_REGISTRY)) {
    if (
      item.domain.toLowerCase() === p ||
      item.aliases.some((a) => a.toLowerCase() === p)
    ) {
      return item.id;
    }
  }

  // 2. URL / Domain Normalization
  let lookup = p;
  if (lookup.includes("://") || lookup.includes("/")) {
    try {
      const urlStr = lookup.includes("://") ? lookup : `https://${lookup}`;
      const parsed = new URL(urlStr);
      lookup = parsed.hostname.toLowerCase();
    } catch {}
  }

  if (AI_BRAND_REGISTRY[lookup]) return lookup;
  for (const item of Object.values(AI_BRAND_REGISTRY)) {
    if (
      item.domain.toLowerCase() === lookup ||
      lookup.endsWith("." + item.domain.toLowerCase()) ||
      item.aliases.some((a) => a.toLowerCase() === lookup)
    ) {
      return item.id;
    }
  }

  // 3. Model Name & Substring Fingerprinting
  if (
    p.includes("claude") ||
    p.includes("anthropic") ||
    p.includes("sonnet") ||
    p.includes("haiku") ||
    p.includes("opus")
  ) {
    return "claude";
  }
  if (
    p.includes("openai") ||
    p.includes("chatgpt") ||
    p.includes("codex") ||
    p.includes("dall-e") ||
    p.includes("whisper") ||
    hasToken(p, "gpt") ||
    hasToken(p, "gpt-4") ||
    hasToken(p, "gpt-4o") ||
    hasToken(p, "gpt-3") ||
    hasToken(p, "gpt-5") ||
    /(?:^|[-_/.:])o[134](?:-mini|-preview|[-_/.:]|$)/i.test(p)
  ) {
    return "openai";
  }
  // Google Gemini should ALWAYS resolve to gemini to render gemini.svg
  if (
    p.includes("gemini") ||
    p.includes("google") ||
    p.includes("gemma") ||
    p.includes("deepmind") ||
    p.includes("bard")
  ) {
    return "gemini";
  }
  if (p.includes("deepseek")) {
    return "deepseek";
  }
  if (p.includes("llama") || p.includes("meta")) {
    return "meta";
  }
  if (
    p.includes("mistral") ||
    p.includes("codestral") ||
    p.includes("mixtral") ||
    p.includes("pixtral") ||
    p.includes("ministral")
  ) {
    return "mistral";
  }
  if (p.includes("groq")) {
    return "groq";
  }
  if (p.includes("ollama")) {
    return "ollama";
  }
  if (p.includes("cohere") || p.includes("command-r") || p.includes("command") || hasToken(p, "aya")) {
    return "cohere";
  }
  if (p.includes("perplexity") || p.includes("sonar") || hasToken(p, "pplx")) {
    return "perplexity";
  }
  if (p.includes("huggingface") || p.includes("hugging_face") || hasToken(p, "hf")) {
    return "huggingface";
  }
  if (p.includes("xai") || p.includes("grok") || p.includes("x.ai")) {
    return p.includes("grok") ? "grok" : "xai";
  }
  if (p.includes("moonshot") || p.includes("kimi")) {
    return "moonshot";
  }
  if (p.includes("qwen") || p.includes("alibaba") || p.includes("aliyun") || p.includes("tongyi")) {
    return "qwen";
  }
  if (p.includes("together")) {
    return "together";
  }
  if (p.includes("replicate")) {
    return "replicate";
  }
  if (hasToken(p, "scale") || p.includes("scale-ai") || p.includes("scaleai")) {
    return "scale";
  }
  if (p.includes("elevenlabs") || p.includes("eleven-labs")) {
    return "elevenlabs";
  }
  if (p.includes("stability") || p.includes("stable-diffusion")) {
    return "stability";
  }
  if (p.includes("midjourney")) {
    return "midjourney";
  }
  if (p.includes("runway") || p.includes("runwayml")) {
    return "runway";
  }
  if (p.includes("databricks") || p.includes("dbrx")) {
    return "databricks";
  }
  if (p.includes("copilot") || p.includes("github-copilot")) {
    return "copilot";
  }
  if (p.includes("github")) {
    return "github";
  }
  if (p.includes("openrouter")) {
    return "openrouter";
  }
  if (p.includes("cognition") || p.includes("devin")) {
    return "cognition";
  }
  if (p.includes("ai21") || p.includes("jamba")) {
    return "ai21";
  }
  if (p.includes("pinecone")) {
    return "pinecone";
  }
  if (p.includes("character")) {
    return "character";
  }
  if (p.includes("inflection") || hasToken(p, "pi")) {
    return "inflection";
  }
  if (p.includes("poolside")) {
    return "poolside";
  }
  if (p.includes("luma")) {
    return "luma";
  }
  if (p.includes("acsa") || p.includes("workbench")) {
    return "acsa";
  }

  return "deterministic";
}

/**
 * Retrieve metadata for an AI brand by ID, alias, or domain.
 */
export function getBrandMetadata(idOrAliasOrUrl: string): AIBrandMetadata | undefined {
  const p = (idOrAliasOrUrl || "").toLowerCase().trim();
  if (!p) return undefined;

  // 1. Direct ID match
  if (AI_BRAND_REGISTRY[p]) return AI_BRAND_REGISTRY[p];

  // 2. Direct alias match
  for (const item of Object.values(AI_BRAND_REGISTRY)) {
    if (item.aliases.some((a) => a.toLowerCase() === p)) {
      return item;
    }
  }

  // 3. URL parsing & domain lookup
  if (p.includes("://") || p.includes("/")) {
    try {
      const urlStr = p.includes("://") ? p : `https://${p}`;
      const parsed = new URL(urlStr);
      const hostname = parsed.hostname.toLowerCase();
      if (AI_BRAND_REGISTRY[hostname]) return AI_BRAND_REGISTRY[hostname];
      for (const item of Object.values(AI_BRAND_REGISTRY)) {
        if (
          item.domain.toLowerCase() === hostname ||
          hostname.endsWith("." + item.domain.toLowerCase()) ||
          item.aliases.some((a) => a.toLowerCase() === hostname)
        ) {
          return item;
        }
      }
    } catch {}
  }

  // 4. Subdomain lookup
  for (const item of Object.values(AI_BRAND_REGISTRY)) {
    if (p.endsWith("." + item.domain.toLowerCase())) {
      return item;
    }
  }

  return undefined;
}
