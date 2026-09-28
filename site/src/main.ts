import "./styles.css";

/**
 * Everything interactive on the page, in one module and with no library.
 *
 * The page is readable and complete without this file — the copy is in the HTML.
 * This adds the motion: reveals, the two terminals that type themselves, the code
 * map that draws, the sticky index, the counters and the pointer tilt.
 *
 * `prefers-reduced-motion` is honoured throughout: when it is set, each of these
 * renders its finished state immediately rather than animating.
 */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Reveal on scroll ────────────────────────────────────────────────────── */
function reveal(): void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (reduceMotion || !("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-in"));
    return;
  }
  const seen = new Map<Element, number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        // Stagger siblings so a group arrives as a sequence rather than a slab.
        const parent = el.parentElement ?? document.body;
        const index = seen.get(parent) ?? 0;
        seen.set(parent, index + 1);
        el.style.transitionDelay = `${Math.min(index * 80, 320)}ms`;
        el.classList.add("is-in");
        observer.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
  );
  targets.forEach((el) => observer.observe(el));
}

/* ── A terminal that types itself ────────────────────────────────────────── */
interface Segment {
  text: string;
  cls?: string;
  /** A real link. Only for addresses that mean something to the visitor. */
  href?: string;
  /**
   * Styled like a link but not one. The hero terminal is a drawing of the app's
   * terminal — the address in it is the developer's own machine, so a real `href`
   * would send a visitor to `localhost`, or to whatever they happen to have running
   * there.
   */
  link?: boolean;
}

function typeInto(node: HTMLElement, script: Segment[], speed = 16): void {
  const render = (segment: Segment, partial?: string): HTMLElement => {
    const text = partial ?? segment.text;
    const el = segment.href
      ? Object.assign(document.createElement("a"), {
          href: segment.href,
          target: "_blank",
          rel: "noreferrer",
          textContent: text,
        })
      : Object.assign(document.createElement("span"), { textContent: text });
    const classes = [segment.href || segment.link ? "t-link" : "", segment.cls ?? ""].filter(Boolean);
    if (classes.length) el.className = classes.join(" ");
    node.append(el);
    return el;
  };

  if (reduceMotion) {
    node.textContent = "";
    script.forEach((segment) => render(segment));
    return;
  }

  const caret = document.createElement("span");
  caret.className = "caret";
  let index = 0;

  const step = (): void => {
    if (index >= script.length) {
      caret.remove();
      return;
    }
    const segment = script[index];
    if (!segment.text) {
      index += 1;
      window.setTimeout(step, speed);
      return;
    }
    const el = render(segment, "");
    let at = 0;
    const tick = (): void => {
      at += 1;
      el.textContent = segment.text.slice(0, at);
      if (at < segment.text.length) {
        node.append(caret); // keep the caret after the growing text
        window.setTimeout(tick, speed + (Math.random() * 14 - 4));
        return;
      }
      index += 1;
      window.setTimeout(step, segment.text.endsWith("\n") ? speed * 6 : speed);
    };
    tick();
  };
  step();
}

const HERO_TERMINAL: Segment[] = [
  { text: "$ ", cls: "t-dim" },
  { text: "npm run dev\n" },
  { text: "\n  VITE v6.1.0  ready in ", cls: "t-dim" },
  { text: "312", cls: "t-ok" },
  { text: " ms\n\n", cls: "t-dim" },
  { text: "  ➜  Local:   ", cls: "t-dim" },
  { text: "http://localhost:5173/", link: true },
  { text: "\n  ➜  Network: use --host to expose\n", cls: "t-dim" },
];

const TERMINAL_TWO: Segment[] = [
  { text: "$ ", cls: "t-dim" },
  { text: "npm test\n\n" },
  { text: " ✓ tests/pinned.test.ts (4)\n ✓ tests/store.test.ts (6)\n\n", cls: "t-ok" },
  { text: " Test Files  2 passed (2)\n      Tests  10 passed (10)\n\n" },
  { text: "$ ", cls: "t-dim" },
  { text: "npx vite build --report\n" },
  { text: "  → build guide: ", cls: "t-dim" },
  { text: "https://vite.dev/guide/build", href: "https://vite.dev/guide/build" },
  { text: "\n", cls: "t-dim" },
];

/* ── The code map, drawn ─────────────────────────────────────────────────── */
interface Node {
  x: number;
  y: number;
  label: string;
  r: number;
  phase: number;
  lead?: boolean;
}

function drawMap(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // A deterministic layout: a graph that reads like a small project rather than a
  // random scatter, so the picture says "dependencies" at a glance.
  const layout: Array<[number, number, string, boolean]> = [
    [0.14, 0.24, "App.tsx", true],
    [0.34, 0.14, "store.ts", false],
    [0.5, 0.3, "notes.ts", false],
    [0.68, 0.18, "api.ts", false],
    [0.86, 0.3, "types.ts", false],
    [0.2, 0.56, "parser.ts", false],
    [0.42, 0.62, "editor.tsx", false],
    [0.62, 0.52, "theme.ts", false],
    [0.82, 0.66, "router.ts", false],
    [0.3, 0.84, "tests/", false],
    [0.54, 0.88, "fixtures.json", false],
    [0.74, 0.86, "vite.config.ts", false],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [0, 2], [0, 5], [1, 3], [1, 2], [2, 6], [2, 3], [3, 8],
    [4, 3], [5, 6], [6, 7], [7, 8], [5, 9], [6, 10], [10, 11], [8, 11], [6, 11],
  ];

  let nodes: Node[] = [];
  let scale = 1;

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(rect.width, 320);
    const height = Math.round(width * 0.38);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = width / 900;
    nodes = layout.map(([x, y, label, lead]) => ({
      x: x * width,
      y: y * height,
      label,
      r: lead ? 8.5 : 6,
      phase: (x + y) * 6,
      lead,
    }));
  };

  const paint = (time: number): void => {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = canvas.height / (Math.min(window.devicePixelRatio || 1, 2) || 1);
    ctx.clearRect(0, 0, width, height);

    const drift = (node: Node, axis: 0 | 1): number =>
      reduceMotion ? 0 : Math.sin(time / 2200 + node.phase + axis) * 5;

    // Edges first, so nodes sit on top.
    ctx.lineWidth = 1.2;
    edges.forEach(([from, to], i) => {
      const a = nodes[from];
      const b = nodes[to];
      ctx.strokeStyle = "rgba(11,11,13,0.13)";
      ctx.beginPath();
      ctx.moveTo(a.x + drift(a, 0), a.y + drift(a, 1));
      ctx.lineTo(b.x + drift(b, 0), b.y + drift(b, 1));
      ctx.stroke();

      // A packet that travels the edge, so the graph reads as live dependencies.
      if (!reduceMotion && i % 3 === 0) {
        const t = ((time / 3400) + i * 0.37) % 1;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        ctx.fillStyle = "rgba(99,102,241,0.85)";
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    nodes.forEach((node) => {
      const x = node.x + drift(node, 0);
      const y = node.y + drift(node, 1);
      ctx.beginPath();
      ctx.arc(x, y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = node.lead ? "#6366f1" : "#ffffff";
      ctx.fill();
      ctx.lineWidth = node.lead ? 2.5 : 1.6;
      ctx.strokeStyle = node.lead ? "#ffffff" : "rgba(11,11,13,0.28)";
      ctx.stroke();

      ctx.font = `${Math.max(12, Math.round(12 * scale))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = node.lead ? "#0b0b0d" : "rgba(107,114,128,1)";
      ctx.textAlign = "center";
      ctx.fillText(node.label, x, y - node.r - 7);
    });
  };

  resize();
  window.addEventListener("resize", resize);
  if (reduceMotion) {
    paint(0);
    return;
  }
  const loop = (now: number): void => {
    paint(now);
    window.requestAnimationFrame(loop);
  };
  window.requestAnimationFrame(loop);
}

/* ── The sticky index follows the section in view ────────────────────────── */
function scrollspy(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".toc__item"));
  const sections = links
    .map((link) => document.querySelector<HTMLElement>(link.getAttribute("href") ?? ""))
    .filter((el): el is HTMLElement => Boolean(el));
  if (!sections.length || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach((link) =>
        link.classList.toggle("is-on", link.getAttribute("href") === `#${visible.target.id}`)
      );
    },
    { rootMargin: "-30% 0px -55% 0px", threshold: [0.05, 0.25, 0.5] }
  );
  sections.forEach((section) => observer.observe(section));
}

/* ── Reading progress, and the tilt that follows the pointer ─────────────── */
function progressBar(): void {
  const bar = document.getElementById("navProgress");
  if (!bar) return;
  const update = (): void => {
    const span = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = span > 0 ? Math.min(window.scrollY / span, 1) : 0;
    bar.style.width = `${(ratio * 100).toFixed(2)}%`;
  };
  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

function tilt(): void {
  if (reduceMotion) return;
  const card = document.querySelector<HTMLElement>(".hero__art .win");
  const zone = document.querySelector<HTMLElement>(".hero__art");
  if (!card || !zone) return;
  zone.addEventListener("pointermove", (event) => {
    const rect = zone.getBoundingClientRect();
    const dx = (event.clientX - rect.left) / rect.width - 0.5;
    const dy = (event.clientY - rect.top) / rect.height - 0.5;
    card.style.setProperty("--tx", `${(dx * 6).toFixed(2)}deg`);
    card.style.setProperty("--ty", `${(-dy * 5).toFixed(2)}deg`);
  });
  zone.addEventListener("pointerleave", () => {
    card.style.setProperty("--tx", "0deg");
    card.style.setProperty("--ty", "0deg");
  });
}

function counters(): void {
  const numbers = Array.from(document.querySelectorAll<HTMLElement>("[data-count]"));
  if (!numbers.length) return;
  if (reduceMotion || !("IntersectionObserver" in window)) return;

  const run = (el: HTMLElement): void => {
    const target = Number(el.dataset.count ?? "0");
    const from = Math.max(0, target - Math.min(target, 11));
    const started = performance.now();
    const tick = (now: number): void => {
      const t = Math.min((now - started) / 900, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(from + (target - from) * eased));
      if (t < 1) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        run(entry.target as HTMLElement);
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.6 }
  );
  numbers.forEach((el) => observer.observe(el));
}

/* ── Go ──────────────────────────────────────────────────────────────────── */
const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());

reveal();
progressBar();
tilt();
counters();
scrollspy();

const heroTerm = document.getElementById("heroTerm");
if (heroTerm) typeInto(heroTerm, HERO_TERMINAL);
const term2 = document.getElementById("term2");
if (term2) typeInto(term2, TERMINAL_TWO);

const mapCanvas = document.getElementById("mapCanvas");
if (mapCanvas instanceof HTMLCanvasElement) drawMap(mapCanvas);
