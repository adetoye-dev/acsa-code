/**
 * workbench.ts — Unified Workbench Types for ACSA Code
 */

import type { FileNode } from "../components/FileTree";
import type { SystemMetrics } from "./telemetry";

export type { FileNode, SystemMetrics };

export interface OpenFileTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
}

export interface SecurityStatus {
  passed: boolean;
  checks: {
    name: string;
    status: "pass" | "fail" | "warn";
    message: string;
  }[];
}

export type AIProviderId =
  | "ollama"
  | "openai"
  | "groq"
  | "deepseek"
  | "nvidia"
  | "google"
  | "xai"
  | "moonshot"
  | "cohere"
  | "together"
  | "openrouter";

export type ModelCapability = "autocomplete" | "reasoning" | "code" | "chat" | "vision" | "embedding";

export interface AIProviderConfig {
  id: AIProviderId;
  name: string;
  category: "local" | "cloud";
  isConnected: boolean;
  isDefault: boolean;
  apiKey: string;
  baseUrl: string;
  selectedModel: string;
  availableModels: string[];
  speedBadge?: "Fast" | "Medium" | "Thinking" | "Offline";
  latencyMs?: number;
  capabilities?: ModelCapability[];
}

export interface StorageCategory {
  id: string;
  name: string;
  objects: number;
  sizeMb: number;
  reclaimableMb: number;
}

export interface StorageMetrics {
  totalGb: number;
  freeGb: number;
  usedGb: number;
  usedPercent: number;
  buildArtifactsMb: number;
  cacheReclaimableMb: number;
  categories: StorageCategory[];
}

export interface RunningProcessItem {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
  status: string;
}
