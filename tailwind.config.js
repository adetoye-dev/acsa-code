/** @type {import('tailwindcss').Config} */
/**
 * A design token as a Tailwind colour that honours the `/opacity` modifier.
 *
 * The tokens are hex — `var(--surface-workbench)` is `#0f0f12` — and Tailwind
 * cannot apply an alpha modifier to a `var()`. It does not emit a wrong rule, it
 * emits *no* rule: `bg-workbench/60` was silently dropped, so the element fell
 * back to the browser's white and a text field rendered white-on-white. This
 * keeps each token single-sourced and computes the alpha at use instead.
 */
const token = (variable) => ({ opacityValue }) =>
  opacityValue === undefined || opacityValue === null
    ? `var(${variable})`
    : `color-mix(in srgb, var(${variable}) calc(${opacityValue} * 100%), transparent)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        /**
         * The palette the component tree actually uses, routed through variables.
         *
         * `text-zinc-400` and `border-purple-500/60` are the app's real colours —
         * ~1700 of them — while the semantic tokens above were an aspirational set
         * nothing read (`--text-muted` is `#717188`; the UI renders `#a1a1aa`).
         * Pointing these at variables makes repointing the app a one-file change,
         * and going through `token()` keeps the `/opacity` form working: a bare
         * `var()` makes Tailwind drop the rule silently, which is the bug that
         * helper was written for.
         *
         * The class names stay `zinc`/`purple` deliberately. Renaming ~1700 call
         * sites to semantic roles belongs with a decided palette — the roles a new
         * identity needs are not knowable yet — and the leverage is identical.
         */
        ...(() => {
          const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
          const scale = (prefix) =>
            Object.fromEntries(shades.map((s) => [s, token(`--${prefix}-${s}`)]));
          return { zinc: scale("neutral"), purple: scale("accent") };
        })(),
        background: "#09090b",
        /** @deprecated use the semantic tokens; kept until the surfaces move. */
        surface: "#18181b",
        border: "#27272a",
        canvas: token("--surface-canvas"),
        workbench: token("--surface-workbench"),
        panel: token("--surface-panel"),
        overlay: token("--surface-overlay"),
        modal: token("--surface-modal"),
        elevated: token("--surface-elevated"),
        "surface-subtle": token("--surface-subtle"),
        "surface-hover": token("--surface-hover"),
        "surface-active": token("--surface-active"),
        "surface-selected": token("--surface-selected"),
        "border-hairline": token("--border-hairline"),
        "border-accent": token("--border-accent"),
        "border-focus": token("--border-focus"),
        // `bg-hairline/80` (a 1px divider) and `bg-primary-action/90` (a pressed
        // button) were both dead: `hairline` existed only as a borderColor and
        // `primary-action` only as a backgroundColor, where the `/alpha` form is
        // not resolved.
        hairline: token("--border-hairline"),
        "primary-action": token("--action-primary"),
      },
      borderColor: {
        hairline: token("--border-hairline"),
        subtle: token("--border-subtle"),
        strong: token("--border-strong"),
        accent: token("--border-accent"),
        focus: token("--border-focus"),
      },
      textColor: {
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        muted: "var(--text-muted)",
        accent: "var(--text-accent)",
        "primary-icon": "var(--text-primary-icon)",
      },
      /**
       * The dense type scale this UI actually uses.
       *
       * There were 402 arbitrary font sizes: `text-[11px]` ×186, `text-[10px]` ×149,
       * `text-[13px]` ×37, `text-[9px]` ×28. Tailwind's own scale starts at
       * `text-xs` (12px), so every size below it was written by hand and none of
       * them were related to each other. These are the same pixel values under
       * names — deliberately size-only, with no line-height, because an arbitrary
       * `text-[11px]` sets no line-height either and matching that is what keeps
       * this a rename rather than a restyle.
       *
       * That rename has since been spent. The complaint it produced is the one
       * users actually file: "hard to read, the font is quite tiny". The scale was
       * six 1px steps from 9px to 14px, and the app leans on the bottom of it —
       * 76 uses of `4xs` and 137 of `3xs` were 9px and 10px, across badges, mono
       * metadata and status lines. Nothing is allowed below 11px now, which costs
       * one rung: `4xs` and `3xs` render the same size. They were 1px apart, so
       * the hierarchy between them was never load-bearing, and the range is better
       * spent on being legible than on a distinction nobody could see.
       *
       * `xs` and `sm` are Tailwind's own steps and are restated here so the ladder
       * is one list. Their line-heights are kept explicitly — overriding a size
       * with a bare string drops the line-height the default carried, which would
       * silently retighten every row that uses them.
       */
      fontSize: {
        "4xs": "11px",
        "3xs": "11px",
        "2xs": "12px",
        xs: ["13px", { lineHeight: "1rem" }],
        body: "14px",
        sm: ["15px", { lineHeight: "1.25rem" }],
      },
      /**
       * One ordinal scale for everything that stacks.
       *
       * Every one of these used to be `z-50` — the full-page dashboards, the
       * titlebar dropdowns, the chat menus and every modal — so which element won
       * came down to DOM order. A dropdown in the titlebar lost to a dashboard
       * panel rendered later, and got clipped by it. Named layers answer the
       * question once: a popover is always above an overlay, a modal above both.
       */
      zIndex: {
        raised: "10",   // in-flow but lifted: chat dock, editor toolbar
        editor: "15",   // surfaces *inside* an editor pane: inline prompt, review
                        // note. Deliberately below `overlay`, so a full-page
                        // dashboard covers them instead of having them float on top.
        dock: "20",
        overlay: "30",  // full-page dashboards, covering the editor only
        scrim: "35",    // the click-catcher behind an open popover
        popover: "40",  // dropdowns, menus, context menus
        modal: "50",    // dialogs and their backdrops
        toast: "60",    // transient notices
        critical: "70", // error boundary, setup wizard
      },
      borderRadius: {
        pill: "var(--radius-xl)",
        dropdown: "var(--dropdown-radius-outer)",
        modal: "var(--radius-2xl)",
        card: "var(--radius-lg)",
        panel: "var(--radius-xl)",
      },
      boxShadow: {
        "elevation-1": "var(--shadow-elevation-1)",
        "elevation-2": "var(--shadow-elevation-2)",
        "elevation-3": "var(--shadow-elevation-3)",
      },
      fontFamily: {
        sans: [
          "var(--ide-ui-font)",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "var(--ide-mono-font)",
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
}
