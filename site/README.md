# ACSA Code — landing page

The product page, served at **https://acsacode.download**.

It is a **separate package on purpose**. The app's build, its lockfile and its release
pipeline must not be able to break because a marketing page changed, and the other way
round. Nothing here imports from `src/`, and nothing at the repository root imports from
here.

## Run it

```bash
cd site
npm ci
npm run dev            # hot reload
npm run build          # typecheck, then a static build into site/dist
npm run preview        # serve the build
npm run check          # drive the built page in headless Chrome
npm run make:og        # re-render public/og.png from og.html
npm run deploy         # build, then `wrangler deploy` to Cloudflare
```

`npm run check` binds a local port and launches Chrome, so it needs the same permissions
the app's `gui:check` does. It asserts what a marketing page fails at quietly: nothing
escaping the viewport and no page-level horizontal scroll at 1440/1024/390, no console
errors, one `h1`, an `alt` on every image, an `href` on every link, no skipped heading
level, and that the reveals, the typed terminal and the code-map canvas actually ran.

## Deploy it

`wrangler.jsonc` is what tells Cloudflare this is a static-assets deploy — there is no
Worker script, and none is needed. Confirm the config without publishing:

```bash
npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry
# expect: "Read N files from the assets directory …/site/dist"
```

### Cloudflare Workers (what this project is)

Dashboard → the Worker → **Settings**:

| Setting | Value |
| --- | --- |
| Root directory | `site` |
| Worker name | must match the `name` in `wrangler.jsonc` (`acsa-code`) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` (needs the `previews` block below) |
| Non-production deploy command | `npx wrangler versions upload` (the alternative, if you would rather not use Previews) |
| Environment variable | `NODE_VERSION=22` |

**Root directory must be `site`.** Pointed at the repository root, the build would install
the *app's* dependencies and build the *app*.

### Production deploys with `wrangler deploy`; previews need a `previews` block

Two different commands, and the failure each one has looked like the other.

**Production.** `npx wrangler deploy` is the one that publishes `dist/`, taking
`assets.directory` from `wrangler.jsonc`. `npx wrangler preview` is **not a deploy** —
it is the open-beta *Preview deployments* command, and an install that picked it up from
a setup flow that guessed had every `Workers Builds` check red on every commit and pull
request, since each of those runs the same command.

**Previews.** `npx wrangler preview` on the *dev* worker genuinely does need a
`previews` block, and its absence is a different failure with the same look:

```
✘ [ERROR] Your Wrangler configuration is missing a `previews` block to run this command.
```

`ensurePreviewsConfig` in wrangler returns early when the config has the key, and
otherwise *derives* a Preview configuration from the dashboard's "Preview base config"
or from the production config. With no base config set and nothing in a static-assets
Worker to derive from, the derivation is empty and the command stops — so `main` deploys
and `dev` never does. An empty block is enough, and it is committed:

```
"previews": {},
```

Assets, compatibility settings and placement stay at the top level and are not copied
into it. In both cases the **build** is fine in the log — it is the publish step that
dies, which is what makes it read as a build failure.

### Why `wrangler.jsonc` exists — do not delete it

Without a committed wrangler config, Cloudflare's build runs its "configure project" step
(`create-cloudflare`), which tries to **edit `vite.config.ts`** to inject
`@cloudflare/vite-plugin`. That is what took the first deploy down:

```
✘ Configuring project for Vite
✘ [ERROR] Cannot modify Vite config: could not find a valid plugins array.
```

Note that the **build itself succeeded** — the failure was the host rewriting this
package. With the config committed, the project is already configured and nothing is
rewritten. That matters here beyond convenience: this site is deliberately a package the
host must not mutate.

### Cloudflare Pages (the alternative)

Pages never runs that configure step, so it needs no wrangler config at all. Create a
**Pages** project instead, set **Root directory** `site`, **Build command**
`npm ci && npm run build`, **Build output directory** `dist`, and `NODE_VERSION=22`. Both
paths serve the same `dist/`.

### Custom domain

`acsacode.download` is wired through the dashboard (Domains → Add). `index.html` carries
the matching `<link rel="canonical">` and an absolute `og:image`, and `robots.txt` points
at `sitemap.xml` — each hard-codes the domain, so change all three together if it moves.

## Keeping it separate

- **It never writes to the app's `dist/`.** That directory is the app's `frontendDist`; a
  landing page there would ship as the app's UI.
- **It is not in `scripts/`.** `bundle.resources` ships the whole `scripts/` directory
  inside the app.
- **The app's CI ignores it, and this CI ignores the app** — see `paths-ignore` in
  `.github/workflows/ci.yml` and the trigger in `site.yml`.
- **No npm workspaces.** A shared lockfile is exactly the coupling this avoids.
- **The host does not rewrite it.** See the `wrangler.jsonc` note above.

## Assets

`public/apex-mark.svg`, `public/apex-icon.svg` and `public/logos/*` are **copies** of the
app's brand marks and provider logos, taken from `docs/brand/` and `public/logos/` at the
repository root.

The copies are not byte-identical: the app draws its logos on dark panels, so
`openai.svg`, `xai.svg` and `ollama.svg` are white or near-white there and would be
invisible on this page's light background. They are recoloured to ink here. If the
upstream marks change, copy them again and re-check those three.

`public/og.png` is generated (`npm run make:og`) and committed, because a social card has
to be a raster file and the deploy should not depend on Chrome being present.

`public/404.html` is self-contained — inline styles and absolute paths only — because it
is served for a path that does not exist, where nothing relative can be relied on.
