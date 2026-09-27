/**
 * marketplace.ts — Skill / Tooling / MCP marketplace
 *
 * Curated, installable open-source capabilities for the ACSA harness:
 *  - Skills: markdown SKILL.md files written to .acsa/skills and picked up by
 *    the Python engine's skill_loader (instructions, review playbooks).
 *  - MCP servers: standard Model Context Protocol server configs written to
 *    .acsa/mcp.json, consumable by the engine's MCP client.
 */

import { marketplaceFetch } from "./marketplaceClient";

export type MarketplaceKind = "skill" | "mcp";
export type MarketplaceDomain =
  | "coding"
  | "security"
  | "design"
  | "memory"
  | "research"
  | "testing"
  | "tooling";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MarketplaceItem {
  id: string;
  name: string;
  kind: MarketplaceKind;
  domain: MarketplaceDomain;
  description: string;
  author: string;
  /**
   * How much the entry should be trusted, shown as a badge. "built-in" ships
   * with ACSA, "official" is the upstream publisher/maintainer, "community" is
   * third-party.
   */
  trust: MarketplaceTrust;
  /** Real, clickable links — a marketplace entry without a source is useless. */
  repo?: string;
  homepage?: string;
  docs?: string;
  license?: string;
  version?: string;
  /** Longer explanation shown in the detail view. */
  overview?: string;
  /** What this can do on the machine, shown before install. */
  permissions?: string[];
  /**
   * The mark to show, where one honestly exists: the tool's own logo for a server
   * that *is* a known tool (git, Playwright, Chrome), the publisher's for the
   * reference servers (Anthropic ships them), and ours for our own skills. Left
   * unset rather than filled with an invented logo.
   */
  logo?: { kind: "tech" | "brand" | "acsa"; id: string };
  /** Legacy field kept for display of the raw source string. */
  source: string;
  tags: string[];
  /** SKILL.md body for skills (frontmatter is added on install if absent). */
  skillContent?: string;
  /** MCP server launch config. */
  mcpConfig?: McpServerConfig;
  /** Runtime the item needs. */
  requires?: string;
}

export type MarketplaceTrust = "built-in" | "official" | "community";

export const TRUST_LABEL: Record<MarketplaceTrust, string> = {
  "built-in": "Built-in",
  official: "Official",
  community: "Community",
};

/**
 * Where an install writes, and for MCP servers exactly what will run. Surfaced
 * before the user commits, because installing a server means executing a
 * third-party command on this machine.
 */
export function installTarget(
  item: MarketplaceItem,
  projectRoot: string
): { path: string; command: string } {
  const root = (projectRoot || ".").replace(/[\\/]+$/, "");
  if (item.kind === "skill") {
    return { path: `${root}/.acsa/skills/${item.id}.md`, command: "" };
  }
  const config = item.mcpConfig || { command: "", args: [] };
  return {
    path: `${root}/.acsa/mcp.json`,
    command: [config.command, ...(config.args || [])].join(" "),
  };
}

/** Places to find more capabilities, linked from the marketplace. */
export const ECOSYSTEM_LINKS: Array<{ label: string; url: string; note: string }> = [
  {
    label: "MCP server registry",
    url: "https://github.com/modelcontextprotocol/servers",
    note: "The official catalogue of Model Context Protocol servers.",
  },
  {
    label: "MCP documentation",
    url: "https://modelcontextprotocol.io",
    note: "Protocol spec, SDKs and transport details.",
  },
  {
    label: "Agent Skills (Anthropic)",
    url: "https://github.com/anthropics/skills",
    note: "Reference SKILL.md packs you can adapt for this harness.",
  },
];

const SKILL_CODE_REVIEW = `# Code Review

Review the code you are given as a meticulous senior engineer.

Focus, in order:
1. Correctness bugs, off-by-one errors, wrong comparisons, unhandled edge cases.
2. Error handling: swallowed exceptions, missing validation, unsafe assumptions.
3. Security: injection, unsafe deserialisation, secrets in source, unsafe file/network access.
4. Concurrency and resource leaks (unclosed handles, unbounded growth).
5. Naming, dead code, and duplication that hurts maintenance.

For every finding give: the file and line, the concrete problem, and a specific fix.
Prefer the smallest change that fixes the real problem. Never rewrite a whole file
when a focused edit is enough.`;

const SKILL_SECURITY_AUDIT = `# Security Audit

Audit the target code for exploitable weaknesses:
- Input handling: injection (SQL/command/template), path traversal, SSRF.
- Unsafe primitives: eval/exec/pickle, shell=True, unsanitised HTML.
- Secrets: hardcoded keys/tokens, credentials in logs.
- AuthZ/AuthN gaps, missing rate limits, permissive CORS.
- Dependency risk from unpinned or abandoned packages.

Report each issue with severity (critical/high/medium/low), the exact location,
a minimal proof of exploitability, and a concrete remediation. Rank by exploitability
against the actual entry points, not by theoretical severity alone.`;

const SKILL_DESIGN_REVIEW = `# Design Review

Evaluate interfaces and UI for clarity and usability:
- Visual hierarchy: is the primary action obvious? Are metrics labelled with units?
- Consistency: spacing, typography and colour used the same way across screens.
- Accessibility: contrast, focus states, keyboard reachability, screen-reader labels.
- Empty, loading and error states for every data-driven surface.
- Copy: specific, active voice, no filler.

Give prioritised, actionable changes; reference the component and line.`;

const SKILL_REFACTOR_PLAN = `# Refactor Plan

When asked to refactor:
1. State the concrete pain the refactor removes (coupling, duplication, unclear ownership).
2. Define the target shape before touching code.
3. Plan the change in small, independently verifiable steps.
4. Preserve behaviour: keep public interfaces stable unless explicitly told otherwise.
5. After each step, run the project's verification command.

Never mix a refactor with a behaviour change in the same step.`;

const SKILL_TEST_WRITER = `# Test Writer

Write tests that would actually catch regressions:
- One behaviour per test, named for the behaviour, not the implementation.
- Cover the happy path, boundaries (empty, max, off-by-one) and error paths.
- Prefer real objects to mocks; mock only I/O boundaries.
- Assert on observable outcomes, not internal calls.
- Reproduce any reported bug with a failing test before fixing it.

Use the project's existing test framework and conventions.`;

const SKILL_MEMORY_KEEPER = `# Memory Keeper

Maintain durable project memory.

After any non-trivial decision, append a concise entry to the project memory file
(.acsa/memory.md) with: date, decision, the alternatives considered, and the reason.
Before starting work, read that file so prior decisions are respected.

Keep entries short and factual. Never record secrets or credentials.`;

const SKILL_DOCS_WRITER = `# Docs Writer

Produce documentation a new engineer can act on:
- Lead with what the component does and when to use it.
- Show a minimal working example before exhaustive detail.
- Document inputs, outputs, errors and side effects precisely.
- Keep prose in the present tense and avoid marketing language.
- Update the README or the nearest existing doc rather than creating a parallel one.`;

const SKILL_PERF_TUNER = `# Performance Tuner

Optimise measured hot paths only:
1. Establish a baseline (time it, or count calls) before changing anything.
2. Identify the real bottleneck; do not guess.
3. Prefer algorithmic fixes over micro-optimisations.
4. Cache only where invalidation is provably correct.
5. Re-measure and report the before/after numbers.

Never trade correctness for speed.`;

export const MARKETPLACE_ITEMS: MarketplaceItem[] = [
  // ── Built-in (ships with ACSA, works offline) ───────────────────────────
  {
    id: "acsa-workspace",
    name: "ACSA Workspace",
    kind: "mcp",
    domain: "tooling",
    description:
      "Built-in read-only workspace tools (list_files, read_file, search_code). Runs offline with zero install.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    license: "Same as this project",
    tags: ["workspace", "search", "offline"],
    overview:
      "First-party server that exposes the open project to the agent as read-only tools. It needs no runtime, no network access and no credentials, which makes it the safest way to give the agent file access. Installed automatically with the app; remove it only if you do not want the agent reading your files.",
    permissions: [
      "Read files inside the currently open project only",
      "No network access",
      "No writes, no process execution",
    ],
    mcpConfig: { command: "python3", args: ["core-engine/mcp_servers/workspace_server.py"] },
    requires: "python3",
  },

  // ── Official MCP servers (modelcontextprotocol) ─────────────────────────
  {
    id: "mcp-filesystem",
    name: "Filesystem",
    kind: "mcp",
    domain: "tooling",
    description: "Scoped filesystem read/write tools from the official MCP reference set.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "brand", id: "anthropic" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    homepage: "https://modelcontextprotocol.io",
    docs: "https://github.com/modelcontextprotocol/servers#readme",
    license: "MIT",
    version: "latest",
    tags: ["files", "read", "write"],
    overview:
      "Gives the agent read/write access to the directories you pass it. The directory list is the security boundary — add only the folders the agent should touch, and prefer running it against the project root rather than your home directory.",
    permissions: [
      "Read and write files under the directories listed in the config",
      "Downloads the package from npm on first use (npx)",
    ],
    mcpConfig: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    requires: "npx",
  },
  {
    id: "mcp-memory",
    name: "Memory (knowledge graph)",
    kind: "mcp",
    domain: "memory",
    description: "Persistent knowledge-graph memory the agent can carry across sessions.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "brand", id: "anthropic" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    homepage: "https://modelcontextprotocol.io",
    license: "MIT",
    version: "latest",
    tags: ["memory", "graph", "context"],
    overview:
      "Stores entities, relations and observations in a local JSON knowledge graph so context survives between sessions. Useful for long-running projects where decisions and their rationale should not be re-derived every time.",
    permissions: [
      "Reads and writes a local memory file on disk",
      "Downloads the package from npm on first use (npx)",
    ],
    mcpConfig: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    requires: "npx",
  },
  {
    id: "mcp-sequential-thinking",
    name: "Sequential Thinking",
    kind: "mcp",
    domain: "tooling",
    description: "Structured step-by-step reasoning scaffold for hard, multi-step problems.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "brand", id: "anthropic" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    homepage: "https://modelcontextprotocol.io",
    license: "MIT",
    version: "latest",
    tags: ["reasoning", "planning"],
    overview:
      "Exposes a single tool that lets the model externalise a plan as numbered, revisable thoughts instead of holding it all in one pass. Cheap and side-effect free, and it noticeably helps small local models stay on task.",
    permissions: ["No filesystem access", "No network access"],
    mcpConfig: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    requires: "npx",
  },
  {
    id: "mcp-fetch",
    name: "Fetch (web)",
    kind: "mcp",
    domain: "research",
    description: "Fetch a URL and convert the page to markdown for grounded research.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "brand", id: "anthropic" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    homepage: "https://modelcontextprotocol.io",
    license: "MIT",
    version: "latest",
    tags: ["web", "research"],
    overview:
      "Lets the agent read a specific page you point it at, with the HTML converted to markdown so the content fits in context. It only fetches URLs the agent asks for — it is not a general crawler.",
    permissions: [
      "Makes outbound HTTP requests to URLs the agent chooses",
      "Downloads the package from PyPI on first use (uvx)",
    ],
    mcpConfig: { command: "uvx", args: ["mcp-server-fetch"] },
    requires: "uvx",
  },
  {
    id: "mcp-git",
    name: "Git (official)",
    kind: "mcp",
    domain: "tooling",
    description: "Read, search and change git repositories: log, diff, branch, commit.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "tech", id: "git" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    homepage: "https://modelcontextprotocol.io",
    license: "MIT",
    version: "latest",
    tags: ["git", "vcs", "tooling"],
    overview:
      "Lets the agent inspect history and make commits itself instead of shelling out for every step. It works on repositories you point it at, alongside the app's own Source Control page rather than instead of it.",
    permissions: [
      "Reads and writes git repositories the agent chooses",
      "Runs git commands on this machine",
      "Downloads the package from PyPI on first use (uvx)",
    ],
    mcpConfig: { command: "uvx", args: ["mcp-server-git"] },
    requires: "uvx",
  },
  {
    id: "mcp-time",
    name: "Time (official)",
    kind: "mcp",
    domain: "tooling",
    description: "Current time and timezone conversion, so \"tomorrow\" has a date.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "brand", id: "anthropic" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    homepage: "https://modelcontextprotocol.io",
    license: "MIT",
    version: "latest",
    tags: ["time", "tooling"],
    overview:
      "Gives the agent a clock and timezone arithmetic. Small, but it is the difference between a scheduled task that names a real date and one that guesses.",
    permissions: [
      "Reads the system clock and timezone database",
      "Downloads the package from PyPI on first use (uvx)",
    ],
    mcpConfig: { command: "uvx", args: ["mcp-server-time"] },
    requires: "uvx",
  },
  {
    id: "mcp-everything",
    name: "Everything (reference server)",
    kind: "mcp",
    domain: "tooling",
    description: "Reference server exercising prompts, resources and tools — useful for testing.",
    author: "modelcontextprotocol",
    trust: "official",
    logo: { kind: "brand", id: "anthropic" },
    source: "github.com/modelcontextprotocol/servers",
    repo: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
    homepage: "https://modelcontextprotocol.io",
    license: "MIT",
    version: "latest",
    tags: ["reference", "testing"],
    overview:
      "A deliberately broad reference server used to exercise every part of the protocol. Handy for verifying that this client can list tools and call them; not something you would keep enabled for real work.",
    permissions: [
      "Adds many demo tools and prompts to the model's context",
      "Downloads the package from npm on first use (npx)",
    ],
    mcpConfig: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
    requires: "npx",
  },

  // ── Third-party servers (well-known maintainers) ────────────────────────
  {
    id: "mcp-playwright",
    name: "Playwright (browser automation)",
    kind: "mcp",
    domain: "tooling",
    description: "Drive a real browser: navigate, click, fill forms and read the page.",
    author: "Microsoft",
    trust: "community",
    logo: { kind: "tech", id: "playwright" },
    source: "github.com/microsoft/playwright-mcp",
    repo: "https://github.com/microsoft/playwright-mcp",
    docs: "https://github.com/microsoft/playwright-mcp#readme",
    license: "Apache-2.0",
    version: "latest",
    tags: ["browser", "e2e", "automation"],
    overview:
      "Microsoft's Playwright MCP server gives the agent a scriptable browser, which is the reliable way to verify UI changes end to end instead of guessing from the source. It reuses your installed Playwright browsers.",
    permissions: [
      "Launches a local browser and can interact with any page it opens",
      "Makes network requests as part of browsing",
      "Downloads the package from npm on first use (npx)",
    ],
    mcpConfig: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    requires: "npx",
  },
  {
    id: "mcp-context7",
    name: "Context7 (up-to-date library docs)",
    kind: "mcp",
    domain: "research",
    description: "Pulls current, version-specific documentation for libraries and frameworks.",
    author: "Upstash",
    trust: "community",
    source: "github.com/upstash/context7",
    repo: "https://github.com/upstash/context7",
    homepage: "https://context7.com",
    license: "MIT",
    version: "latest",
    tags: ["docs", "research", "libraries"],
    overview:
      "Stops the model inventing APIs from stale training data by fetching versioned documentation for the libraries you actually use. One of the highest-value servers for coding work.",
    permissions: [
      "Makes outbound HTTP requests to context7.com",
      "Downloads the package from npm on first use (npx)",
    ],
    mcpConfig: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    requires: "npx",
  },
  {
    id: "mcp-chrome-devtools",
    name: "Chrome DevTools",
    kind: "mcp",
    domain: "testing",
    description: "Inspect a Chrome page: DOM, console output and network activity.",
    author: "Google",
    trust: "community",
    logo: { kind: "tech", id: "chrome" },
    source: "github.com/ChromeDevTools/chrome-devtools-mcp",
    repo: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp#readme",
    license: "Apache-2.0",
    version: "latest",
    tags: ["browser", "devtools", "debug"],
    overview:
      "Exposes Chrome DevTools capabilities over MCP so the agent can read console errors, network requests and the rendered DOM — the fastest way to diagnose a front-end bug that only shows up at runtime.",
    permissions: [
      "Launches/attaches to Chrome and reads page internals",
      "Makes network requests as part of browsing",
      "Downloads the package from npm on first use (npx)",
    ],
    mcpConfig: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    requires: "npx",
  },

  // ── First-party skills (SKILL.md playbooks run by the engine) ───────────
  {
    id: "code-review",
    name: "Code Review",
    kind: "skill",
    domain: "coding",
    description: "Senior-engineer review focusing on correctness, safety and maintainability.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["review", "quality"],
    overview:
      "A review playbook the engine can load when it is asked to check code. It sets the order of concerns (correctness before style), requires a concrete fix per finding, and explicitly forbids rewriting whole files when a focused edit will do.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_CODE_REVIEW,
  },
  {
    id: "security-audit",
    name: "Security Audit",
    kind: "skill",
    domain: "security",
    description: "Find exploitable issues: injection, unsafe primitives, secrets, auth gaps.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["security", "audit"],
    overview:
      "A security-focused pass that looks for injection, unsafe deserialisation, hard-coded secrets, missing authorisation checks and unsafe file or network handling, with the exploit path spelled out for each finding.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_SECURITY_AUDIT,
  },
  {
    id: "design-review",
    name: "Design & UX Review",
    kind: "skill",
    domain: "design",
    description: "Hierarchy, consistency, accessibility and state coverage for interfaces.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["design", "ux", "a11y"],
    overview:
      "Reviews UI work for visual hierarchy, spacing and alignment consistency, contrast and accessibility, and — most often forgotten — loading, empty and error states.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_DESIGN_REVIEW,
  },
  {
    id: "refactor-plan",
    name: "Refactor Planning",
    kind: "skill",
    domain: "coding",
    description: "Behaviour-preserving refactors planned as small verifiable steps.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["refactor", "planning"],
    overview:
      "Turns a large refactor into a sequence of small, behaviour-preserving steps, each with its own verification, so a failure is always attributable to one change.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_REFACTOR_PLAN,
  },
  {
    id: "test-writer",
    name: "Test Writer",
    kind: "skill",
    domain: "testing",
    description: "Regression-catching tests with boundaries and error paths covered.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["tests", "quality"],
    overview:
      "Writes tests that would actually catch the bug being fixed: boundary values, empty and malformed input, and the error path — rather than assertions that only restate the implementation.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_TEST_WRITER,
  },
  {
    id: "memory-keeper",
    name: "Project Memory",
    kind: "skill",
    domain: "memory",
    description: "Record decisions and rationale in .acsa/memory.md across sessions.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["memory", "decisions"],
    overview:
      "Keeps a running record of decisions and their reasons in the project, so later sessions do not relitigate settled choices.",
    permissions: ["Instructions only — writes only the notes the agent chooses to record"],
    skillContent: SKILL_MEMORY_KEEPER,
  },
  {
    id: "docs-writer",
    name: "Documentation Writer",
    kind: "skill",
    domain: "tooling",
    description: "Actionable docs: what it does, minimal example, precise inputs/outputs.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["docs", "readme"],
    overview:
      "Writes documentation a reader can act on immediately: what the thing does, the smallest working example, and exact inputs and outputs.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_DOCS_WRITER,
  },
  {
    id: "perf-tuner",
    name: "Performance Tuner",
    kind: "skill",
    domain: "coding",
    description: "Measure-first optimisation of real hot paths, with before/after numbers.",
    author: "ACSA Code",
    trust: "built-in",
    logo: { kind: "acsa", id: "acsa" },
    source: "built-in",
    tags: ["performance", "profiling"],
    overview:
      "Insists on measuring before changing anything, targets the profile rather than intuition, and requires before/after numbers for any claimed improvement.",
    permissions: ["Instructions only — no tools, files or network access"],
    skillContent: SKILL_PERF_TUNER,
  },
];

export interface McpToolInfo {
  name: string;
  description?: string;
}

export async function installSkill(
  item: MarketplaceItem,
  projectRoot: string,
  scope: "project" | "user" = "project"
): Promise<{ ok: boolean; error?: string }> {
  if (item.kind !== "skill" || !item.skillContent) {
    return { ok: false, error: "Not a skill" };
  }
  try {
    const res = await marketplaceFetch("/api/skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: item.id,
        content: item.skillContent,
        // The entry's own description: the runtime shows it to the model to decide
        // whether to open the skill, so a placeholder here wastes the entry.
        description: item.description,
        scope,
        projectRoot,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: Boolean(data.ok), error: data.error };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Install failed" };
  }
}

export async function installMcpServer(
  item: MarketplaceItem,
  projectRoot: string
): Promise<{ ok: boolean; error?: string }> {
  if (item.kind !== "mcp" || !item.mcpConfig) {
    return { ok: false, error: "Not an MCP server" };
  }
  try {
    const config = { ...item.mcpConfig };
    if (item.id === "acsa-workspace") {
      const root = projectRoot.replace(/[\\/]+$/, "");
      config.args = [`${root}/core-engine/mcp_servers/workspace_server.py`];
      config.env = { ...(config.env || {}), ACSA_MCP_ROOT: projectRoot };
    }
    const res = await marketplaceFetch("/api/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, config, projectRoot }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: Boolean(data.ok), error: data.error };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Install failed" };
  }
}

export async function removeMcpServer(
  id: string,
  projectRoot: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await marketplaceFetch("/api/mcp/servers/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, projectRoot }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: Boolean(data.ok), error: data.error };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Uninstall failed" };
  }
}

export async function listMcpServers(
  projectRoot: string
): Promise<Record<string, McpServerConfig>> {
  try {
    const res = await marketplaceFetch(`/api/mcp/servers?projectRoot=${encodeURIComponent(projectRoot)}`);
    if (!res.ok) return {};
    const data = await res.json();
    return data.servers || {};
  } catch {
    return {};
  }
}

export async function listMcpTools(
  id: string,
  projectRoot: string
): Promise<{ ok: boolean; tools: McpToolInfo[]; error?: string }> {
  try {
    const res = await marketplaceFetch("/api/mcp/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, projectRoot }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(data.ok),
      tools: Array.isArray(data.tools) ? data.tools : [],
      error: data.error,
    };
  } catch (err: any) {
    return { ok: false, tools: [], error: err?.message || "Could not reach server" };
  }
}

export function domainLabel(domain: MarketplaceDomain): string {
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}
