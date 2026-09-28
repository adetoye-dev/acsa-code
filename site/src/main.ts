import "./styles.css";

/**
 * Everything interactive on the page, in one module and with no library.
 *
 * The page is readable and complete without this file — the copy is in the HTML.
 * This adds the motion: the reveal-on-scroll stagger, the sticky feature index and
 * the counters in the hero. The drawn window, its self-typing terminal and the code
 * map that drew itself were replaced by real screenshots, and their code went with
 * them rather than staying in the bundle.
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

/* ── Reading progress ────────────────────────────────────────────────────── */
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
counters();
scrollspy();
