/**
 * ProjectModal.tsx — New Project Creation Modal
 *
 * Two steps, because it is two decisions. Step one is *what* you are building —
 * a choice between templates, which is the only part that needs the room. Step
 * two is *where it goes* and *what it is called* — two fields that belong
 * together, and one of which (the name) is derived into the other (the folder).
 *
 * The single-step version was a form with a six-row template list bolted into the
 * middle of it: on a laptop the dialog was taller than the window, so the commit
 * button was the thing you scrolled to find, and the two fields that jointly
 * decide the destination path were read as unrelated. Both problems are
 * structural, not cosmetic.
 */

import React, { useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Code2,
  Database,
  FolderPlus,
  Globe,
  Search,
  Server,
  X,
  Zap,
} from "lucide-react";
import { Icon } from "./ui/Icon";
import { useDialogA11y } from "../hooks/useDialogA11y";

interface ProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateProject: (name: string, template: string, parentDir?: string) => void | Promise<void>;
  onPickFolder?: () => Promise<string | null>;
}

interface Template {
  id: string;
  name: string;
  /** Shown on the card: the one word that says what kind of thing this is. */
  badge: string;
  description: string;
  icon: typeof Globe;
  files: string[];
}

export const TEMPLATES: Template[] = [
  {
    id: "nextjs",
    name: "Next.js 15 App Router",
    badge: "Fullstack",
    description:
      "Production fullstack React 19 app with TypeScript, Tailwind CSS v4, App Directory, and server components.",
    icon: Globe,
    files: ["app/page.tsx", "app/layout.tsx", "package.json"],
  },
  {
    id: "vite-react",
    name: "Vite React + TypeScript",
    badge: "Frontend",
    description:
      "Ultra-fast frontend SPA with React 19, strict TypeScript, Tailwind CSS v4, and lightning HMR.",
    icon: Code2,
    files: ["src/App.tsx", "vite.config.ts", "package.json"],
  },
  {
    id: "nestjs",
    name: "NestJS TypeScript API",
    badge: "Backend",
    description:
      "Enterprise modular TypeScript backend with controllers, services, Nest CLI configs, and REST routing.",
    icon: Server,
    files: ["src/main.ts", "src/app.module.ts", "nest-cli.json"],
  },
  {
    id: "supabase",
    name: "Supabase Fullstack Starter",
    badge: "BaaS",
    description:
      "Express backend with a @supabase/supabase-js client, a health check, and .env.example.",
    icon: Database,
    files: ["src/server.js", "src/supabaseClient.js", ".env.example"],
  },
  {
    id: "fastapi",
    name: "Python FastAPI Service",
    badge: "Python",
    description:
      "High-performance async REST API with Pydantic schemas, Uvicorn ASGI server, and requirements.txt.",
    icon: Zap,
    files: ["main.py", "models.py", "requirements.txt"],
  },
  {
    id: "express",
    name: "Node.js / Express REST API",
    badge: "Node.js",
    description:
      "Lightweight JSON HTTP microservice with Express routing, middleware, CORS, and package.json.",
    icon: Server,
    files: ["server.js", "package.json", "README.md"],
  },
];

/**
 * The folder name a project name turns into. Shared by the field and the path
 * preview, so what the user reads is exactly what gets written.
 */
export function slugify(name: string): string {
  return name.trim().replace(/\s+/g, "-").toLowerCase();
}

export function ProjectModal({
  isOpen,
  onClose,
  onCreateProject,
  onPickFolder,
}: ProjectModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [projectName, setProjectName] = useState("");
  const [parentDir, setParentDir] = useState("~/AcsaProjects");
  const [selectedTemplate, setSelectedTemplate] = useState("nextjs");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Tab stays in the dialog, Escape closes it, focus returns to whatever opened
  // it. None of that existed: Escape did nothing and Tab walked out behind it.
  useDialogA11y(dialogRef, onClose, isOpen);

  if (!isOpen) return null;

  const template = TEMPLATES.find((t) => t.id === selectedTemplate) ?? TEMPLATES[0];
  const slug = slugify(projectName);
  const destination = `${parentDir.trim().replace(/\/+$/, "")}/${slug || "\u2026"}`;

  const handleBrowse = async () => {
    if (onPickFolder) {
      const picked = await onPickFolder();
      if (picked) setParentDir(picked);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) {
      setStep(2);
      return;
    }
    if (!slug || creating) return;

    setError(null);
    setCreating(true);
    try {
      await onCreateProject(slug, selectedTemplate, parentDir.trim());
      setProjectName("");
      setStep(1);
      onClose();
    } catch (err) {
      // Stay open, on the step that owns the fields, with the input intact. This
      // used to close first and then raise an alert, which discarded the name the
      // user had just typed and the path that actually needed fixing — and an
      // alert on its own says nothing about which field is wrong.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Create a new project"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4 select-none"
    >
      <div className="w-full max-w-xl max-h-[85vh] bg-modal/95 backdrop-blur-xl border border-hairline rounded-modal shadow-elevation-3 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150">
        {/* Header. The step is stated rather than implied by the body, so the
            dialog never leaves the user guessing how much is left. */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-zinc-800 bg-zinc-950/50 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-surface-selected border border-accent flex items-center justify-center text-accent shrink-0">
              <Icon icon={FolderPlus} className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-zinc-100 truncate">
                {step === 1 ? "Start a new project" : "Name it and choose a folder"}
              </h2>
              <p className="text-2xs text-zinc-400">
                Step {step} of 2 &middot;{" "}
                {step === 1 ? "pick a starting point" : "scaffolds real files on disk"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg shrink-0"
          >
            <Icon icon={X} className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-6 space-y-4">
            {step === 1 ? (
              <>
                {/* A group of template buttons, not a form control: a heading. */}
                <p className="text-xs font-semibold text-zinc-300">Architecture</p>
                <div
                  role="group"
                  aria-label="Architecture template"
                  className="grid grid-cols-2 gap-2"
                >
                  {TEMPLATES.map((tmpl) => {
                    const isSelected = selectedTemplate === tmpl.id;
                    const TmplIcon = tmpl.icon;
                    return (
                      <button
                        type="button"
                        key={tmpl.id}
                        aria-pressed={isSelected}
                        onClick={() => setSelectedTemplate(tmpl.id)}
                        className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left cursor-pointer transition-colors ${
                          isSelected
                            ? "bg-surface-selected border-accent text-white"
                            : "bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`p-1.5 rounded-lg shrink-0 ${
                            isSelected ? "bg-primary-action text-white" : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          <Icon icon={TmplIcon} className="w-3.5 h-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-2xs font-bold text-zinc-200">
                            {tmpl.name}
                          </span>
                          <span className="block text-3xs text-zinc-400">{tmpl.badge}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* What the highlighted template actually gives you, kept out of
                    the cards so six of them fit a grid without a scroll. */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
                  <p className="text-xs font-bold text-zinc-200">{template.name}</p>
                  <p className="text-2xs leading-relaxed text-zinc-400">{template.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {template.files.map((f) => (
                      <span
                        key={f}
                        className="text-3xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* What is being created, and one way back to change it. */}
                <div className="flex items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-2.5">
                  <span
                    aria-hidden="true"
                    className="p-1.5 rounded-lg bg-zinc-800 text-zinc-300 shrink-0"
                  >
                    <Icon icon={template.icon} className="w-3.5 h-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-2xs font-bold text-zinc-200">
                      {template.name}
                    </span>
                    <span className="block text-3xs text-zinc-400">{template.badge}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="shrink-0 text-2xs font-semibold text-zinc-300 hover:text-white underline underline-offset-2"
                  >
                    Change
                  </button>
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="projectmodal-project-name-1"
                    className="text-xs font-semibold text-zinc-300"
                  >
                    Project name
                  </label>
                  <input
                    id="projectmodal-project-name-1"
                    // Focus lands in the field this step exists for, which is what
                    // the ARIA authoring practices recommend for a dialog step.
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    type="text"
                    placeholder="e.g. user-auth-service"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-700 rounded-xl px-3.5 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-purple-500/60"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="projectmodal-save-inside-directory-2"
                    className="text-xs font-semibold text-zinc-300"
                  >
                    Save inside directory
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="projectmodal-save-inside-directory-2"
                      type="text"
                      placeholder="e.g. ~/Desktop or /Users/.../Projects"
                      value={parentDir}
                      onChange={(e) => setParentDir(e.target.value)}
                      className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded-xl px-3.5 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-purple-500/60"
                    />
                    <button
                      type="button"
                      onClick={handleBrowse}
                      className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
                    >
                      <Icon icon={Search} className="w-3.5 h-3.5 text-primary-icon" />
                      <span>Browse&hellip;</span>
                    </button>
                  </div>
                </div>

                {/* The two fields above are one decision; showing the joined
                    result is the reason they can sit on a step of their own. */}
                <div className="space-y-1">
                  <p className="text-3xs font-semibold uppercase tracking-wide text-zinc-400">
                    Will be created at
                  </p>
                  <p
                    data-testid="projectmodal-destination"
                    className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-2xs text-zinc-300 break-all"
                  >
                    {destination}
                  </p>
                </div>
              </>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-950/30 px-3 py-2 text-2xs leading-relaxed text-red-200"
              >
                <Icon icon={AlertCircle} className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
                <span className="break-words">{error}</span>
              </div>
            )}
          </div>

          {/* Actions, outside the scroll region so the commit button is never the
              thing you have to go looking for. */}
          <div className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/50 px-6 py-3 shrink-0">
            <button
              type="button"
              onClick={step === 1 ? onClose : () => setStep(1)}
              className="px-3 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5"
            >
              {step === 2 && <Icon icon={ArrowLeft} className="w-3.5 h-3.5" />}
              {step === 1 ? "Cancel" : "Back"}
            </button>
            <button
              type="submit"
              disabled={(step === 2 && !slug) || creating}
              aria-busy={creating}
              className={`px-5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors ${
                (step === 1 || slug) && !creating
                  ? "bg-primary-action text-white cursor-pointer hover:opacity-90"
                  : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              }`}
            >
              {step === 1 ? (
                <>
                  Continue
                  <Icon icon={ArrowRight} className="w-3.5 h-3.5" />
                </>
              ) : creating ? (
                "Scaffolding\u2026"
              ) : (
                "Create project"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ProjectModal;
