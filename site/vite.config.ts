import { defineConfig } from "vite";

/**
 * The landing page builds on its own, into `site/dist`.
 *
 * `base: "./"` so the same output works at a domain root (Cloudflare Pages) and at
 * a subpath — GitHub Pages project sites, or a preview URL — without a rebuild.
 */
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 2048,
  },
});
