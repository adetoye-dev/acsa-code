import { defineConfig, version as viteVersion } from "vite";
import react from "@vitejs/plugin-react";
import { apiGuardPlugin } from "./vite-api-guard";

// https://vitejs.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react(), ...(command === "serve" ? [apiGuardPlugin()] : [])],

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
