/**
 * systemMetricsService.ts — Central System Telemetry Service
 *
 * Single source of truth for host CPU, RAM, and Disk metrics across the IDE.
 * The status bar and the Performance page both read from here, so the two can
 * never disagree about what the machine is doing.
 */

import type { SystemMetrics } from "../types/telemetry";

type MetricsListener = (metrics: SystemMetrics) => void;

class SystemMetricsService {
  private currentMetrics: SystemMetrics | null = null;
  private listeners = new Set<MetricsListener>();
  private timer: any = null;
  private isFetching = false;
  private lastFetchSucceeded = false;

  constructor() {
    this.startPolling(3000);
  }

  private isTauriAvailable(): boolean {
    return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
  }

  public getMetrics(): SystemMetrics | null {
    return this.currentMetrics;
  }

  /**
   * The engine's own versions, read once and kept.
   *
   * `python_version` cannot come from the shell: a packaged build carries an
   * embedded interpreter, so asking the machine for `python3 --version` reports a
   * version this app may not use, or nothing at all. The engine is the only part
   * that knows. `node_version` is the Node an npx-based MCP server would get —
   * this app does not run on Node, but it does hand work to it. `vite_version` is a
   * build-time constant, which is why it is read from the bundle rather than asked
   * of any process. All three change when the app is updated, not between samples,
   * so one read is enough and polling for them would be noise.
   */
  private runtimeVersions: Partial<SystemMetrics> | null = null;

  private async loadRuntimeVersions(): Promise<Partial<SystemMetrics>> {
    if (this.runtimeVersions) return this.runtimeVersions;

    let engine: { python?: string; node?: string } = {};
    try {
      const { engineCall } = await import("./engineBridge");
      engine = await engineCall<{ python?: string; node?: string }>("support", ["versions"]);
    } catch {
      // Best effort: the panel shows a dash for anything it does not have.
    }

    this.runtimeVersions = {
      python_version: engine?.python ?? "",
      node_version: engine?.node ?? "",
      vite_version: typeof __ACSA_VITE_VERSION__ === "string" ? __ACSA_VITE_VERSION__ : "",
    };
    return this.runtimeVersions;
  }

  public isHealthy(): boolean {
    return this.lastFetchSucceeded;
  }

  public subscribe(listener: MetricsListener): () => void {
    this.listeners.add(listener);
    if (this.currentMetrics) {
      try {
        listener(this.currentMetrics);
      } catch (err) {
        console.error("Error in initial metrics listener call:", err);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    if (!this.currentMetrics) return;
    for (const listener of this.listeners) {
      try {
        listener(this.currentMetrics);
      } catch (err) {
        console.error("Error notifying metrics listener:", err);
      }
    }
  }

  public async fetchMetrics(): Promise<SystemMetrics | null> {
    if (this.isFetching) return this.currentMetrics;
    this.isFetching = true;

    try {
      if (this.isTauriAvailable()) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const metrics = await invoke<SystemMetrics>("fetch_system_metrics");
          if (metrics) {
            // Merged rather than replaced: the shell reports the machine, the
            // engine reports what this app runs on, and the panel shows both.
            // Returning the merged value, not `metrics` — returning the raw one
            // gave callers an object without the versions in it, while the state
            // they read next had them, so the two disagreed by construction.
            this.currentMetrics = { ...metrics, ...(await this.loadRuntimeVersions()) };
            this.lastFetchSucceeded = true;
            this.notify();
            return this.currentMetrics;
          }
        } catch (tauriErr) {
          console.warn("Tauri fetch_system_metrics failed, falling back to HTTP:", tauriErr);
        }
      }

    } catch (err) {
      this.lastFetchSucceeded = false;
      console.warn("Failed to fetch system metrics:", err);
    } finally {
      this.isFetching = false;
    }

    return this.currentMetrics;
  }

  public startPolling(intervalMs: number = 3000) {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.fetchMetrics();
    this.timer = setInterval(() => {
      this.fetchMetrics();
    }, intervalMs);
  }

  public stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const systemMetricsService = new SystemMetricsService();
