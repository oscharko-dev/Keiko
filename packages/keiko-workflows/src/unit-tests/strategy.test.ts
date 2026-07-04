import { describe, expect, it } from "vitest";
import { resolveTestStrategy, strategyAnchorPath } from "./strategy.js";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { makeEntry, makePack, makeWorkspaceInfo } from "./_support.js";
import type { TestConventions } from "./types.js";

const ROOT = "/repo";

function conventions(framework: TestConventions["framework"] = "vitest"): TestConventions {
  return { framework, testDirs: ["tests"], fileNamingStyle: "mirrored", assertionStyleSamples: [] };
}

describe("strategyAnchorPath", () => {
  it("returns the file path, first changed file, or module dir", () => {
    expect(strategyAnchorPath({ kind: "file", filePath: "src\\Button.tsx" })).toBe(
      "src/Button.tsx",
    );
    expect(strategyAnchorPath({ kind: "changedFiles", filePaths: ["src/a.ts", "src/b.ts"] })).toBe(
      "src/a.ts",
    );
    expect(strategyAnchorPath({ kind: "module", moduleDir: "src/math" })).toBe("src/math");
  });
});

describe("resolveTestStrategy", () => {
  const ws = makeWorkspaceInfo({ root: ROOT });

  it("resolves a unit strategy for a library file with no frontend stack", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({ devDependencies: { vitest: "^4" } }),
    });
    const result = resolveTestStrategy(
      ws,
      { kind: "file", filePath: "src/add.ts" },
      conventions(),
      makePack([]),
      fs,
    );
    expect(result.style).toBe("unit");
    expect(result.verification).toBe("vitest");
  });

  it("resolves an accessibility-smoke strategy for a component with RTL + axe", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({
        dependencies: { react: "18" },
        devDependencies: { vitest: "^4", "@testing-library/react": "16", "jest-axe": "8" },
      }),
    });
    const result = resolveTestStrategy(
      ws,
      { kind: "file", filePath: "src/Button.tsx" },
      conventions(),
      makePack([]),
      fs,
    );
    expect(result.style).toBe("accessibility-smoke");
  });

  it("classifies a JSX-bearing .ts module as a component using the pack excerpt", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({
        dependencies: { react: "18" },
        devDependencies: { vitest: "^4", "@testing-library/react": "16" },
      }),
    });
    const pack = makePack([
      makeEntry({
        path: "src/widget.ts",
        excerpt: 'import React from "react";\nexport const W = () => <i/>;',
      }),
    ]);
    const result = resolveTestStrategy(
      ws,
      { kind: "file", filePath: "src/widget.ts" },
      conventions(),
      pack,
      fs,
    );
    expect(result.style).toBe("component");
  });

  it("resolves an unsupported strategy for a component without a supported stack (AC5)", () => {
    const fs = memFs(ROOT, {
      "package.json": JSON.stringify({ devDependencies: { vitest: "^4" } }),
    });
    const result = resolveTestStrategy(
      ws,
      { kind: "file", filePath: "src/Button.tsx" },
      conventions(),
      makePack([]),
      fs,
    );
    expect(result.style).toBe("unsupported");
    expect(result.verification).toBe("none");
  });
});
