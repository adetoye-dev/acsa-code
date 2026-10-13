import { defineConfig, version as viteVersion } from "vite";
import react from "@vitejs/plugin-react";
import { apiGuardPlugin } from "./vite-api-guard";
import path from "node:path";

/**
 * Point Monaco's TypeScript worker at a stub, so the real 6.7 MB file is not built.
 *
 * `workerManager.js` reaches for it as
 *
 *   new Worker(new URL('ts.worker.js', import.meta.url), { type: "module" })
 *
 * and Vite bundles every `new URL(…, import.meta.url)` it can see whether or not the
 * branch that creates one ever runs. Nothing creates it here: the app declines
 * Monaco's own TypeScript language features at load (`monacoSetup.ts`) and gets its
 * types, completions and hover from a language server. Without this, every build
 * carried 6.7 MB of compiler that was configured never to answer.
 *
 * A `resolveId` hook does not see this reference — Vite's internal worker plugin
 * reads the file itself, verified by a resolver that logged nothing — so this
 * rewrites the URL in the one file that has it.
 */
function stubTypeScriptWorker() {
  const stub = path.resolve(__dirname, "scripts/ts-worker-stub.ts");
  return {
    name: "acsa:stub-typescript-worker",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("features/typescript")) return null;
      if (!code.includes("ts.worker.js")) return null;
      const rewritten = code.replace(
        /new URL\(\s*(['"])ts\.worker\.js\1\s*,\s*import\.meta\.url\s*\)/g,
        `new URL(${JSON.stringify(stub)}, import.meta.url)`,
      );
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [stubTypeScriptWorker(), react(), ...(command === "serve" ? [apiGuardPlugin()] : [])],

  // The Performance panel's runtime line names the bundler, and nothing at runtime
  // can know it: Vite is a build tool, so the version is captured here, where it is
  // a fact, rather than guessed from a package.json that does not ship.
  define: { __ACSA_VITE_VERSION__: JSON.stringify(viteVersion) },

  // Vite options tailored for development and Tauri desktop integration
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // Split the two always-loaded vendor stacks so an app-code change does
        // not invalidate ~540 kB of unchanged dependencies. Only libraries the
        // entry statically imports are named here: naming a lazily imported one
        // lets Rollup merge its shared __vitePreload helper into that chunk,
        // which makes the entry statically import it and preload the lot.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/dockview/.test(id)) return "vendor-dockview";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/.tauri/**", "**/core-engine/**", "**/projects/**"],
    },
  },
}));
