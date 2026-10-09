// @vitest-environment jsdom
/**
 * The runtime line on the Performance panel read three fields nothing supplied:
 * `Node unknown · Vite unknown · Python unknown`, on every machine, forever.
 *
 * The Python version is the interesting one. It cannot come from the shell: a
 * packaged build carries an embedded interpreter, so asking the machine for
 * `python3 --version` answers with a version this app may not use, or with
 * nothing. The engine is the only part that knows, so the engine is what is asked
 * — once, because these change when the app is updated rather than between
 * samples.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  calls: 0,
  data: { python: "3.12.11", node: "22.14.0" } as Record<string, string>,
}));

vi.mock("./engineBridge", () => ({
  hasIpc: () => true,
  engineCall: async () => {
    engine.calls += 1;
    return engine.data;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => ({
    platform: "macos",
    architecture: "aarch64",
    cpu_count: 10,
    cpu_usage_percent: 12.4,
    memory_used_mb: 6600,
    memory_total_mb: 16000,
    memory_usage_percent: 41.2,
    is_thermal_risk: false,
    thermal_warning: "",
    disk_usage_percent: 63,
    disk_used_gb: 590,
    disk_total_gb: 926,
    disk_free_gb: 336,
    timestamp_ms: 1,
  }),
}));

const { systemMetricsService } = await import("./systemMetricsService");

afterEach(() => {
  systemMetricsService.stopPolling();
});

describe("the metrics the panel reads", () => {
  it("carries the engine's versions, and asks for them once", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};

    const first = await systemMetricsService.fetchMetrics();
    const second = await systemMetricsService.fetchMetrics();

    expect(first?.python_version).toBe("3.12.11");
    expect(first?.node_version).toBe("22.14.0");
    // The machine's own numbers still come through beside them.
    expect(first?.cpu_count).toBe(10);

    // Kept, not re-read: the second sample reuses them.
    expect(second?.python_version).toBe("3.12.11");
    expect(engine.calls).toBe(1);
  });
});
