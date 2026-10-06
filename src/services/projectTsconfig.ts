/**
 * projectTsconfig.ts — a project's own compiler options, in Monaco's shape.
 *
 * Monaco's TypeScript worker takes numeric enums, and `tsconfig.json` is JSONC
 * (comments, trailing commas) that may `extends` another file. Both ends need
 * translating, and getting it wrong is worse than not trying: an unrecognised
 * value has to leave the previous option alone rather than become a number
 * TypeScript reads as something else.
 *
 * Why it matters at all: without it, an import of `@/components/Button` — a
 * `paths` alias — is unresolvable here and fine everywhere else, which is the
 * exact complaint the virtual filesystem exists to answer. Our defaults happen to
 * suit a modern ESM/TSX project, but "happens to suit" is not what a project's
 * own configuration is for.
 */

/**
 * The enum values below were read out of the TypeScript that Monaco bundles
 * (`languages/features/typescript/lib/typescriptServices.js`, 5.9.3) rather than
 * recalled: Monaco's own `ModuleResolutionKind` names only `Classic` and `NodeJs`,
 * so `Bundler` and `NodeNext` have to come from the numbers TypeScript actually
 * uses, and a wrong one is a silently different compiler.
 */

/** TS `ScriptTarget`, by name. `Latest` is `ESNext`. */
const TARGETS: Record<string, number> = {
  es3: 0, es5: 1, es6: 2, es2015: 2, es2016: 3, es2017: 4, es2018: 5, es2019: 6,
  es2020: 7, es2021: 8, es2022: 9, es2023: 10, es2024: 11, esnext: 99, latest: 99, json: 100,
};

/** TS `ModuleKind`, by name. */
const MODULES: Record<string, number> = {
  none: 0, commonjs: 1, amd: 2, umd: 3, system: 4, es6: 5, es2015: 5,
  es2020: 6, es2022: 7, esnext: 99, node16: 100, node18: 101, node20: 102,
  nodenext: 199, preserve: 200,
};

/** TS `ModuleResolutionKind`, by name. */
const MODULE_RESOLUTIONS: Record<string, number> = {
  classic: 1, node: 2, node10: 2, nodejs: 2, node16: 3, nodenext: 99, bundler: 100,
};

/** TS `JsxEmit`, by name. */
const JSX: Record<string, number> = {
  none: 0, preserve: 1, react: 2, reactnative: 3, "react-jsx": 4, reactjsx: 4,
  "react-jsxdev": 5, reactjsxdev: 5,
};

/**
 * Strip what JSON permits and tsconfig.json uses: comments and trailing commas.
 *
 * Done as a scanner rather than a regex, because a regex that removes `//…` also
 * removes the `//` inside `"https://…"` and turns a valid file into a broken one.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
    } else if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
    } else {
      out += char;
    }
  }

  // Trailing commas: `{ "a": 1, }`. Whitespace between the comma and the closer is
  // what makes a regex safe enough here — no string can contain `,\s*}` unquoted.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** `lib` names as TypeScript writes them: `DOM` becomes `lib.dom.d.ts`. */
function toLibFileNames(lib: unknown): string[] | null {
  if (!Array.isArray(lib)) return null;
  const names = lib
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => {
      const trimmed = entry.trim();
      if (/^lib\..*\.d\.ts$/i.test(trimmed)) return trimmed;
      if (/^lib$/i.test(trimmed)) return null;
      return `lib.${trimmed.toLowerCase().replace(/^lib\./, "")}.d.ts`;
    })
    .filter((entry): entry is string => Boolean(entry));
  return names.length > 0 ? names : null;
}

function numeric(value: unknown, table: Record<string, number>): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  return table[value.trim().toLowerCase()] ?? null;
}

/**
 * The project's options, in the shape Monaco's worker expects.
 *
 * Anything unrecognised is dropped so the caller's default stands. A config that
 * says something we do not model must not silently become a different setting.
 */
export function toMonacoCompilerOptions(compilerOptions: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const target = numeric(compilerOptions.target, TARGETS);
  if (target !== null) out.target = target;
  const module = numeric(compilerOptions.module, MODULES);
  if (module !== null) out.module = module;
  const moduleResolution = numeric(compilerOptions.moduleResolution, MODULE_RESOLUTIONS);
  if (moduleResolution !== null) out.moduleResolution = moduleResolution;
  const jsx = numeric(compilerOptions.jsx, JSX);
  if (jsx !== null) out.jsx = jsx;

  const lib = toLibFileNames(compilerOptions.lib);
  if (lib) out.lib = lib;

  if (typeof compilerOptions.jsxImportSource === "string") {
    out.jsxImportSource = compilerOptions.jsxImportSource;
  }
  if (typeof compilerOptions.baseUrl === "string") out.baseUrl = compilerOptions.baseUrl;
  if (compilerOptions.paths && typeof compilerOptions.paths === "object") {
    out.paths = compilerOptions.paths;
  }
  if (Array.isArray(compilerOptions.types)) {
    out.types = compilerOptions.types.filter((t): t is string => typeof t === "string");
  }

  for (const flag of [
    "allowJs", "checkJs", "strict", "esModuleInterop", "allowSyntheticDefaultImports",
    "resolveJsonModule", "isolatedModules", "skipLibCheck", "noEmit", "experimentalDecorators",
    "emitDecoratorMetadata", "useDefineForClassFields", "verbatimModuleSyntax",
  ] as const) {
    if (typeof compilerOptions[flag] === "boolean") out[flag] = compilerOptions[flag];
  }

  return out;
}

export interface TsconfigDocument {
  compilerOptions: Record<string, unknown>;
  extends?: string;
}

/** One tsconfig.json, parsed. Throws on text that is not JSON once cleaned. */
export function parseTsconfig(text: string): TsconfigDocument {
  const document = JSON.parse(stripJsonComments(text)) as {
    compilerOptions?: Record<string, unknown>;
    extends?: unknown;
  };
  return {
    compilerOptions: document.compilerOptions ?? {},
    extends: typeof document.extends === "string" ? document.extends : undefined,
  };
}

/** Resolve an `extends` target to a path we can read, or null. */
export function extendsPath(fromDir: string, target: string): string | null {
  // A relative or absolute path. A bare name is a package (`@tsconfig/node20`),
  // whose own `tsconfig.json` this cannot guess without a package.json lookup —
  // recorded as a gap rather than approximated.
  if (!target.startsWith(".") && !target.startsWith("/")) return null;
  const base = fromDir === "" || fromDir === "." ? target : `${fromDir}/${target}`;
  return base.endsWith(".json") ? base : `${base}.json`;
}
