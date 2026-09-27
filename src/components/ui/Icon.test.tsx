// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Activity } from "lucide-react";
import { Icon, resolveIconSize, DEFAULT_ICON_SIZE } from "./Icon";

/**
 * The bug these lock down: `Icon` used to write its resolved size as an inline
 * `width`/`height` on every render, and an inline style beats a class. So a
 * caller's `className="h-3.5 w-3.5"` was silently a 16px icon, and changing the
 * component changed every icon in the app at once. jsdom does not run Tailwind,
 * so what is asserted here is the *mechanism* — whether an inline size is
 * present for CSS to lose to — not a computed pixel value.
 */
const svgOf = (container: HTMLElement) => container.querySelector("svg") as SVGSVGElement;

describe("Icon sizing", () => {
  it("leaves the size to CSS when no size prop is given, so a class can win", () => {
    const { container } = render(<Icon icon={Activity} className="h-3.5 w-3.5" />);
    const svg = svgOf(container);
    expect(svg.style.width).toBe("");
    expect(svg.style.height).toBe("");
    expect(svg.style.minWidth).toBe("");
    expect(svg.style.minHeight).toBe("");
    // The fallback is still there — as a presentational attribute, which a class
    // may override but which keeps an unsized icon from filling its box.
    expect(svg.getAttribute("width")).toBe(String(DEFAULT_ICON_SIZE));
  });

  it("writes an explicit size inline, so it wins over any class", () => {
    const { container } = render(<Icon icon={Activity} size={32} className="h-3.5 w-3.5" />);
    const svg = svgOf(container);
    expect(svg.style.width).toBe("32px");
    expect(svg.style.height).toBe("32px");
    expect(svg.style.minWidth).toBe("32px");
    expect(svg.style.minHeight).toBe("32px");
  });

  it("resolves the shared tokens", () => {
    const { container } = render(<Icon icon={Activity} size="xl" />);
    expect(svgOf(container).style.width).toBe("24px");
  });

  it("passes a relative CSS length through untouched", () => {
    const { container } = render(<Icon icon={Activity} size="1.5rem" />);
    expect(svgOf(container).style.width).toBe("1.5rem");
  });

  it("resolves a token, a length, or the default, and nothing else", () => {
    expect(resolveIconSize(undefined)).toBe(DEFAULT_ICON_SIZE);
    expect(resolveIconSize("lg")).toBe(20);
    expect(resolveIconSize(28)).toBe(28);
    expect(resolveIconSize("42px")).toBe("42px");
  });
});
