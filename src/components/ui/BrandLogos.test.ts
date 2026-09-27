import { describe, expect, it } from "vitest";
import { AI_BRAND_REGISTRY, BRAND_LOGO_URLS, resolveBrandId } from "./BrandLogos";
import { INITIAL_PROVIDERS } from "../../services/aiModelManager";

/**
 * Every provider the app offers must resolve to a brand of its own.
 *
 * A provider the brand table does not know is not merely drawn with the wrong
 * mark: `resolveBrandId` falls back to the local "Deterministic AST" entry, so
 * NVIDIA NIM was drawn with that glyph *and announced as "Deterministic AST"* to
 * the accessibility tree — which is how this was spotted, on the chat message row
 * and the model picker. Adding a provider means adding its brand.
 */
describe("every provider has a brand of its own", () => {
  const ids = Object.keys(INITIAL_PROVIDERS).filter((id) => id !== "deterministic");

  it("has something to check", () => {
    expect(ids.length).toBeGreaterThan(5);
  });

  it("resolves each one to itself rather than to the fallback", () => {
    for (const id of ids) {
      expect(resolveBrandId(id), `${id} resolved somewhere else`).toBe(id);
    }
  });

  it("gives each one a logo to draw", () => {
    for (const id of ids) {
      expect(BRAND_LOGO_URLS[id], `${id} has no logo url`).toBeTruthy();
    }
  });

  it("names NVIDIA NIM instead of borrowing another product's name", () => {
    expect(resolveBrandId("nvidia")).toBe("nvidia");
    expect(AI_BRAND_REGISTRY.nvidia.name).toBe("NVIDIA NIM");
    expect(BRAND_LOGO_URLS.nvidia).toBe("/logos/nvidia.svg");
  });
});
