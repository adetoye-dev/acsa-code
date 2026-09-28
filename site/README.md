# ACSA Code — landing page

The product page: `https://github.com/adetoye-dev/asca-code/tree/dev/site`.

It is a **separate package on purpose**. The app's build, its lockfile and its
release pipeline must not be able to break because a marketing page changed, and the
other way round. Nothing here imports from `src/`, and nothing at the repository root
imports from here.

## Run it

```bash
cd site
npm ci
npm run dev            # http://localhost:5173-ish, hot reload
npm run build          # typecheck, then a static build into site/dist
npm run preview        # serve the build
npm run check          # drive the built page in headless Chrome (needs --shots for images)
npm run make:og        # re-render public/og.png from og.html
```

`npm run check` binds a local port and launches Chrome, so it needs the same
permissions the app's `gui:check` does. It asserts the things a marketing page fails
at quietly: no element escaping the viewport or the page scrolling sideways at three
widths, no console errors, one `h1`, an `alt` on every image, an `href` on every link,
no skipped heading level, and that the reveals, the typed terminal and the code-map
canvas actually ran.

## Deploy it — Cloudflare Pages

Cloudflare over Vercel for this one: a marketing page is mostly bandwidth, and
Cloudflare's free tier does not meter it, so a launch spike cannot turn into a bill.
The build runs on their infrastructure, which also means it costs no GitHub Actions
minutes.

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick `adetoye-dev/asca-code` and set **Root directory** to `site`.
3. Build command `npm ci && npm run build`; build output directory `dist`.
   (Node 22 — set `NODE_VERSION=22` in the project's environment variables.)
4. Add the custom domain when you have one.

`public/_headers` is read by Pages and sets the security headers plus long-lived
caching for `/assets/*`.

Nothing needs a secret: it is a static build with no runtime.

### When the domain is settled

Two one-line changes, deliberately left out until the domain is real:

- add `<link rel="canonical" href="https://<domain>/">` to `index.html`;
- make `og:image` absolute (`https://<domain>/og.png`) — most social crawlers will not
  resolve a relative one.

## Keeping it separate

- **It never writes to the app's `dist/`.** That directory is the app's
  `frontendDist`; a landing page there would ship as the app's UI.
- **It is not in `scripts/`.** `bundle.resources` ships the whole `scripts/`
  directory inside the app.
- **The app's CI ignores it, and this CI ignores the app** — see `paths-ignore` in
  `.github/workflows/ci.yml` and the trigger in `site.yml`.
- **No npm workspaces.** A shared lockfile is exactly the coupling this avoids.

## Assets

`public/apex-mark.svg`, `public/apex-icon.svg` and `public/logos/*` are **copies** of
the app's brand marks and provider logos, taken from `docs/brand/` and `public/logos/`
at the repository root.

The copies are not byte-identical: the app draws its logos on dark panels, so
`openai.svg`, `xai.svg` and `ollama.svg` are white or near-white there and would be
invisible on this page's light background. They are recoloured to ink here. If the
upstream marks change, copy them again and re-check the three.

`public/og.png` is generated (`npm run make:og`) and committed, because a social card
has to be a raster file and the deploy should not depend on Chrome being present.
