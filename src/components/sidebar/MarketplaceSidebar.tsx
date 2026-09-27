/**
 * MarketplaceSidebar.tsx — Skill / Tooling / MCP marketplace
 *
 * Browse and install open-source harness capabilities:
 *  - Skills -> written to .acsa/skills (consumed by the Python skill loader)
 *  - MCP servers -> written to .acsa/mcp.json (consumed by the MCP client)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import {
  Package,
  Download,
  Trash2,
  Search,
  Wrench,
  Brain,
  Shield,
  Palette,
  FlaskConical,
  Plug,
  RefreshCw,
  ChevronRight,
  ExternalLink,
  ShieldCheck,
  FileText,
} from "lucide-react";
import {
  ECOSYSTEM_LINKS,
  MARKETPLACE_ITEMS,
  TRUST_LABEL,
  domainLabel,
  installTarget,
  installMcpServer,
  installSkill,
  listMcpServers,
  listMcpTools,
  removeMcpServer,
  type MarketplaceDomain,
  type MarketplaceItem,
  type MarketplaceKind,
} from "../../services/marketplace";
import { X } from "lucide-react";
import { marketplaceFetch } from "../../services/marketplaceClient";
import { useDialogA11y } from "../../hooks/useDialogA11y";
import { openExternal } from "../../services/openExternal";
import { TechLogo } from "../ui/TechLogos";
import { AnthropicLogo, IdeBrandLogo } from "../ui/BrandLogos";

interface MarketplaceSidebarProps {
  projectRoot?: string;
}

/** The mark for an entry: its tool's own logo, its publisher's, or ours. */
function ItemMark({ item, className = "h-5 w-5" }: { item: MarketplaceItem; className?: string }) {
  const domain = DOMAIN_ICONS[item.domain] || Package;
  const fallback = <Icon icon={domain} strokeWidth={2} className={`${className} text-purple-300`} />;
  if (item.logo?.kind === "acsa") return <IdeBrandLogo size={20} className={className} />;
  if (item.logo?.kind === "brand" && item.logo.id === "anthropic") {
    return <AnthropicLogo size={20} className={className} />;
  }
  return (
    <TechLogo
      techId={item.logo?.id ?? item.name}
      className={`${className} object-contain`}
      fallback={fallback}
    />
  );
}

const DOMAIN_ICONS: Record<MarketplaceDomain, any> = {
  coding: Wrench,
  security: Shield,
  design: Palette,
  memory: Brain,
  research: Search,
  testing: FlaskConical,
  tooling: Package,
};

/** What each category is for, one line, the way the reference does it. */
const DOMAIN_BLURB: Record<MarketplaceDomain, string> = {
  coding: "Code-aware tools: search, edit, refactor and review.",
  security: "Scanning, secrets and supply-chain checks.",
  design: "Visual work: layouts, assets and design systems.",
  memory: "Notes and graphs the agent can carry between sessions.",
  research: "Fetching, reading and citing things outside the project.",
  testing: "Running, generating and judging tests.",
  tooling: "The plumbing: filesystem, git, browsers, shells.",
};

const DOMAIN_ORDER: MarketplaceDomain[] = [
  "coding",
  "security",
  "design",
  "memory",
  "research",
  "testing",
  "tooling",
];

/** Bundled first, then official, then community — a stable, honest ranking. */
const TRUST_ORDER: Record<string, number> = { "built-in": 0, official: 1, community: 2 };

interface CatalogueSection {
  key: string;
  title: string;
  blurb: string;
  entries: Array<{ item: MarketplaceItem; rank: number }>;
  /** Set when the section can be opened on its own (its own filter). */
  filter?: { kind: MarketplaceKind | "all"; domain: MarketplaceDomain | "all" };
}

export function MarketplaceSidebar({ projectRoot = "" }: MarketplaceSidebarProps) {
  const [kind, setKind] = useState<MarketplaceKind | "all">("all");
  const [domain, setDomain] = useState<MarketplaceDomain | "all">("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());
  const [installedServers, setInstalledServers] = useState<Record<string, any>>({});
  const [toolsById, setToolsById] = useState<Record<string, string[]>>({});
  /** Which entry's detail view is open (one at a time keeps the sidebar calm). */
  /** The entry whose detail is open — a dialog, not an expanded row. */
  const [expandedId, setExpandedId] = useState<string>("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, () => setExpandedId(""), Boolean(expandedId));

  const refreshInstalled = async () => {
    try {
      const res = await marketplaceFetch(`/api/skills/list?projectRoot=${encodeURIComponent(projectRoot)}`);
      if (res.ok) {
        const data = await res.json();
        setInstalledSkills(
          new Set<string>(
            (data.skills || []).map((s: any) => String(s.name || "").toLowerCase())
          )
        );
      }
    } catch {}
    setInstalledServers(await listMcpServers(projectRoot));
  };

  useEffect(() => {
    refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MARKETPLACE_ITEMS.filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (domain !== "all" && item.domain !== domain) return false;
      if (q) {
        const haystack = `${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [kind, domain, query]);

  /**
   * Filtered: one list. Unfiltered: the catalogue grouped, bundled first, which
   * is what makes this a page worth scrolling rather than a list to search.
   */
  const sections = useMemo<CatalogueSection[]>(() => {
    const rank = (list: MarketplaceItem[]) =>
      [...list]
        .sort((a, b) =>
          a.trust === b.trust
            ? a.name.localeCompare(b.name)
            : (TRUST_ORDER[a.trust] ?? 9) - (TRUST_ORDER[b.trust] ?? 9)
        )
        .map((item, index) => ({ item, rank: index + 1 }));

    const q = query.trim();
    if (kind !== "all" || domain !== "all" || q) {
      const title = q
        ? `Results for “${q}”`
        : kind !== "all"
          ? kind === "skill"
            ? "Skills"
            : "MCP servers"
          : domain !== "all"
            ? domainLabel(domain)
            : "Everything";
      return [
        {
          key: "results",
          title,
          blurb: `${items.length} ${items.length === 1 ? "entry" : "entries"}`,
          entries: rank(items),
        },
      ];
    }

    // Deliberately no "featured" band at the top: today every entry is bundled,
    // so one would repeat the page under itself. Bundled-first is the ordering
    // inside each section instead, and the badge says which those are.
    const out: CatalogueSection[] = [];
    for (const d of DOMAIN_ORDER) {
      const list = items.filter((item) => item.domain === d);
      if (list.length === 0) continue;
      out.push({
        key: d,
        title: domainLabel(d),
        blurb: DOMAIN_BLURB[d],
        entries: rank(list),
        filter: { kind: "all", domain: d },
      });
    }
    return out;
  }, [items, kind, domain, query]);

  const counts = useMemo(() => {
    const byKind: Record<MarketplaceKind, number> = { skill: 0, mcp: 0 };
    const byDomain = {} as Record<MarketplaceDomain, number>;
    for (const item of MARKETPLACE_ITEMS) {
      byKind[item.kind] += 1;
      byDomain[item.domain] = (byDomain[item.domain] || 0) + 1;
    }
    return { total: MARKETPLACE_ITEMS.length, byKind, byDomain };
  }, []);

  const isInstalled = (item: MarketplaceItem) =>
    item.kind === "skill"
      ? installedSkills.has(item.id.toLowerCase())
      : Boolean(installedServers[item.id]);

  const handleInstall = async (item: MarketplaceItem) => {
    setBusyId(item.id);
    setMessage(null);
    const result =
      item.kind === "skill"
        ? await installSkill(item, projectRoot)
        : await installMcpServer(item, projectRoot);
    if (result.ok) {
      setMessage({ text: `Installed ${item.name}`, ok: true });
      await refreshInstalled();
    } else {
      setMessage({ text: result.error || `Could not install ${item.name}`, ok: false });
    }
    setBusyId("");
  };

  const handleUninstall = async (item: MarketplaceItem) => {
    setBusyId(item.id);
    setMessage(null);
    if (item.kind === "mcp") {
      const result = await removeMcpServer(item.id, projectRoot);
      setMessage(
        result.ok
          ? { text: `Removed ${item.name}`, ok: true }
          : { text: result.error || "Could not remove server", ok: false }
      );
      await refreshInstalled();
    } else {
      setMessage({ text: `Skills are managed in .acsa/skills (delete the file to remove)`, ok: false });
    }
    setBusyId("");
  };

  const handleTest = async (item: MarketplaceItem) => {
    setBusyId(item.id);
    setMessage(null);
    const result = await listMcpTools(item.id, projectRoot);
    if (result.ok) {
      setToolsById((prev) => ({ ...prev, [item.id]: result.tools.map((t) => t.name) }));
      setMessage({ text: `${item.name}: ${result.tools.length} tool(s) available`, ok: true });
    } else {
      setMessage({ text: result.error || "Could not list tools", ok: false });
    }
    setBusyId("");
  };



  const categoryRows: Array<{
    key: string;
    label: string;
    icon: any;
    count: number;
    kind: MarketplaceKind | "all";
    domain: MarketplaceDomain | "all";
  }> = [
    { key: "all", label: "All capabilities", icon: Package, count: counts.total, kind: "all", domain: "all" },
    { key: "skill", label: "Skills", icon: FileText, count: counts.byKind.skill, kind: "skill", domain: "all" },
    { key: "mcp", label: "MCP servers", icon: Plug, count: counts.byKind.mcp, kind: "mcp", domain: "all" },
    ...DOMAIN_ORDER.map((d) => ({
      key: d,
      label: domainLabel(d),
      icon: DOMAIN_ICONS[d],
      count: counts.byDomain[d] || 0,
      kind: "all" as const,
      domain: d,
    })),
  ];

  return (
    <div className="flex h-full w-full min-h-0 bg-canvas text-zinc-300">
      {/* ── Categories ─────────────────────────────────────────────────────
          A column rather than a row of tabs: it reads as a place, it holds the
          counts without competing with the title, and it leaves "find more" in
          the same column instead of stranding it under the list. */}
      <aside className="flex w-[clamp(12rem,16vw,16.5rem)] shrink-0 flex-col border-r border-hairline bg-workbench">
        <div className="px-4 pb-1 pt-4 text-4xs font-semibold uppercase tracking-wider text-zinc-500">
          Categories
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {categoryRows.map((row) => {
            const active = kind === row.kind && domain === row.domain;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => {
                  setKind(row.kind);
                  setDomain(row.domain);
                }}
                data-testid={`marketplace-category-${row.key}`}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors ${
                  active ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                }`}
              >
                <Icon
                  icon={row.icon}
                  strokeWidth={2}
                  className={`h-4 w-4 shrink-0 ${active ? "text-accent" : ""}`}
                />
                <span className="min-w-0 flex-1 truncate text-body font-medium">{row.label}</span>
                <span className="shrink-0 font-mono text-3xs text-zinc-500">{row.count}</span>
              </button>
            );
          })}
        </div>

        {/* Compact on purpose: the links, and nothing explaining them. */}
        <div className="shrink-0 border-t border-hairline px-3 py-3">
          <div className="text-4xs font-semibold uppercase tracking-wider text-zinc-500">
            Find more
          </div>
          <div className="mt-2 space-y-1.5">
            {ECOSYSTEM_LINKS.map((link) => (
              <button
                key={link.url}
                type="button"
                onClick={() => void openExternal(link.url)}
                title={link.note}
                className="group flex w-full items-center gap-1.5 text-left text-body text-zinc-300 transition-colors hover:text-white"
              >
                <span className="min-w-0 flex-1 truncate">{link.label}</span>
                <Icon icon={ExternalLink} className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ── Catalogue ────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 px-5 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Marketplace</h1>
              <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-zinc-400">
                {counts.total} skills and MCP servers for this harness, bundled ones first. Every
                entry carries a real source you can read before installing anything.
              </p>
            </div>
            <button
              type="button"
              onClick={refreshInstalled}
              title="Refresh installed capabilities"
              aria-label="Refresh installed capabilities"
              className="shrink-0 rounded-lg border border-hairline p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              <Icon icon={RefreshCw} className="h-4 w-4" />
            </button>
          </div>

          <div className="relative mt-4">
            <Icon
              icon={Search}
              className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools by name or what they do…"
              aria-label="Search the marketplace"
              className="w-full rounded-xl border border-hairline bg-workbench py-3 pl-10 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-accent"
            />
          </div>

          {message && (
            <div
              className={`mt-3 rounded-lg border px-2.5 py-1.5 text-body ${
                message.ok
                  ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-200"
                  : "border-amber-500/40 bg-amber-950/30 text-amber-200"
              }`}
            >
              {message.text}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
          {sections.length === 0 && (
            <div className="py-10 text-center text-body text-zinc-500">
              Nothing matches that. Try a shorter search, or another category.
            </div>
          )}

          {sections.map((section) => (
            <section key={section.key} className="mt-6">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-zinc-100">{section.title}</h2>
                  <p className="mt-0.5 text-body text-zinc-500">{section.blurb}</p>
                </div>
                {section.filter && (
                  <button
                    type="button"
                    onClick={() => {
                      setKind(section.filter!.kind);
                      setDomain(section.filter!.domain);
                    }}
                    className="shrink-0 text-xs text-zinc-400 transition-colors hover:text-zinc-100"
                  >
                    All {section.entries.length} →
                  </button>
                )}
              </div>

              <div className="mt-2.5 grid grid-cols-1 gap-2 xl:grid-cols-2 2xl:grid-cols-3">
                {section.entries.map(({ item, rank }) => {
                  const installed = isInstalled(item);
                  const busy = busyId === item.id;
                  const tools = toolsById[item.id];
                  const expanded = expandedId === item.id;
                  const links = [
                    { label: "Repository", url: item.repo },
                    { label: "Docs", url: item.docs },
                    { label: "Website", url: item.homepage },
                  ].filter((l) => Boolean(l.url));
                  const target = installTarget(item, projectRoot);
                  const trustTone =
                    item.trust === "built-in"
                      ? "bg-sky-500/15 text-sky-300"
                      : item.trust === "official"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-amber-500/15 text-amber-300";
                  return (
                    <div
                      key={item.id}
                      className={`rounded-xl border transition-colors ${
                        expanded
                          ? "border-purple-500/40 bg-zinc-900/60"
                          : "border-hairline bg-zinc-900/30 hover:border-zinc-600/70 hover:bg-zinc-900/50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? "" : item.id)}
                        title={expanded ? "Hide details" : "Show details"}
                        data-testid={`marketplace-item-${item.id}`}
                        className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left"
                      >
                        <span className="w-3 shrink-0 text-right font-mono text-body text-zinc-500">
                          {rank}
                        </span>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-workbench">
                          {/* A real mark where the entry names one (Playwright,
                              Chrome, Git); the category's glyph otherwise, rather
                              than a logo we would have to invent. */}
                          <ItemMark item={item} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-zinc-100">
                              {item.name}
                            </span>
                            <span className={`shrink-0 rounded px-1 font-mono text-body ${trustTone}`}>
                              {TRUST_LABEL[item.trust]}
                            </span>
                            {installed && (
                              <span className="shrink-0 rounded bg-emerald-500/15 px-1 font-mono text-body text-emerald-300">
                                Installed
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-zinc-400">
                            {item.description}
                          </span>
                        </span>
                        <Icon
                          icon={ChevronRight}
                          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${
                            expanded ? "rotate-90" : ""
                          }`}
                        />
                      </button>

                      {/* No click-outside handler: the app's other dialogs close on
                          Escape and on a button, and a backdrop that is itself
                          clickable is one more thing for a keyboard user to miss. */}
                      {expanded && (
                        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-6">
                          <div
                            ref={dialogRef}
                            role="dialog"
                            aria-modal="true"
                            aria-label={item.name}
                            data-testid="marketplace-detail"
                            className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-hairline bg-workbench shadow-2xl"
                          >
                            <header className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3.5">
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline bg-canvas">
                                <ItemMark item={item} className="h-6 w-6" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-semibold text-zinc-100">
                                    {item.name}
                                  </span>
                                  <span
                                    className={`shrink-0 rounded px-1 font-mono text-2xs ${trustTone}`}
                                  >
                                    {TRUST_LABEL[item.trust]}
                                  </span>
                                  {installed && (
                                    <span className="shrink-0 rounded bg-emerald-500/15 px-1 font-mono text-2xs text-emerald-300">
                                      Installed
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-body text-zinc-500">{item.description}</div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setExpandedId("")}
                                aria-label="Close"
                                className="shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
                              >
                                <Icon icon={X} className="h-4 w-4" />
                              </button>
                            </header>

                            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="space-y-3">
                  {item.overview && (
                    <p className="text-body text-zinc-400 leading-relaxed">{item.overview}</p>
                  )}

                  {/* Source & credibility */}
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-body text-zinc-400">
                      <Icon icon={ShieldCheck} className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span className="font-mono">
                        {item.trust === "built-in"
                          ? "Ships with ACSA Code"
                          : item.trust === "official"
                          ? `Published by ${item.author} (upstream maintainer)`
                          : `Third-party — maintained by ${item.author}`}
                      </span>
                    </div>
                    {item.version && (
                      <div className="text-body font-mono text-zinc-500">
                        version: {item.version}
                      </div>
                    )}
                    {links.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {links.map((link) => (
                          <button
                            key={link.label}
                            type="button"
                            onClick={() => void openExternal(link.url as string)}
                            title={link.url}
                            className="inline-flex items-center gap-1 rounded-md border border-hairline px-2 py-1 font-mono text-body text-zinc-200 transition-colors hover:border-zinc-500 hover:text-white"
                          >
                            {link.label}
                            <Icon icon={ExternalLink} className="h-3 w-3" />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-body font-mono text-zinc-500">
                        No external source — bundled with the app.
                      </div>
                    )}
                  </div>

                  {/* What the install actually does */}
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 space-y-1">
                    <div className="flex items-center gap-1.5 text-body text-zinc-400">
                      <Icon icon={FileText} className="w-3 h-3 shrink-0" />
                      <span className="font-mono">What installs</span>
                    </div>
                    <div className="text-body font-mono text-zinc-500 break-all">
                      {target.path}
                    </div>
                    {target.command && (
                      <div className="text-body font-mono text-zinc-400 break-all">
                        runs: <span className="text-zinc-300">{target.command}</span>
                      </div>
                    )}
                    {item.permissions && item.permissions.length > 0 && (
                      <ul className="pt-0.5 space-y-0.5">
                        {item.permissions.map((permission) => (
                          <li
                            key={permission}
                            className="flex items-start gap-1 text-body text-zinc-400"
                          >
                            <span className="text-zinc-500">•</span>
                            <span className="leading-snug">{permission}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Skill body preview */}
                  {item.kind === "skill" && item.skillContent && (
                    <details className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
                      <summary className="text-body text-zinc-400 cursor-pointer font-mono">
                        Preview SKILL.md
                      </summary>
                      <pre className="mt-1.5 max-h-52 overflow-auto text-body leading-snug text-zinc-400 whitespace-pre-wrap font-mono">
                        {item.skillContent}
                      </pre>
                    </details>
                  )}

                  {/* MCP tools */}
                  {item.kind === "mcp" && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 space-y-1">
                      <div className="text-body text-zinc-400 font-mono">
                        {tools && tools.length > 0
                          ? `Tools exposed (${tools.length})`
                          : "Tool list"}
                      </div>
                      {tools && tools.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {tools.map((tool) => (
                            <span
                              key={tool}
                              className="px-1 py-0.5 rounded bg-zinc-800/70 border border-zinc-700 text-body font-mono text-emerald-300"
                            >
                              {tool}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-body text-zinc-500 leading-snug">
                          {installed
                            ? "Run “Test” to start the server and list its tools."
                            : "Install, then Test to start the server and list its tools."}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5">
                    {!installed ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleInstall(item)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-body font-semibold bg-purple-600 hover:bg-purple-500 text-white transition-colors disabled:opacity-50"
                      >
                        <Icon icon={Download} className="w-3 h-3" />
                        <span>{busy ? "Installing…" : "Install"}</span>
                      </button>
                    ) : (
                      <>
                        {item.kind === "mcp" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleTest(item)}
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-body font-semibold bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
                          >
                            <Icon icon={Plug} className="w-3 h-3" />
                            <span>{busy ? "Testing…" : "Test"}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleUninstall(item)}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-body font-semibold bg-zinc-800/60 hover:bg-red-900/40 border border-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
                        >
                          <Icon icon={Trash2} className="w-3 h-3" />
                          <span>Remove</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

      </div>
    </div>
  );
}
