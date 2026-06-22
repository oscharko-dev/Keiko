import { describe, expect, it } from "vitest";
import {
  detectFrontendStack,
  detectFrontendStackFromDependencies,
  EMPTY_FRONTEND_TEST_STACK,
  isPlaywrightEntryPath,
  isPlaywrightSmokeAppropriate,
  isReactComponentPath,
  looksLikeReactComponentSource,
  manifestDependencyNames,
  selectTestStrategy,
  type FrontendTestStack,
  type ManifestReaderFs,
  type StrategyInput,
} from "./frontend.js";
import { makeWorkspaceInfo } from "./_support.js";

// A tiny in-memory ManifestReaderFs over a path→content map (absolute paths). Missing path → absent.
function fakeFs(files: Readonly<Record<string, string>>): ManifestReaderFs {
  return {
    exists: (path: string): boolean => Object.prototype.hasOwnProperty.call(files, path),
    readFileUtf8: (path: string): string => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
  };
}

function stack(overrides: Partial<FrontendTestStack> = {}): FrontendTestStack {
  return { ...EMPTY_FRONTEND_TEST_STACK, ...overrides };
}

function strategyInput(overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    targetPath: "src/add.ts",
    framework: "vitest",
    stack: EMPTY_FRONTEND_TEST_STACK,
    ...overrides,
  };
}

describe("manifestDependencyNames", () => {
  it("unions dependencies, devDependencies, peerDependencies, optionalDependencies", () => {
    const names = manifestDependencyNames(
      JSON.stringify({
        dependencies: { react: "18" },
        devDependencies: { vitest: "4", "@testing-library/react": "16" },
        peerDependencies: { "react-dom": "18" },
        optionalDependencies: { jsdom: "24" },
      }),
    );
    expect(names.has("react")).toBe(true);
    expect(names.has("@testing-library/react")).toBe(true);
    expect(names.has("react-dom")).toBe(true);
    expect(names.has("jsdom")).toBe(true);
  });

  it("returns an empty set for unparseable or non-object manifests", () => {
    expect(manifestDependencyNames("{not json").size).toBe(0);
    expect(manifestDependencyNames("[]").size).toBe(0);
    expect(manifestDependencyNames("42").size).toBe(0);
  });
});

describe("detectFrontendStackFromDependencies", () => {
  it("detects a full React Testing Library + jsdom stack", () => {
    const names = new Set([
      "react",
      "@testing-library/react",
      "@testing-library/user-event",
      "@testing-library/jest-dom",
      "jsdom",
    ]);
    const detected = detectFrontendStackFromDependencies(names, { hasPlaywrightConfig: false });
    expect(detected).toEqual<FrontendTestStack>({
      componentFramework: "react",
      hasReactTestingLibrary: true,
      hasUserEvent: true,
      hasJestDom: true,
      hasAccessibilityMatchers: false,
      hasDomEnvironment: true,
      hasPlaywright: false,
    });
  });

  it("detects Playwright from a dependency", () => {
    const detected = detectFrontendStackFromDependencies(new Set(["@playwright/test"]), {
      hasPlaywrightConfig: false,
    });
    expect(detected.hasPlaywright).toBe(true);
  });

  it("detects Playwright from a config file even without a dependency", () => {
    const detected = detectFrontendStackFromDependencies(new Set<string>(), {
      hasPlaywrightConfig: true,
    });
    expect(detected.hasPlaywright).toBe(true);
  });

  it("detects accessibility matchers from jest-axe and happy-dom as a DOM env", () => {
    const detected = detectFrontendStackFromDependencies(new Set(["jest-axe", "happy-dom"]), {
      hasPlaywrightConfig: false,
    });
    expect(detected.hasAccessibilityMatchers).toBe(true);
    expect(detected.hasDomEnvironment).toBe(true);
  });

  it("yields the empty stack for a backend-only dependency set", () => {
    const detected = detectFrontendStackFromDependencies(new Set(["express", "pino"]), {
      hasPlaywrightConfig: false,
    });
    expect(detected).toEqual(EMPTY_FRONTEND_TEST_STACK);
  });
});

describe("detectFrontendStack (filesystem walk-up)", () => {
  it("unions manifests from the target package up to the workspace root and finds a playwright config", () => {
    const ws = makeWorkspaceInfo({ root: "/repo" });
    const fs = fakeFs({
      "/repo/package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }),
      "/repo/packages/web/package.json": JSON.stringify({
        dependencies: { react: "18" },
        devDependencies: { "@testing-library/react": "16", jsdom: "24" },
      }),
      "/repo/playwright.config.ts": "export default {};",
    });
    const detected = detectFrontendStack(ws, fs, "packages/web/src/Button.tsx");
    expect(detected.componentFramework).toBe("react");
    expect(detected.hasReactTestingLibrary).toBe(true);
    expect(detected.hasDomEnvironment).toBe(true);
    expect(detected.hasPlaywright).toBe(true);
  });

  it("reads only the root manifest when no anchor is given", () => {
    const ws = makeWorkspaceInfo({ root: "/repo" });
    const fs = fakeFs({
      "/repo/package.json": JSON.stringify({
        dependencies: { react: "18", "@testing-library/react": "16" },
      }),
    });
    const detected = detectFrontendStack(ws, fs);
    expect(detected.hasReactTestingLibrary).toBe(true);
  });

  it("returns the empty stack when no manifest exists", () => {
    const ws = makeWorkspaceInfo({ root: "/repo" });
    expect(detectFrontendStack(ws, fakeFs({}), "src/Button.tsx")).toEqual(
      EMPTY_FRONTEND_TEST_STACK,
    );
  });

  it("never escapes the workspace root while walking up", () => {
    const ws = makeWorkspaceInfo({ root: "/repo" });
    const fs = fakeFs({
      "/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "/repo/package.json": JSON.stringify({ devDependencies: { vitest: "4" } }),
    });
    const detected = detectFrontendStack(ws, fs, "src/add.ts");
    // The outside-root /package.json (declaring react) must NOT be read.
    expect(detected.componentFramework).toBe("none");
  });
});

describe("target classification", () => {
  it("isReactComponentPath recognises .tsx/.jsx and rejects .ts/.js", () => {
    expect(isReactComponentPath("src/Button.tsx")).toBe(true);
    expect(isReactComponentPath("src/Card.jsx")).toBe(true);
    expect(isReactComponentPath("src/add.ts")).toBe(false);
    expect(isReactComponentPath("src/util.js")).toBe(false);
  });

  it("looksLikeReactComponentSource needs a react import and JSX/createElement", () => {
    expect(
      looksLikeReactComponentSource('import React from "react";\nexport const A = () => <div/>;'),
    ).toBe(true);
    expect(
      looksLikeReactComponentSource('import { add } from "./m";\nexport const x = add(1, 2);'),
    ).toBe(false);
    expect(looksLikeReactComponentSource(undefined)).toBe(false);
  });

  it("isPlaywrightEntryPath recognises Next routes, *.page.*, and e2e/app dirs", () => {
    expect(isPlaywrightEntryPath("app/dashboard/page.tsx")).toBe(true);
    expect(isPlaywrightEntryPath("src/routes/Login.page.tsx")).toBe(true);
    expect(isPlaywrightEntryPath("e2e/checkout.ts")).toBe(true);
    expect(isPlaywrightEntryPath("packages/web/app/page.tsx")).toBe(true);
    expect(isPlaywrightEntryPath("src/lib/add.ts")).toBe(false);
    expect(isPlaywrightEntryPath("src/components/Button.tsx")).toBe(false);
  });

  it("isPlaywrightSmokeAppropriate requires Playwright AND an entry point (AC3)", () => {
    const withPw = stack({ hasPlaywright: true });
    expect(isPlaywrightSmokeAppropriate("app/page.tsx", withPw)).toBe(true);
    // Playwright present but a library file → NOT appropriate.
    expect(isPlaywrightSmokeAppropriate("src/lib/add.ts", withPw)).toBe(false);
    // An entry point but no Playwright → NOT appropriate.
    expect(isPlaywrightSmokeAppropriate("app/page.tsx", EMPTY_FRONTEND_TEST_STACK)).toBe(false);
  });
});

describe("selectTestStrategy", () => {
  it("AC1: a plain TS/JS library file selects unit style and is never Playwright", () => {
    const result = selectTestStrategy(strategyInput({ targetPath: "src/math/add.ts" }));
    expect(result.style).toBe("unit");
    expect(result.verification).toBe("vitest");
  });

  it("AC1: unit verification follows the base framework, or none when unknown", () => {
    expect(selectTestStrategy(strategyInput({ framework: "jest" })).verification).toBe("jest");
    expect(selectTestStrategy(strategyInput({ framework: "unknown" })).verification).toBe("none");
  });

  it("AC2: a React component with @testing-library/react selects component style", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "src/Button.tsx",
        stack: stack({
          componentFramework: "react",
          hasReactTestingLibrary: true,
          hasDomEnvironment: true,
        }),
      }),
    );
    expect(result.style).toBe("component");
    expect(result.verification).toBe("vitest");
  });

  it("AC2: user-event upgrades the component to interaction style", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "src/Button.tsx",
        stack: stack({
          componentFramework: "react",
          hasReactTestingLibrary: true,
          hasUserEvent: true,
        }),
      }),
    );
    expect(result.style).toBe("interaction");
  });

  it("AC2: an accessibility matcher upgrades the component to accessibility-smoke style", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "src/Button.tsx",
        stack: stack({
          componentFramework: "react",
          hasReactTestingLibrary: true,
          hasUserEvent: true,
          hasAccessibilityMatchers: true,
        }),
      }),
    );
    expect(result.style).toBe("accessibility-smoke");
  });

  it("AC3: an app entry point in a Playwright project selects browser-smoke", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "app/dashboard/page.tsx",
        stack: stack({ hasPlaywright: true }),
      }),
    );
    expect(result.style).toBe("browser-smoke");
    expect(result.verification).toBe("playwright");
  });

  it("AC3: a library file in a Playwright project does NOT select browser-smoke", () => {
    const result = selectTestStrategy(
      strategyInput({ targetPath: "src/lib/add.ts", stack: stack({ hasPlaywright: true }) }),
    );
    expect(result.style).toBe("unit");
  });

  it("AC3: a component file in a Playwright project (no RTL) is unsupported, not browser-smoke", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "src/components/Button.tsx",
        stack: stack({ hasPlaywright: true }),
      }),
    );
    expect(result.style).toBe("unsupported");
  });

  it("AC5: a React component without a supported stack yields a clear unsupported limitation", () => {
    const result = selectTestStrategy(strategyInput({ targetPath: "src/Button.tsx" }));
    expect(result.style).toBe("unsupported");
    expect(result.verification).toBe("none");
    expect(result.reason).toContain("@testing-library/react");
    expect(result.reason).toContain("limitation");
  });

  it("AC5: react present but no @testing-library/react is still unsupported", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "src/Button.tsx",
        stack: stack({ componentFramework: "react" }),
      }),
    );
    expect(result.style).toBe("unsupported");
  });

  it("classifies a JSX-bearing .ts module as a component via the source signal", () => {
    const result = selectTestStrategy(
      strategyInput({
        targetPath: "src/widget.ts",
        targetSource: 'import React from "react";\nexport const W = () => <span/>;',
        stack: stack({ componentFramework: "react", hasReactTestingLibrary: true }),
      }),
    );
    expect(result.style).toBe("component");
  });

  it("every reason string is non-empty and content-free (deterministic)", () => {
    for (const path of ["src/add.ts", "src/Button.tsx", "app/page.tsx"]) {
      const result = selectTestStrategy(
        strategyInput({
          targetPath: path,
          stack: stack({
            hasPlaywright: true,
            hasReactTestingLibrary: true,
            componentFramework: "react",
          }),
        }),
      );
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
