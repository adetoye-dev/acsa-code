/**
 * Reading a project's tsconfig.json.
 *
 * This is the half that decides whether `@/components/Button` resolves: the alias
 * lives in `paths`, and `paths` only means anything if the project's own file is
 * read, cleaned and translated into the numbers Monaco's worker reads.
 */
import { describe, expect, it } from "vitest";
import {
  extendsPath,
  parseTsconfig,
  stripJsonComments,
  toMonacoCompilerOptions,
} from "./projectTsconfig";

describe("cleaning a tsconfig", () => {
  it("removes comments and trailing commas", () => {
    const text = `{
      // the base this extends
      "compilerOptions": {
        /* block comment */
        "strict": true,
      },
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ compilerOptions: { strict: true } });
  });

  it("does not eat a URL that contains a double slash", () => {
    // A regex that strips `//...` turns this into invalid JSON, and then the whole
    // config silently stops applying.
    const text = `{ "compilerOptions": { "baseUrl": "https://example.com/a" } }`;
    expect(JSON.parse(stripJsonComments(text)).compilerOptions.baseUrl).toBe("https://example.com/a");
  });

  it("keeps a double slash inside a string on a line that also has a comment", () => {
    const text = `{ "a": "http://x", // note
      "b": 1 }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: "http://x", b: 1 });
  });
});

describe("translating compiler options", () => {
  it("maps names to the numbers the worker reads", () => {
    const options = toMonacoCompilerOptions({
      target: "es2020",
      module: "nodenext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
    });
    expect(options).toMatchObject({ target: 7, module: 199, moduleResolution: 100, jsx: 4 });
  });

  it("accepts the capitalisation people actually write", () => {
    expect(
      toMonacoCompilerOptions({ moduleResolution: "NodeNext", target: "ES2022" }),
    ).toMatchObject({ moduleResolution: 99, target: 9 });
  });

  it("drops a value it does not model, so the default stands", () => {
    // The alternative is passing a number TypeScript reads as something else.
    expect(toMonacoCompilerOptions({ target: "es2099", module: "webpack" })).toEqual({});
  });

  it("spells lib entries the way the worker expects", () => {
    expect(toMonacoCompilerOptions({ lib: ["ES2020", "DOM"] }).lib).toEqual([
      "lib.es2020.d.ts",
      "lib.dom.d.ts",
    ]);
    expect(toMonacoCompilerOptions({ lib: ["lib.es2022.d.ts"] }).lib).toEqual(["lib.es2022.d.ts"]);
  });

  it("carries paths and baseUrl through, because aliases are the point", () => {
    const options = toMonacoCompilerOptions({
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
      types: ["node"],
    });
    expect(options.baseUrl).toBe(".");
    expect(options.paths).toEqual({ "@/*": ["src/*"] });
    expect(options.types).toEqual(["node"]);
  });

  it("ignores a flag that is not a boolean rather than coercing it", () => {
    expect(toMonacoCompilerOptions({ strict: "yes" as unknown as boolean })).toEqual({});
  });
});

describe("extends", () => {
  it("resolves a relative base next to the file that names it", () => {
    expect(extendsPath("", "./tsconfig.base.json")).toBe("./tsconfig.base.json");
    expect(extendsPath("", "./base")).toBe("./base.json");
  });

  it("declines a package name instead of guessing a path", () => {
    expect(extendsPath("", "@tsconfig/node20/tsconfig.json")).toBeNull();
  });
});

describe("parsing", () => {
  it("surfaces extends and defaults missing compilerOptions", () => {
    expect(parseTsconfig(`{ "extends": "./base.json" }`)).toEqual({
      compilerOptions: {},
      extends: "./base.json",
    });
  });

  it("throws on text that is not a tsconfig, so the caller keeps its defaults", () => {
    expect(() => parseTsconfig("not json at all")).toThrow();
  });
});
