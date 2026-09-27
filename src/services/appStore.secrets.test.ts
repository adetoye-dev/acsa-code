import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credentials do not go through the engine.
 *
 * That is the point of moving them to the OS keychain: the engine has no keychain,
 * and a credential it never receives cannot be left in its `0600` database. These
 * pin the routing, because the failure mode is silent — an engine route that still
 * works would keep writing the key to the plaintext file while looking correct.
 */
const engineCalls: Array<{ subcommand: string; args: string[] }> = [];
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];

vi.mock("./engineBridge", () => ({
  hasIpc: () => true,
  DESKTOP_REQUIRED_MESSAGE: "needs the desktop app",
  engineCall: async (subcommand: string, args: string[] = []) => {
    engineCalls.push({ subcommand, args });
    return {};
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    invokeCalls.push({ command, args });
    return {};
  },
}));

const { appStore } = await import("./appStore");

beforeEach(() => {
  engineCalls.length = 0;
  invokeCalls.length = 0;
});

describe("the credentials API", () => {
  it("stores a new key in the keychain and never in the engine", async () => {
    await appStore.setSecret("deepseek_api_key", "sk-live");
    expect(invokeCalls).toEqual([
      { command: "secrets_set", args: { name: "deepseek_api_key", value: "sk-live" } },
    ]);
    expect(engineCalls).toEqual([]);
  });

  it("removes a key from the keychain and never from the engine alone", async () => {
    await appStore.clearSecret("deepseek_api_key");
    expect(invokeCalls).toEqual([
      { command: "secrets_delete", args: { name: "deepseek_api_key" } },
    ]);
    expect(engineCalls).toEqual([]);
  });

  it("asks the shell which names are configured, because the engine cannot know", async () => {
    await appStore.listSecretNames();
    expect(invokeCalls).toEqual([{ command: "secrets_list", args: {} }]);
    expect(engineCalls).toEqual([]);
  });
});
