import { beforeEach, describe, expect, it, vi } from "vitest";

const engineCalls: Array<{ subcommand: string; args: string[] }> = [];
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
let ipc = true;
let picker: string | null = null;
let pickerThrows = false;
let engineThrows = false;
let includeSecrets = false;
let secretsRemoved = 2;

vi.mock("./engineBridge", () => ({
  hasIpc: () => ipc,
  DESKTOP_REQUIRED_MESSAGE: "needs the desktop app",
  engineCall: async (subcommand: string, args: string[] = []) => {
    engineCalls.push({ subcommand, args });
    if (engineThrows) throw new Error("engine unavailable");
    if (subcommand === "db") return { dataDir: "/data/dir", dbPath: "/data/dir/app.db" };
    if (subcommand === "backup" && args[0] === "export") {
      return { secretsIncluded: includeSecrets, secretsRemoved };
    }
    if (subcommand === "backup") return { previousKeptAt: "/data/dir/app.db.before-import" };
    return { path: args[1], bytes: 42 };
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    invokeCalls.push({ command, args });
    if (pickerThrows) throw new Error("osascript died");
    return picker;
  },
}));

const {
  backupFileName,
  supportFileName,
  exportBackup,
  importBackup,
  createSupportBundle,
  revealDataFolder,
  dataFolderInfo,
} = await import("./backupRestore");

beforeEach(() => {
  engineCalls.length = 0;
  invokeCalls.length = 0;
  ipc = true;
  picker = null;
  pickerThrows = false;
  engineThrows = false;
  includeSecrets = false;
  secretsRemoved = 2;
});

describe("the suggested names", () => {
  it("sorts by when the backup was taken", () => {
    const day = new Date("2026-09-18T12:00:00Z");
    expect(backupFileName(day)).toBe("acsa-backup-2026-09-18.db");
    expect(supportFileName(day)).toBe("acsa-support-2026-09-18.json");
  });
});

describe("exporting a backup", () => {
  it("writes to the path the user picked, through the engine", async () => {
    picker = "/Users/me/Desktop/acsa-backup.db";
    const outcome = await exportBackup();

    expect(invokeCalls[0].command).toBe("pick_save_file");
    // The name is generated from today's date, so only the shape is stable.
    expect(String(invokeCalls[0].args.defaultName)).toMatch(/^acsa-backup-\d{4}-\d{2}-\d{2}\.db$/);
    expect(engineCalls).toEqual([
      { subcommand: "backup", args: ["export", "/Users/me/Desktop/acsa-backup.db"] },
    ]);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.detail).toContain("without API keys");
  });

  it("says so when the file does contain keys", async () => {
    // Not an error — a full migration export is legitimate. It just must not
    // look identical to the safe one.
    picker = "/tmp/full.db";
    includeSecrets = true;
    const outcome = await exportBackup();
    if (outcome.kind === "done") expect(outcome.detail).toContain("somewhere private");
  });

  it("treats a closed picker as a decision, not a failure", async () => {
    picker = null;
    const outcome = await exportBackup();
    expect(outcome.kind).toBe("cancelled");
    expect(engineCalls).toHaveLength(0);
  });

  it("reports a picker that blew up instead of swallowing it", async () => {
    pickerThrows = true;
    const outcome = await exportBackup();
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.detail).toContain("osascript died");
  });

  it("refuses politely without the desktop app", async () => {
    ipc = false;
    const outcome = await exportBackup();
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.detail).toContain("desktop app");
  });
});

describe("importing a backup", () => {
  it("tells the user to restart, because the running app still holds the old data", async () => {
    picker = "/tmp/old.db";
    const outcome = await importBackup();
    expect(engineCalls[0]).toEqual({ subcommand: "backup", args: ["import", "/tmp/old.db"] });
    if (outcome.kind === "done") expect(outcome.detail).toMatch(/restart/i);
  });

  it("surfaces an engine rejection", async () => {
    picker = "/tmp/junk.db";
    engineThrows = true;
    const outcome = await importBackup();
    expect(outcome.kind).toBe("failed");
  });
});

describe("the support bundle", () => {
  it("goes through the support subcommand, not backup", async () => {
    picker = "/tmp/acsa-support.json";
    const outcome = await createSupportBundle();
    expect(engineCalls[0]).toEqual({
      subcommand: "support",
      args: ["bundle", "/tmp/acsa-support.json"],
    });
    if (outcome.kind === "done") expect(outcome.path).toBe("/tmp/acsa-support.json");
  });
});

describe("revealing the data folder", () => {
  it("asks the engine where the data is, then reveals that exact path", async () => {
    const outcome = await revealDataFolder();
    expect(engineCalls[0]).toEqual({ subcommand: "db", args: ["info"] });
    expect(invokeCalls[0]).toEqual({ command: "reveal_path", args: { path: "/data/dir" } });
    expect(outcome.kind).toBe("done");
  });

  it("returns null for the path readout instead of an error box when there is no app", async () => {
    ipc = false;
    expect(await dataFolderInfo()).toBeNull();
  });
});

/**
 * Once credentials live in the OS keychain, an export has nothing to strip — so the
 * count reaches zero, and "(0 removed)" reads as a bug rather than as the truth.
 * What matters is that a user does not walk away believing their keys are inside a
 * file that has none.
 */
describe("a backup taken once credentials live in the keychain", () => {
  it("says where the keys are, rather than reporting zero removals", async () => {
    picker = "/tmp/after-keychain.db";
    secretsRemoved = 0;
    const outcome = await exportBackup();
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") {
      expect(outcome.detail).toContain("without API keys");
      expect(outcome.detail).toContain("keychain");
      expect(outcome.detail).not.toContain("(0 removed)");
    }
  });
});
