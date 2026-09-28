import "./styles.css";

/**
 * Everything interactive on the page, in one module and with no library.
 *
 * The page is readable and complete without this file — the copy is in the HTML.
 * This adds the two things the markup cannot do on its own: the reveal-on-scroll
 * stagger, and the reading-progress hairline under the nav.
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

/* ── Go ──────────────────────────────────────────────────────────────────── */
const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());

reveal();
progressBar();
